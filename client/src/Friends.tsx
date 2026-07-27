import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { API_BASE, socket } from "./socket";
import { useAuth } from "./auth";
import { playDmPing } from "./sounds";

export type Friend = {
  id: string;
  name: string;
  avatarUrl: string | null;
  status: "accepted" | "incoming" | "outgoing";
  /** Sesh is open somewhere — a tab or a terminal — but not in a room. */
  online: boolean;
  roomId: string | null;
  unread: number;
  lastMessage: { text: string; at: number; mine: boolean } | null;
};

export type DirectMessage = {
  id: string;
  from: string;
  to: string;
  text: string;
  at: number;
  read: boolean;
};

// Same window room chat uses, for the same reason: a run of messages from one
// person, close together, is one thing being said and reads as one block.
const DM_GROUP_WINDOW_MS = 5 * 60_000;

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

// Three states, not two: where someone is (a room), that they're reachable at
// all (online), or nothing. The middle one is most of the point of a friends
// list — it's the difference between "message them" and "don't bother".
type Presence = "in-room" | "online" | "offline";

const presenceOf = (friend: Friend): Presence =>
  friend.roomId ? "in-room" : friend.online ? "online" : "offline";

const PRESENCE_ORDER: Record<Presence, number> = { "in-room": 0, online: 1, offline: 2 };

export const totalUnread = (friends: Friend[]) =>
  friends.reduce((sum, friend) => sum + (friend.status === "accepted" ? friend.unread : 0), 0);

// Which conversation is on screen. Module scope because the arriving-message
// sound is raised by the socket listener in useFriends, which lives elsewhere
// in the tree from the conversation view and only needs this one fact about it.
let openConversation: string | null = null;

// useFriends is mounted more than once on a page — the toolbar badge and the
// open panel each call it — and every copy hears the same socket event. Keying
// the ping to the message rather than the listener stops it doubling up.
let lastPingedMessageId: string | null = null;

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
    // room, a request arriving, a message raising an unread count — so there's
    // no polling.
    socket.on("friends:changed", refresh);
    socket.on("connect", refresh);
    return () => {
      socket.off("friends:changed", refresh);
      socket.off("connect", refresh);
    };
  }, [refresh]);

  // A message for a conversation you're already reading needs no announcing —
  // it's already on screen. Anything else is the only sign you'd get that
  // somebody is talking to you, since the popover is usually closed.
  useEffect(() => {
    if (!user) return;
    const onDirect = (message: DirectMessage) => {
      if (message.from === user.id || message.from === openConversation) return;
      if (message.id === lastPingedMessageId) return;
      lastPingedMessageId = message.id;
      playDmPing();
    };
    socket.on("dm:message", onDirect);
    return () => {
      socket.off("dm:message", onDirect);
    };
  }, [user]);

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
  const [talkingTo, setTalkingTo] = useState<string | null>(null);

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

  const accepted = friends
    .filter((f) => f.status === "accepted")
    // Whoever you could do something with, first. Alphabetical inside each
    // group so a friend doesn't move around as their unread count changes.
    .sort(
      (a, b) =>
        PRESENCE_ORDER[presenceOf(a)] - PRESENCE_ORDER[presenceOf(b)] ||
        a.name.localeCompare(b.name),
    );
  const incoming = friends.filter((f) => f.status === "incoming");
  const outgoing = friends.filter((f) => f.status === "outgoing");

  // Only settled friends can be messaged, so a conversation that's open when
  // the friendship ends closes itself rather than talking into a 403.
  const open = accepted.find((f) => f.id === talkingTo);
  if (talkingTo && open) {
    return <Conversation friend={open} onBack={() => setTalkingTo(null)} />;
  }

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
        {accepted.map((friend) => {
          const presence = presenceOf(friend);
          const here = mode === "room" && friend.roomId === roomId;
          return (
            <li key={friend.id} className={`friend-row ${presence}`}>
              {/* The whole name is the way into a conversation: a separate
                  "message" button on every row would triple the width of a
                  list whose rows are mostly a name. */}
              <button
                className="friend-open"
                title={`Message ${friend.name}`}
                onClick={() => setTalkingTo(friend.id)}
              >
                <span className={`friend-status ${presence}`} aria-hidden="true" />
                <span className="friend-name">{friend.name}</span>
                {!here && (
                  <span className="friend-where">
                    {presence === "in-room" ? "in a room" : presence}
                  </span>
                )}
                {friend.unread > 0 && <span className="friend-unread">{friend.unread}</span>}
              </button>
              <span className="friend-actions">
                {/* In a room: offer to pull them here. On the landing page:
                    offer to go where they are. Only one of the two ever makes
                    sense at a time — and neither makes sense for someone
                    who isn't there to receive it. */}
                {mode === "room" ? (
                  here ? (
                    <span className="friend-here">here</span>
                  ) : (
                    friend.online && (
                      <button
                        onClick={() => {
                          socket.emit("friend:invite", { toUserId: friend.id });
                          setNote(`Invited ${friend.name}.`);
                        }}
                      >
                        Invite
                      </button>
                    )
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
          );
        })}
      </ul>

      {accepted.length === 0 && incoming.length === 0 && (
        <p className="friends-empty">
          No friends yet — swap codes with someone and they'll show up here whenever they're
          around, watching something or not.
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

// One conversation, in the same panel the list was in. Deliberately not a
// second popover or a window of its own: the friends list is already a small
// surface in a corner, and messaging someone is what you opened it for.
function Conversation({ friend, onBack }: { friend: Friend; onBack: () => void }) {
  const { user } = useAuth();
  const [messages, setMessages] = useState<DirectMessage[]>([]);
  const [retentionDays, setRetentionDays] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [typingUntil, setTypingUntil] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);
  const lastTypingSentRef = useRef(0);

  useEffect(() => {
    openConversation = friend.id;
    return () => {
      openConversation = null;
    };
  }, [friend.id]);

  // Fetching the history is also what marks it read — the server treats
  // opening a conversation as reading it, so there's no separate call here.
  useEffect(() => {
    let cancelled = false;
    setMessages([]);
    setError(null);
    fetch(`${API_BASE}/api/dm/${friend.id}`, { credentials: "include" })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) throw new Error(data?.error ?? "couldn't load that conversation");
        setMessages(data.messages ?? []);
        setRetentionDays(data.retentionDays ?? null);
      })
      .catch((err) => !cancelled && setError((err as Error).message));
    return () => {
      cancelled = true;
    };
  }, [friend.id]);

  // Only the server's copy is ever rendered, including your own messages: one
  // code path builds a message, so nothing can be on screen that isn't stored.
  useEffect(() => {
    const onMessage = (message: DirectMessage) => {
      if (message.from !== friend.id && message.to !== friend.id) return;
      setMessages((prev) =>
        prev.some((m) => m.id === message.id) ? prev : [...prev, message],
      );
      // Reading it as it lands, so the badge never counts something you're
      // looking at.
      if (message.from === friend.id) socket.emit("dm:read", { withUserId: friend.id });
    };
    const onTyping = ({ from }: { from: string }) => {
      if (from === friend.id) setTypingUntil(Date.now() + 3000);
    };
    socket.on("dm:message", onMessage);
    socket.on("dm:typing", onTyping);
    // Expiring the dots on a timer means a sender who stops typing simply
    // stops pinging — there's no "stopped" event to miss.
    const prune = window.setInterval(
      () => setTypingUntil((until) => (until && until <= Date.now() ? 0 : until)),
      1000,
    );
    return () => {
      socket.off("dm:message", onMessage);
      socket.off("dm:typing", onTyping);
      window.clearInterval(prune);
    };
  }, [friend.id]);

  // Keep the newest message in view.
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const send = () => {
    const text = draft.trim();
    if (!text) return;
    socket.emit("dm:send", { toUserId: friend.id, text });
    setDraft("");
  };

  const presence = presenceOf(friend);

  return (
    <div className="friends dm">
      <div className="dm-head">
        <button className="dm-back" onClick={onBack} aria-label="Back to friends">
          ←
        </button>
        <span className={`friend-status ${presence}`} aria-hidden="true" />
        <span className="dm-with">{friend.name}</span>
        <span className="friend-where">{presence === "in-room" ? "in a room" : presence}</span>
      </div>

      {/* Said up front rather than in a footer nobody scrolls to: how long
          these last is part of knowing what this is. */}
      <p className="dm-retention">
        Messages older than {retentionDays ?? 30} days are deleted.
      </p>

      {error && <p className="load-error">{error}</p>}

      <div className="chat-messages dm-messages" ref={listRef}>
        {messages.length === 0 ? (
          <p className="chat-empty">No messages yet — say hi 👋</p>
        ) : (
          messages.map((m, i) => {
            const own = m.from === user?.id;
            const prev = messages[i - 1];
            const grouped =
              prev !== undefined && prev.from === m.from && m.at - prev.at < DM_GROUP_WINDOW_MS;
            const classes = ["chat-msg", own && "own", grouped && "grouped"]
              .filter(Boolean)
              .join(" ");
            return (
              <div key={m.id} className={classes}>
                {!own && !grouped && <span className="chat-name">{friend.name}</span>}
                <span className="chat-bubble" title={new Date(m.at).toLocaleTimeString()}>
                  {m.text}
                </span>
              </div>
            );
          })
        )}
      </div>

      {typingUntil > Date.now() && (
        <p className="typing-line">
          {friend.name} is typing
          <span className="typing-dots" />
        </p>
      )}

      <div className="load-bar dm-bar">
        <input
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            // Composing → ping "typing" at most every 1.5s; the other end
            // expires it 3s after the last ping. Same numbers as room chat.
            if (e.target.value && Date.now() - lastTypingSentRef.current > 1500) {
              lastTypingSentRef.current = Date.now();
              socket.emit("dm:typing", { toUserId: friend.id });
            }
          }}
          placeholder={`Message ${friend.name}...`}
          maxLength={1000}
          onKeyDown={(e) => {
            if (e.key === "Enter") send();
            if (e.key === "Escape") onBack();
          }}
          autoFocus
        />
        <button onClick={send}>Send</button>
      </div>
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
