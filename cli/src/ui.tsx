import React, { useEffect, useReducer, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import type { Session } from "./session.js";
import { searchEmojis, type Emoji } from "./emoji.js";
import { extractVideoId, fetchTitle, formatTime, parseTime, search } from "./youtube.js";
import type { SearchResult } from "./types.js";

const CHAT_VISIBLE = 10;

const HELP = [
  ["<text>", "send a chat message (:name: inserts emoji)"],
  ["/search <query>", "search YouTube"],
  ["/pick <n>", "play search result n for everyone"],
  ["/queue <n>", "add search result n to the queue"],
  ["/add <url>", "queue a YouTube link (plays if room is idle)"],
  ["/play  /pause", "control playback for everyone"],
  ["/seek <m:ss>", "jump everyone to a position"],
  ["/skip", "jump to the next queued track"],
  ["/remove <n>", "remove queue item n"],
  ["/vol <0-130>", "local volume (only affects you)"],
  ["/emoji [query]", "browse/search emoji + their :names:"],
  // Everything below needs an account — `sesh login` in a shell sets one up.
  ["/friends", "toggle the friends pane (n = a row in it)"],
  ["/friends add <CODE>", "send a friend request to that code"],
  ["/friends accept <n>", "take a request · /friends remove <n>"],
  ["/invite <n>", "ask friend n to come to this room"],
  ["/join <n>  /accept", "go to friend n's room · take an invite"],
  ["/dms  /dm <n|name>", "your conversations · message a friend"],
  ["/room", "back to room chat (Esc does it too)"],
  ["/whoami", "who this terminal is signed in as"],
  ["PgUp / PgDn", "scroll chat history"],
  ["/help  /quit", "toggle this help / leave"],
] as const;

// "up 2h 14m" — coarse on purpose; nobody needs the seconds after an hour.
function formatUptime(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function InputLine({
  onSubmit,
  onType,
  to,
}: {
  onSubmit: (line: string) => void;
  onType: (line: string) => void;
  /** Whose DM the next line goes to, if it isn't going to the room. */
  to: string | null;
}) {
  const [line, setLine] = useState("");
  useInput((input, key) => {
    if (key.return) {
      const value = line.trim();
      setLine("");
      if (value) onSubmit(value);
      return;
    }
    if (key.backspace || key.delete) {
      setLine((prev) => {
        const next = prev.slice(0, -1);
        onType(next);
        return next;
      });
      return;
    }
    if (key.ctrl || key.meta || key.escape || key.upArrow || key.downArrow || key.leftArrow || key.rightArrow || key.tab) {
      return;
    }
    setLine((prev) => {
      const next = prev + input;
      onType(next);
      return next;
    });
  });
  return (
    <Box>
      {/* The prompt itself says where the line is going — mistaking a DM for
          room chat is not a mistake anyone should be able to make quietly. */}
      <Text color={to ? "cyan" : "magenta"} bold>
        {to ? `→ ${to} ` : ""}
        {"> "}
      </Text>
      <Text>{line}</Text>
      <Text color="gray">▏</Text>
    </Box>
  );
}

export function App({ session, serverUrl }: { session: Session; serverUrl: string }) {
  const { exit } = useApp();
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [emojiResults, setEmojiResults] = useState<Emoji[] | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const [showFriends, setShowFriends] = useState(false);
  const [showDms, setShowDms] = useState(false);
  const [chatScroll, setChatScroll] = useState(0);
  const [dotFrame, setDotFrame] = useState(0);
  const [clock, setClock] = useState(Date.now());

  useEffect(() => {
    session.on("update", rerender);
    return () => {
      session.off("update", rerender);
    };
  }, [session]);

  const s = session.state;

  // Terminal "animation" is just re-rendering on a timer: cycle the typing
  // dots while anyone's typing, tick the uptime clock once a second.
  useEffect(() => {
    if (s.typers.length === 0) return;
    const t = setInterval(() => setDotFrame((f) => (f + 1) % 3), 400);
    return () => clearInterval(t);
  }, [s.typers.length > 0]);
  useEffect(() => {
    if (!s.roomCreatedAt) return;
    const t = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(t);
  }, [s.roomCreatedAt]);

  // Escape clears whatever panel is taking up space; PgUp/PgDn walk the
  // chat history (a windowed slice anchored to the newest message).
  useInput((_input, key) => {
    if (key.escape) {
      setShowHelp(false);
      setResults(null);
      setEmojiResults(null);
      setShowFriends(false);
      setShowDms(false);
      // A conversation is a panel too, and leaving it puts typing back where
      // someone hitting Escape expects it: the room.
      session.closeDm();
    }
    if (key.pageUp) {
      setChatScroll((o) => Math.min(o + 5, Math.max(0, s.messages.length - CHAT_VISIBLE)));
    }
    if (key.pageDown) {
      setChatScroll((o) => Math.max(0, o - 5));
    }
  });

  const handle = (line: string) => {
    // Nothing typed at the prompt is allowed to take down the whole TUI.
    try {
      dispatch(line);
    } catch (err) {
      session.setStatus(`error: ${(err as Error).message}`);
    }
  };

  const dispatch = (line: string) => {
    // Help is a reference card, not a fixture — any next input dismisses it.
    if (!/^\/help\b/i.test(line)) setShowHelp(false);
    if (!line.startsWith("/")) {
      // An open conversation owns the keyboard — that's the whole point of it.
      if (session.state.dm) session.sendDm(line);
      else session.sendChat(line);
      return;
    }
    const [cmd, ...rest] = line.slice(1).split(/\s+/);
    const arg = rest.join(" ");
    const nth = <T,>(list: T[] | null, raw: string): T | null => {
      const i = Number(raw);
      if (!list || !Number.isInteger(i) || i < 1 || i > list.length) return null;
      return list[i - 1];
    };

    switch (cmd.toLowerCase()) {
      case "play":
      case "resume":
        void session.play();
        break;
      case "pause":
        void session.pause();
        break;
      case "seek": {
        const time = parseTime(arg);
        if (time === null) return session.setStatus("usage: /seek 1:30");
        void session.seekTo(time);
        break;
      }
      case "search":
        if (!arg) return session.setStatus("usage: /search lofi hip hop");
        session.setStatus("searching…");
        void (async () => {
          try {
            const found = await search(serverUrl, arg);
            setResults(found.length ? found : null);
            session.setStatus(found.length ? null : "no results");
          } catch (err) {
            session.setStatus((err as Error).message);
          }
        })();
        break;
      case "pick": {
        const result = nth(results, arg);
        if (!result) return session.setStatus("usage: /pick <result #>");
        setResults(null);
        void session.playNow(result.videoId, result.title);
        break;
      }
      case "queue": {
        const result = nth(results, arg);
        if (!result) return session.setStatus("usage: /queue <result #>");
        void session.addToQueue(result.videoId, result.title);
        break;
      }
      case "add": {
        const videoId = extractVideoId(arg);
        if (!videoId) return session.setStatus("that doesn't look like a YouTube link or id");
        void (async () => {
          const title = await fetchTitle(videoId);
          await session.addToQueue(videoId, title);
        })();
        break;
      }
      case "skip":
        session.skip();
        break;
      case "remove": {
        const item = nth(s.queue, arg);
        if (!item) return session.setStatus("usage: /remove <queue #>");
        session.queueRemove(item.id);
        break;
      }
      case "vol": {
        const volume = Number(arg);
        if (!Number.isFinite(volume)) return session.setStatus("usage: /vol 80");
        void session.setVolume(volume);
        break;
      }
      case "emoji": {
        const found = searchEmojis(arg);
        if (!found.length) return session.setStatus(`no emoji match "${arg}"`);
        setEmojiResults(found.slice(0, 24));
        break;
      }
      case "friends": {
        if (rest.length === 0) {
          setShowFriends((v) => !v);
          break;
        }
        // Acting on the list, unlike looking at it, needs an account — say so
        // before complaining about an index into a list that can't exist.
        if (!session.requireAccount()) break;
        const sub = rest[0].toLowerCase();
        const value = rest.slice(1).join(" ");
        if (sub === "add") {
          if (!value) return session.setStatus("usage: /friends add ABC123");
          setShowFriends(true);
          void session.addFriend(value);
        } else if (sub === "accept") {
          const request = nth(session.friendRequests(), value);
          if (!request) return session.setStatus("usage: /friends accept <request #>");
          setShowFriends(true);
          void session.acceptFriendRequest(request);
        } else if (sub === "remove") {
          const friend = nth(session.acceptedFriends(), value);
          if (!friend) return session.setStatus("usage: /friends remove <friend #>");
          void session.removeFriend(friend);
        } else {
          session.setStatus("try: /friends · /friends add <CODE> · accept <n> · remove <n>");
        }
        break;
      }
      case "invite": {
        if (!session.requireAccount()) break;
        const friend = nth(session.acceptedFriends(), arg);
        if (!friend) return session.setStatus("usage: /invite <friend #> — /friends numbers them");
        session.invite(friend);
        break;
      }
      case "join": {
        if (!session.requireAccount()) break;
        const friend = nth(session.acceptedFriends(), arg);
        if (!friend) return session.setStatus("usage: /join <friend #> — /friends numbers them");
        if (!friend.roomId) return session.setStatus(`${friend.name} isn't in a room right now`);
        void session.switchRoom(friend.roomId);
        break;
      }
      case "accept": {
        const invite = s.invite;
        if (!invite) return session.setStatus("no invite waiting");
        void session.switchRoom(invite.roomId);
        break;
      }
      case "dms":
        if (!session.requireAccount()) break;
        setShowDms((v) => !v);
        break;
      case "dm": {
        if (!session.requireAccount()) break;
        const friend = session.findFriend(arg);
        if (!friend) return session.setStatus("usage: /dm <friend # or name> — /friends lists them");
        setShowDms(false);
        void session.openDm(friend);
        break;
      }
      case "room":
        session.closeDm();
        break;
      case "voice":
        // Honest rather than silent: the mesh is browser-to-browser WebRTC and
        // there is no headless half of it to join.
        session.setStatus(
          `voice needs the web client — open ${serverUrl.replace(/^https?:\/\//, "")}/room/${s.roomId}`,
        );
        break;
      case "whoami":
        session.setStatus(
          s.account
            ? `${s.account.name} · friend code ${s.account.friendCode}`
            : "not signed in — run `sesh login` in a shell",
        );
        break;
      case "help":
        setShowHelp((v) => !v);
        break;
      case "quit":
      case "exit":
        session.destroy();
        exit();
        break;
      default:
        session.setStatus(`unknown command: /${cmd} (try /help)`);
    }
  };

  if (s.fatal) {
    return (
      <Box borderStyle="round" borderColor="red" paddingX={1}>
        <Text color="red">{s.fatal}</Text>
      </Box>
    );
  }

  // Never render the room before the server confirms membership — a
  // rejected join must look rejected, not like an empty room.
  if (!s.joined) {
    return (
      <Box borderStyle="round" borderColor="magenta" paddingX={1}>
        <Text color="gray">{s.connected ? `joining room ${s.roomId}…` : "connecting…"}</Text>
      </Box>
    );
  }

  const drift =
    s.driftMs === null ? "" : Math.abs(s.driftMs) < 60 ? ` · synced (${s.driftMs}ms)` : ` · syncing…`;

  // One numbering for friends across every pane and command: the sorted list
  // /friends draws is the list /dm, /invite and /join count into.
  const friends = session.acceptedFriends();
  const requests = session.friendRequests();
  const outgoing = session.outgoingRequests();
  const friendNumber = new Map(friends.map((friend, i) => [friend.id, i + 1]));
  const dm = s.dm;

  return (
    <Box flexDirection="column">
      {/* Header */}
      <Box justifyContent="space-between">
        <Text>
          <Text color="magenta" bold>
            {/* Wide glyphs render flush against the next char in many
                terminals — the double space reads as one. */}
            ⏺  Sesh
          </Text>
          <Text color="gray"> · room </Text>
          <Text bold>{s.roomId}</Text>
          {s.roomCreatedAt && <Text color="gray"> · up {formatUptime(clock - s.roomCreatedAt)}</Text>}
        </Text>
        <Text color={s.connected ? "green" : "yellow"}>{s.connected ? "connected" : "connecting…"}</Text>
      </Box>

      {/* Now playing */}
      <Box borderStyle="round" borderColor="magenta" paddingX={1} flexDirection="column">
        {s.videoId ? (
          <>
            <Text bold>
              {s.isPlaying ? "▶  " : "⏸  "}
              {s.title ?? s.videoId}
            </Text>
            <Text color="gray">
              {formatTime(s.position ?? 0)}
              {s.duration ? ` / ${formatTime(s.duration)}` : ""}
              {drift}
            </Text>
          </>
        ) : (
          <Text color="gray">nothing playing — /search or /add something</Text>
        )}
      </Box>

      {/* Search results */}
      {results && (
        <Box borderStyle="round" borderColor="cyan" paddingX={1} flexDirection="column">
          <Text color="cyan" bold>
            results · /pick n plays · /queue n queues
          </Text>
          {results.map((r, i) => (
            <Text key={r.videoId} wrap="truncate">
              <Text color="cyan">{i + 1}.</Text> {r.title}{" "}
              <Text color="gray">
                · {r.channel}
                {r.duration ? ` · ${r.duration}` : ""}
              </Text>
            </Text>
          ))}
        </Box>
      )}

      {/* Emoji browser */}
      {emojiResults && (
        <Box borderStyle="round" borderColor="yellow" paddingX={1} flexDirection="column">
          <Text color="yellow" bold>
            emoji · type :name: in a message · Esc closes
          </Text>
          {Array.from({ length: Math.ceil(emojiResults.length / 4) }, (_, row) => (
            <Text key={row}>
              {emojiResults.slice(row * 4, row * 4 + 4).map((e) => (
                <Text key={e.char}>
                  {e.char}
                  <Text color="gray"> :{e.names[0]}:{" ".repeat(Math.max(1, 16 - e.names[0].length))}</Text>
                </Text>
              ))}
            </Text>
          ))}
        </Box>
      )}

      {/* Friends */}
      {showFriends && (
        <Box borderStyle="round" borderColor="magenta" paddingX={1} flexDirection="column">
          <Text color="magenta" bold>
            friends <Text color="gray">· /dm n · /invite n · /join n · Esc closes</Text>
          </Text>
          {s.account ? (
            <Text color="gray">
              your code: <Text color="white" bold>{s.account.friendCode}</Text> · add someone with
              /friends add &lt;CODE&gt;
            </Text>
          ) : (
            <Text color="yellow">
              {s.accountsEnabled
                ? "sign in with `sesh login` first"
                : "this server doesn't do accounts — friends and DMs are off here"}
            </Text>
          )}
          {s.account && friends.length === 0 && (
            <Text color="gray">nobody yet — swap codes with someone and add them</Text>
          )}
          {friends.map((friend, i) => (
            <Text key={friend.id} wrap="truncate">
              <Text color="magenta">{i + 1}.</Text> {friend.name}{" "}
              {/* Three states, three colours: watching something, around, gone. */}
              <Text color={friend.roomId ? "green" : friend.online ? "cyan" : "gray"}>
                {friend.roomId
                  ? friend.roomId === s.roomId
                    ? "here"
                    : "in a room"
                  : friend.online
                    ? "online"
                    : "offline"}
              </Text>
              {friend.unread > 0 && <Text color="yellow"> · {friend.unread} unread</Text>}
            </Text>
          ))}
          {requests.length > 0 && (
            <>
              <Text color="yellow" bold>
                wants to be friends <Text color="gray">· /friends accept n</Text>
              </Text>
              {requests.map((friend, i) => (
                <Text key={friend.id}>
                  <Text color="yellow">{i + 1}.</Text> {friend.name}
                </Text>
              ))}
            </>
          )}
          {outgoing.length > 0 && (
            <Text color="gray">waiting on {outgoing.map((friend) => friend.name).join(", ")}</Text>
          )}
        </Box>
      )}

      {/* Conversations */}
      {showDms && (
        <Box borderStyle="round" borderColor="cyan" paddingX={1} flexDirection="column">
          <Text color="cyan" bold>
            conversations <Text color="gray">· /dm n opens one · Esc closes</Text>
          </Text>
          {session.conversations().length === 0 ? (
            <Text color="gray">nothing yet — /dm &lt;name&gt; starts one</Text>
          ) : (
            session.conversations().map((friend) => (
              <Text key={friend.id} wrap="truncate">
                {/* Numbered by the friends list, not by this one, so a number
                    means the same thing wherever it's read off the screen. */}
                <Text color="cyan">{friendNumber.get(friend.id)}.</Text> {friend.name}{" "}
                <Text color="gray">
                  · {friend.lastMessage?.mine ? "you: " : ""}
                  {friend.lastMessage?.text}
                </Text>
                {friend.unread > 0 && <Text color="yellow"> · {friend.unread} unread</Text>}
              </Text>
            ))
          )}
        </Box>
      )}

      {/* Queue + chat */}
      <Box>
        <Box borderStyle="round" borderColor="blue" paddingX={1} flexDirection="column" width="40%">
          <Text color="blue" bold>
            up next {s.queue.length > 0 ? `(${s.queue.length})` : ""}
          </Text>
          {s.queue.length === 0 ? (
            <Text color="gray">empty — /add or /queue</Text>
          ) : (
            s.queue.slice(0, 8).map((item, i) => (
              <Text key={item.id} wrap="truncate">
                <Text color="blue">{i + 1}.</Text> {item.title ?? item.videoId}{" "}
                <Text color="gray">· {item.addedBy}</Text>
              </Text>
            ))
          )}
        </Box>
        {/* A conversation takes the chat's place rather than sitting beside it:
            one pane, and no doubt about which one the keyboard is aimed at. */}
        {dm ? (
          <Box borderStyle="round" borderColor="cyan" paddingX={1} flexDirection="column" flexGrow={1}>
            <Text color="cyan" bold>
              dm · {dm.name}
              <Text color="gray"> · /room goes back</Text>
            </Text>
            {s.dmMessages.length === 0 ? (
              <Text color="gray">nothing here yet — say something</Text>
            ) : (
              s.dmMessages.slice(-CHAT_VISIBLE).map((m) => (
                <Text key={m.id}>
                  <Text color={m.from === s.account?.id ? "green" : "cyan"} bold>
                    {m.from === s.account?.id ? "you" : dm.name}:
                  </Text>{" "}
                  {m.text}
                </Text>
              ))
            )}
            {s.dmTyper && (
              <Text color="gray" italic>
                {s.dmTyper} typing{".".repeat(dotFrame + 1)}
              </Text>
            )}
            {/* Said plainly, where it's read: this is not an archive. */}
            <Text color="gray">
              messages older than {s.dmRetentionDays ?? 30} days are deleted
            </Text>
          </Box>
        ) : (
        <Box borderStyle="round" borderColor="green" paddingX={1} flexDirection="column" flexGrow={1}>
          <Text color="green" bold>
            chat
            {(() => {
              // Windowed slice anchored to the newest message; PgUp walks back.
              const total = s.messages.length;
              const scroll = Math.min(chatScroll, Math.max(0, total - CHAT_VISIBLE));
              if (scroll > 0) return <Text color="yellow"> · viewing history ({scroll} newer below — PgDn)</Text>;
              if (total > CHAT_VISIBLE) return <Text color="gray"> · PgUp for history</Text>;
              return null;
            })()}
          </Text>
          {(() => {
            const total = s.messages.length;
            const scroll = Math.min(chatScroll, Math.max(0, total - CHAT_VISIBLE));
            return s.messages.slice(Math.max(0, total - CHAT_VISIBLE - scroll), total - scroll || undefined);
          })().map((m) => (
            <Text key={m.id}>
              <Text color={m.senderId === session.clientId ? "green" : "cyan"} bold>
                {m.name}:
              </Text>{" "}
              {m.text}
            </Text>
          ))}
          {s.typers.length > 0 && (
            <Text color="gray" italic>
              {s.typers.join(", ")} typing{".".repeat(dotFrame + 1)}
            </Text>
          )}
        </Box>
        )}
      </Box>

      {/* Presence + status */}
      <Box justifyContent="space-between">
        <Text color="gray" wrap="truncate">
          here: {s.users.map((u) => u.name).join(", ") || "…"}
          {/* The CLI can't be in the call, but staying blind to one happening
              is worse than knowing and not joining. */}
          {s.voice.length > 0 && <Text color="green"> · in voice: {s.voice.join(", ")}</Text>}
        </Text>
        {s.status && <Text color="yellow">{s.status}</Text>}
      </Box>

      {showHelp && (
        <Box borderStyle="round" borderColor="gray" paddingX={1} flexDirection="column">
          {HELP.map(([cmd, desc]) => (
            <Text key={cmd}>
              {/* Wide enough for the longest command in the list, so nothing
                  runs into its description. */}
              <Text color="magenta">{cmd.padEnd(21)}</Text>
              <Text color="gray">{desc}</Text>
            </Text>
          ))}
        </Box>
      )}

      <InputLine
        to={dm?.name ?? null}
        onSubmit={handle}
        onType={(line) => {
          // Only real chat text counts as "typing" — commands don't. Which end
          // hears about it follows wherever the line is headed.
          if (!line || line.startsWith("/")) return;
          if (dm) session.notifyDmTyping();
          else session.notifyTyping();
        }}
      />
      <Text color="gray">
        {dm
          ? `→ ${dm.name} · Esc or /room goes back to room chat`
          : `type to chat · /help for commands · ctrl+c to leave · share: ${serverUrl.replace(/^https?:\/\//, "")}/room/${s.roomId}`}
      </Text>
    </Box>
  );
}
