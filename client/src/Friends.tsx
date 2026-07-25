import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { API_BASE, socket } from "./socket";
import { useAuth } from "./auth";

export type Friend = {
  id: string;
  name: string;
  avatarUrl: string | null;
  status: "accepted" | "incoming" | "outgoing";
  roomId: string | null;
};

const post = async (path: string, body: unknown) => {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error ?? "that didn't work");
  return data;
};

// Shared by the landing page and the room, which need the same list but act on
// it differently — one navigates to a friend, the other invites them here.
export function useFriends() {
  const { user } = useAuth();
  const [friends, setFriends] = useState<Friend[]>([]);

  const refresh = useCallback(async () => {
    if (!user) return setFriends([]);
    try {
      const res = await fetch(`${API_BASE}/api/friends`, { credentials: "include" });
      if (!res.ok) return;
      const data = await res.json();
      setFriends(data.friends ?? []);
    } catch {
      // Keep whatever was on screen; the next event or reconnect will correct it.
    }
  }, [user]);

  useEffect(() => {
    void refresh();
    // The server pings when anything in this list changes — someone joining a
    // room, a request arriving — so there's no polling.
    socket.on("friends:changed", refresh);
    socket.on("connect", refresh);
    return () => {
      socket.off("friends:changed", refresh);
      socket.off("connect", refresh);
    };
  }, [refresh]);

  return { friends, refresh };
}

export function FriendsPanel({
  mode,
  roomId,
}: {
  mode: "landing" | "room";
  /** The room this panel is being shown inside, so friends already here can be
      recognised rather than invited to where they're standing. */
  roomId?: string;
}) {
  const { user } = useAuth();
  const { friends, refresh } = useFriends();
  const navigate = useNavigate();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  if (!user) return null;

  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    setError(null);
    setNote(null);
    try {
      await fn();
      if (ok) setNote(ok);
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const add = () => {
    const trimmed = code.trim();
    if (!trimmed) return;
    void act(async () => {
      await post("/api/friends/request", { code: trimmed });
      setCode("");
    }, "Request sent.");
  };

  const copyCode = () => {
    void navigator.clipboard.writeText(user.friendCode).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };

  const accepted = friends.filter((f) => f.status === "accepted");
  const incoming = friends.filter((f) => f.status === "incoming");
  const outgoing = friends.filter((f) => f.status === "outgoing");

  return (
    <div className="friends">
      <h2>Friends</h2>

      <p className="friends-code">
        Your code: <code>{user.friendCode}</code>{" "}
        <button className="link-button" onClick={copyCode}>
          {copied ? "copied" : "copy"}
        </button>
      </p>

      <div className="load-bar">
        <input
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          placeholder="Add by friend code"
          onKeyDown={(e) => e.key === "Enter" && add()}
        />
        <button onClick={add}>Add</button>
      </div>
      {error && <p className="load-error">{error}</p>}
      {note && <p className="friends-note">{note}</p>}

      {incoming.length > 0 && (
        <>
          <h3>Wants to be friends</h3>
          <ul className="friends-list">
            {incoming.map((friend) => (
              <li key={friend.id}>
                <span className="friend-name">{friend.name}</span>
                <span className="friend-actions">
                  <button
                    onClick={() => void act(() => post("/api/friends/accept", { userId: friend.id }))}
                  >
                    Accept
                  </button>
                  <button
                    className="link-button"
                    onClick={() => void act(() => post("/api/friends/remove", { userId: friend.id }))}
                  >
                    ignore
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}

      <ul className="friends-list">
        {accepted.map((friend) => (
          <li key={friend.id}>
            <span className="friend-name">
              {friend.name}
              {friend.roomId && friend.roomId !== roomId && (
                <span className="friend-where">in a room</span>
              )}
            </span>
            <span className="friend-actions">
              {/* In a room: offer to pull them here. On the landing page:
                  offer to go where they are. Only one of the two ever makes
                  sense at a time. */}
              {mode === "room" ? (
                friend.roomId === roomId ? (
                  <span className="friend-here">here</span>
                ) : (
                  <button
                    onClick={() => {
                      socket.emit("friend:invite", { toUserId: friend.id });
                      setNote(`Invited ${friend.name}.`);
                    }}
                  >
                    Invite
                  </button>
                )
              ) : (
                friend.roomId && <button onClick={() => navigate(`/room/${friend.roomId}`)}>Join</button>
              )}
              <button
                className="link-button"
                title={`Remove ${friend.name}`}
                onClick={() => void act(() => post("/api/friends/remove", { userId: friend.id }))}
              >
                remove
              </button>
            </span>
          </li>
        ))}
      </ul>

      {accepted.length === 0 && incoming.length === 0 && (
        <p className="friends-empty">
          No friends yet — swap codes with someone and they'll show up here when they're watching
          something.
        </p>
      )}

      {outgoing.length > 0 && (
        <p className="friends-note">
          Waiting on {outgoing.map((f) => f.name).join(", ")}.
        </p>
      )}
    </div>
  );
}

// A friend pulling you into their room. Deliberately a prompt and not a
// redirect: being yanked out of what you're watching because someone clicked
// a button would be worse than missing the invite.
export function InviteToast() {
  const [invite, setInvite] = useState<{ from: string; roomId: string } | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    const onInvited = (payload: { from: string; roomId: string }) => setInvite(payload);
    socket.on("friend:invited", onInvited);
    return () => {
      socket.off("friend:invited", onInvited);
    };
  }, []);

  if (!invite) return null;
  return (
    <div className="invite-toast">
      <span>
        <strong>{invite.from}</strong> invited you to a sesh.
      </span>
      <button
        onClick={() => {
          navigate(`/room/${invite.roomId}`);
          setInvite(null);
        }}
      >
        Join
      </button>
      <button className="link-button" onClick={() => setInvite(null)}>
        dismiss
      </button>
    </div>
  );
}
