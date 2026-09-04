import React, { useEffect, useReducer, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import type { Session } from "./session.js";
import { helpRows, label, matchCommands, subcommandsOf, usage, type Command } from "./commands.js";
import { copyToClipboard, hyperlink } from "./clipboard.js";
import { emojiToken, matchEmojis, searchEmojis } from "./emoji.js";
import { extractVideoId, fetchTitle, formatTime, parseTime, search } from "./youtube.js";
import type { SearchResult } from "./types.js";

const CHAT_VISIBLE = 10;
// A few rows above the prompt, not a menu that swallows the room. Anyone who
// wants the whole list has /help.
const SUGGESTIONS_VISIBLE = 5;
// Wide enough for the longest command in the table, so nothing runs into its
// description — in the help card and in the suggestions, which have to line up
// with each other to read as the same list.
const COMMAND_COLUMN = 21;
// The whole table at once is two dozen rows, which shoved the room off the top
// of the screen — so the card is a window onto it that scrolls instead. Sized
// to whatever the terminal can spare, but never so tall that it reintroduces
// the problem and never so short that scrolling it is all anyone does.
const HELP_VISIBLE_MIN = 5;
const HELP_VISIBLE_MAX = 10;
// Roughly what the rest of the interface occupies — header, player, the
// queue/chat row, presence, the suggestions and the prompt — which the card
// has to leave standing.
const HELP_ROWS_RESERVED = 26;
// Read once: it's derived from a table that can't change while we're running.
const HELP_ROWS = helpRows();

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

// What the half-typed line could become — a "/" opening a command, or a ":"
// opening an emoji code mid-message. Learning this TUI used to mean running
// /help and trying commands one at a time; the list narrowing under the
// cursor teaches the same thing without anyone having to ask for it. Both
// kinds share one look and one interaction: ↑↓ picks a row, Tab (and Enter,
// for emoji) takes it.
function Suggestions({
  line,
  commands,
  emojis,
  hidden,
  selected,
  signedIn,
  accountsEnabled,
}: {
  line: string;
  commands: Command[];
  emojis: EmojiSuggestion[];
  hidden: number;
  selected: number;
  signedIn: boolean;
  accountsEnabled: boolean;
}) {
  if (emojis.length > 0) {
    return (
      <Box flexDirection="column">
        {emojis.map((e, i) => (
          <Text key={e.char}>
            <Text color={i === selected ? "yellow" : "gray"} bold={i === selected}>
              {`${e.char}  :${e.name}:`.padEnd(COMMAND_COLUMN)}
            </Text>
            {e.aliases.length > 0 && <Text color="gray">also :{e.aliases.join(": :")}:</Text>}
          </Text>
        ))}
        <Text color="gray">
          {hidden > 0 ? `… ${hidden} more · ` : ""}↑↓ pick · Tab/Enter inserts · /emoji browses all
        </Text>
      </Box>
    );
  }
  // Only ever while a command is being written. The moment the line is chat
  // again — or empty — this is just clutter in front of the room.
  if (!line.startsWith("/")) return null;
  if (commands.length === 0) {
    return (
      <Text color="gray">
        no command matches <Text color="yellow">{line.split(" ")[0]}</Text> — /help lists them all
      </Text>
    );
  }
  const finished = completionOf(commands[selected], line);
  const footer = [
    hidden > 0 ? `… ${hidden} more` : "",
    // Says what Tab will actually put on the line — the argument hint beside
    // it is a description, not something Tab is about to type for you. And
    // there's nothing to offer once the name is written out in full.
    finished && finished.trim() !== line ? `Tab completes ${finished.trim()}` : "",
    commands.length > 1 ? "↑↓ pick" : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <Box flexDirection="column">
      {commands.map((cmd, i) => (
        <Text key={cmd.name}>
          {/* The highlighted row is the one Tab would take. */}
          <Text color={i === selected ? "magenta" : "gray"} bold={i === selected}>
            {label(cmd).padEnd(COMMAND_COLUMN)}
          </Text>
          <Text color="gray">{cmd.desc}</Text>
          {/* Better said here than found out by running it: these do nothing
              at all until there's an account behind them. */}
          {cmd.account && !signedIn && (
            <Text color="yellow" dimColor>
              {accountsEnabled ? " (sign in)" : " (off here)"}
            </Text>
          )}
        </Text>
      ))}
      {footer && <Text color="gray">{footer}</Text>}
    </Box>
  );
}

// An emoji row in the suggestion list: the name that matched what was typed
// up front, the rest as also-known-as.
type EmojiSuggestion = { char: string; name: string; aliases: string[] };

// What Tab would put on the line for this command — or null when the name is
// already written out and the cursor is into the arguments, where completing
// would only mangle what's been typed.
function completionOf(cmd: Command | undefined, line: string): string | null {
  if (!cmd) return null;
  const typed = line.slice(1).toLowerCase();
  if (!cmd.name.startsWith(typed)) return null;
  return `/${cmd.name}${cmd.args ? " " : ""}`;
}

function InputLine({
  line,
  onChange,
  onSubmit,
  active,
  arrowsOwned,
  to,
  signedIn,
  accountsEnabled,
}: {
  line: string;
  onChange: (line: string) => void;
  onSubmit: (line: string) => void;
  /** False while a modal panel (the emoji picker) owns the keyboard outright. */
  active: boolean;
  /** True while another panel (the help card) owns the arrow keys. */
  arrowsOwned: boolean;
  /** Whose DM the next line goes to, if it isn't going to the room. */
  to: string | null;
  signedIn: boolean;
  accountsEnabled: boolean;
}) {
  // Which suggestion row is picked. Lives and dies with the current line —
  // any edit reshuffles the list, so the selection starts over at the top.
  const [sel, setSel] = useState(0);
  useEffect(() => setSel(0), [line]);

  // The three kinds of suggestion this line can be growing: a "/" command, a
  // ":code" emoji anywhere mid-message, or the query being typed after
  // "/emoji" — which is a search box, so it should be answering as it's typed
  // rather than making anyone press Enter to see what they asked for.
  const emojiCommand = /^\/emoji(?:\s+(.*))?$/i.exec(line);
  const commandMatches = line.startsWith("/") && !emojiCommand ? matchCommands(line.slice(1)) : [];
  const token = line.startsWith("/") ? null : emojiToken(line);
  const emojiMatches = emojiCommand
    ? // "/emoji" on its own browses the lot; "/emoji smi" narrows it.
      matchEmojis((emojiCommand[1] ?? "").trim())
    : token
      ? matchEmojis(token)
      : [];
  const query = emojiCommand ? (emojiCommand[1] ?? "").trim() : token;
  // The selection moves through everything that matched, not just the rows
  // that fit — so the list scrolls under it once the pick reaches the bottom.
  const total = emojiMatches.length || commandMatches.length;
  const selected = total ? Math.min(sel, total - 1) : 0;
  const first = Math.max(0, Math.min(selected - SUGGESTIONS_VISIBLE + 1, total - SUGGESTIONS_VISIBLE));
  const window = { from: Math.max(0, first), to: Math.max(0, first) + SUGGESTIONS_VISIBLE };

  const commands = emojiMatches.length ? [] : commandMatches.slice(window.from, window.to);
  const emojis: EmojiSuggestion[] = emojiMatches.slice(window.from, window.to).map((e) => {
    const q = (query ?? "").toLowerCase();
    const name = e.names.find((n) => n.includes(q)) ?? e.names[0];
    return { char: e.char, name, aliases: e.names.filter((n) => n !== name) };
  });
  const rows = total;
  // Where the highlight sits within the window that's actually on screen.
  const selectedRow = selected - window.from;

  // Swaps the half-typed :code for the picked emoji, leaving the rest of the
  // message exactly as it was. Picking one out of "/emoji smi" instead leaves
  // just the emoji on the line, ready to send — the query was the search, not
  // the message.
  const acceptEmoji = (e: EmojiSuggestion) => {
    if (emojiCommand) return onChange(e.char);
    onChange(line.slice(0, line.length - token!.length - 1) + e.char);
  };

  useInput((input, key) => {
    if (!active) return;
    if (key.return) {
      // With an emoji list on offer, Enter takes the picked one — sending the
      // half-typed ":hea" as chat is never what anyone meant. The next Enter
      // sends the message, emoji and all.
      if (emojiMatches.length > 0) return acceptEmoji(emojis[selectedRow]);
      const value = line.trim();
      onChange("");
      if (value) onSubmit(value);
      return;
    }
    if (key.backspace || key.delete) {
      // By code point, not code unit — emoji land on this line now (picker,
      // suggestions), and a bare slice(-1) would shear a surrogate pair in
      // half and leave � behind.
      onChange([...line].slice(0, -1).join(""));
      return;
    }
    // Tab finishes whichever row is highlighted in the list already on screen
    // — the emoji it names, or the command it spells out.
    if (key.tab) {
      if (emojiMatches.length > 0) return acceptEmoji(emojis[selectedRow]);
      const finished = completionOf(commands[selectedRow], line);
      if (finished) onChange(finished);
      return;
    }
    // The arrows move the pick while there's a list to move it through —
    // unless the help card is up, which is what the arrows scroll then. There
    // is no cursor to move, so they never mean anything to the text itself.
    if (key.upArrow || key.downArrow) {
      if (!arrowsOwned && rows > 1) {
        setSel(key.downArrow ? (selected + 1) % rows : (selected - 1 + rows) % rows);
      }
      return;
    }
    if (key.ctrl || key.meta || key.escape || key.leftArrow || key.rightArrow) {
      return;
    }
    onChange(line + input);
  });
  return (
    <Box flexDirection="column">
      <Suggestions
        line={line}
        commands={commands}
        emojis={emojis}
        hidden={total - (emojis.length || commands.length) - window.from}
        selected={selectedRow}
        signedIn={signedIn}
        accountsEnabled={accountsEnabled}
      />
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
    </Box>
  );
}

export function App({ session, serverUrl }: { session: Session; serverUrl: string }) {
  const { exit } = useApp();
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const [results, setResults] = useState<SearchResult[] | null>(null);
  // The line being typed lives here rather than in InputLine so the emoji
  // picker's Enter can drop its pick into it.
  const [line, setLine] = useState("");
  // The emoji picker: which subset it's showing and which row is on. Modal —
  // while it's open the arrows, Enter and Esc are its.
  const [picker, setPicker] = useState<{ query: string; index: number } | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const [helpScroll, setHelpScroll] = useState(0);
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
  // The server's clock, and stepped on ITS second boundaries. roomCreatedAt is
  // a server timestamp, so counting from a local Date.now() measures how wrong
  // this machine's clock is rather than how old the room is. And a plain
  // 1000ms interval starts on whatever phase it happened to start on, so two
  // clients showing the same room sat a second apart forever; waking just
  // after each whole second of room age puts every client on the same step.
  useEffect(() => {
    const createdAt = s.roomCreatedAt;
    if (!createdAt) return;
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      const now = session.serverNow();
      setClock(now);
      timer = setTimeout(tick, 1000 - ((now - createdAt) % 1000) + 5);
    };
    tick();
    return () => clearTimeout(timer);
  }, [s.roomCreatedAt, session]);

  // The first thing someone new needs is the way to find everything else. Once
  // per run, on the way in — /join and /accept rejoin, and being told this
  // again every time you follow a friend would be nagging.
  const greeted = useRef(false);
  useEffect(() => {
    if (!s.joined || greeted.current) return;
    greeted.current = true;
    session.setStatus("new here? type / to see every command");
  }, [s.joined]);

  // How tall the help card gets to be on this terminal, and therefore how far
  // it can scroll. A terminal too short to spare the room still gets the
  // minimum — a cramped card beats one with no rows in it.
  const { stdout } = useStdout();
  const helpVisible = Math.max(
    HELP_VISIBLE_MIN,
    Math.min(HELP_VISIBLE_MAX, (stdout?.rows ?? 24) - HELP_ROWS_RESERVED),
  );
  const helpMax = Math.max(0, HELP_ROWS.length - helpVisible);
  const helpAt = Math.min(helpScroll, helpMax);

  // Escape clears whatever panel is taking up space; PgUp/PgDn walk the
  // chat history (a windowed slice anchored to the newest message) — unless
  // the help card is up, in which case it has the keyboard.
  useInput((_input, key) => {
    if (key.escape) {
      // The picker and the card are the panels that take keys of their own,
      // so each takes the first Escape by itself: putting one away shouldn't
      // also sweep away the search results or the conversation behind it.
      if (picker) {
        setPicker(null);
        return;
      }
      if (showHelp) {
        setShowHelp(false);
        return;
      }
      setResults(null);
      setShowFriends(false);
      setShowDms(false);
      // A conversation is a panel too, and leaving it puts typing back where
      // someone hitting Escape expects it: the room.
      session.closeDm();
      return;
    }
    // The picker is the same kind of reader as the help card — arrows a row,
    // PgUp/PgDn a screenful — plus Enter, which drops the highlighted emoji
    // onto the input line where the message is being written.
    if (picker) {
      const list = searchEmojis(picker.query);
      const last = list.length - 1;
      if (key.downArrow) setPicker({ ...picker, index: Math.min(picker.index + 1, last) });
      else if (key.upArrow) setPicker({ ...picker, index: Math.max(0, picker.index - 1) });
      else if (key.pageDown) setPicker({ ...picker, index: Math.min(picker.index + helpVisible, last) });
      else if (key.pageUp) setPicker({ ...picker, index: Math.max(0, picker.index - helpVisible) });
      else if (key.return && list[picker.index]) {
        setLine((prev) => prev + list[picker.index].char);
        setPicker(null);
      }
      return;
    }
    // Nobody is reading the chat through the card, so while it's open the
    // scrolling keys move it instead — arrows a row, PgUp/PgDn a screenful.
    // They go back to the history the moment it closes.
    if (showHelp) {
      if (key.downArrow) setHelpScroll((o) => Math.min(o + 1, helpMax));
      if (key.upArrow) setHelpScroll((o) => Math.max(0, o - 1));
      if (key.pageDown) setHelpScroll((o) => Math.min(o + helpVisible, helpMax));
      if (key.pageUp) setHelpScroll((o) => Math.max(0, o - helpVisible));
      return;
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
        if (time === null) return session.setStatus(usage("seek"));
        void session.seekTo(time);
        break;
      }
      case "search":
        if (!arg) return session.setStatus(usage("search"));
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
        if (!result) return session.setStatus(usage("pick"));
        setResults(null);
        void session.playNow(result.videoId, result.title);
        break;
      }
      case "queue": {
        const result = nth(results, arg);
        if (!result) return session.setStatus(usage("queue"));
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
        if (!item) return session.setStatus(usage("remove"));
        session.queueRemove(item.id);
        break;
      }
      case "vol": {
        const volume = Number(arg);
        if (!Number.isFinite(volume)) return session.setStatus(usage("vol"));
        void session.setVolume(volume);
        break;
      }
      case "autoplay": {
        // A toggle that can't do anything is worse than no toggle: say why
        // rather than accepting the word and changing nothing.
        if (!s.radioAvailable) {
          return session.setStatus("autoplay isn't available on this server (it has no YouTube key)");
        }
        const wanted = arg.trim().toLowerCase();
        if (!wanted) {
          return session.setStatus(
            s.autoplay
              ? "autoplay is on — the room keeps going when the queue empties · /autoplay off"
              : "autoplay is off — the room stops when the queue empties · /autoplay on",
          );
        }
        if (wanted !== "on" && wanted !== "off") return session.setStatus(usage("autoplay"));
        session.setAutoplay(wanted === "on");
        break;
      }
      case "bug": {
        if (!arg.trim()) return session.setStatus(usage("bug"));
        void session.reportBug(arg);
        break;
      }
      case "emoji": {
        // The whole set (or the matching slice of it), in the navigable
        // picker — not a dump that assumes the :codes: are already known.
        if (arg && searchEmojis(arg).length === 0) {
          return session.setStatus(`no emoji match "${arg}" — /emoji browses everything`);
        }
        setPicker({ query: arg, index: 0 });
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
          if (!value) return session.setStatus(usage("friends add"));
          setShowFriends(true);
          void session.addFriend(value);
        } else if (sub === "accept") {
          const request = nth(session.friendRequests(), value);
          if (!request) return session.setStatus(usage("friends accept"));
          setShowFriends(true);
          void session.acceptFriendRequest(request);
        } else if (sub === "remove") {
          const friend = nth(session.acceptedFriends(), value);
          if (!friend) return session.setStatus(usage("friends remove"));
          void session.removeFriend(friend);
        } else {
          session.setStatus(`try: /friends · ${subcommandsOf("friends")}`);
        }
        break;
      }
      case "invite": {
        if (!session.requireAccount()) break;
        const friend = nth(session.acceptedFriends(), arg);
        if (!friend) return session.setStatus(usage("invite"));
        session.invite(friend);
        break;
      }
      case "join": {
        if (!session.requireAccount()) break;
        const friend = nth(session.acceptedFriends(), arg);
        if (!friend) return session.setStatus(usage("join"));
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
        if (!friend) return session.setStatus(usage("dm"));
        setShowDms(false);
        void session.openDm(friend);
        break;
      }
      case "room":
        session.closeDm();
        break;
      case "copy": {
        // A terminal can't offer a click-to-copy button — capturing the mouse
        // would take away the selection people already have — but it can put
        // things on the clipboard directly, which is the thing they wanted.
        const wantsCode = arg.trim().toLowerCase() === "code";
        const value = wantsCode ? s.roomId : `${serverUrl}/room/${s.roomId}`;
        void copyToClipboard(value).then(({ via }) => {
          session.setStatus(
            via === "helper"
              ? `copied: ${value}`
              : // Nothing acknowledges an OSC 52, so promising it landed would
                // sometimes be a lie. Show the value either way.
                `sent to your terminal's clipboard: ${value}`,
          );
        });
        break;
      }
      case "whoami":
        session.setStatus(
          s.account
            ? `${s.account.name} · friend code ${s.account.friendCode}`
            : "not signed in — run `sesh login` in a shell",
        );
        break;
      case "help":
        // Back to the top every time it's asked for: /help means "show me the
        // commands", not "put me back where I left off reading them".
        setShowHelp((v) => !v);
        setHelpScroll(0);
        break;
      case "quit":
      case "exit":
        // Ink's exit() unmounts and resolves waitUntilExit, which is where the
        // process would normally tidy up and go. It didn't: something in the
        // socket/mpv teardown was still holding the event loop, so the render
        // went away and the prompt sat there until Ctrl-C. Tear down what we
        // own, ask Ink to leave, then make sure of it — an explicit exit on a
        // short timer that is deliberately NOT unref'd, so it stays alive long
        // enough to fire.
        try {
          session.destroy();
        } catch {
          // Nothing here is worth staying open for.
        }
        exit();
        // Not reproducible from a bare terminal here (no mpv playing, which is
        // the most likely thing still holding the loop), so this doesn't try to
        // guess the cause: it just leaves. Deliberately NOT unref'd, so it
        // stays alive long enough to fire.
        setTimeout(() => process.exit(0), 150);
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
        {/* The radio picks the next song without anyone asking, so it says so
            where the playback it decides is being read. Hidden outright on a
            server that can't do it — a state nobody can change is noise. */}
        {s.radioAvailable &&
          (s.radioSearching ? (
            <Text color="magenta">finding something to play next…</Text>
          ) : (
            <Text color="gray">
              autoplay {s.autoplay ? "on" : "off"} · /autoplay {s.autoplay ? "off" : "on"}
            </Text>
          ))}
      </Box>

      {/* Search results */}
      {results && (
        <Box borderStyle="round" borderColor="cyan" paddingX={1} flexDirection="column">
          <Text color="cyan" bold>
            results <Text color="gray">· /pick n plays · /queue n queues · Esc closes</Text>
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

      {/* Emoji picker — the same kind of window-onto-a-list as the help card,
          but with a pick: Enter drops the highlighted emoji into the line. */}
      {picker &&
        (() => {
          const list = searchEmojis(picker.query);
          const index = Math.min(picker.index, list.length - 1);
          // The window follows the highlight: top-pinned until the pick walks
          // off the bottom, then sliding a row at a time.
          const top = Math.min(Math.max(0, index - helpVisible + 1), Math.max(0, list.length - helpVisible));
          return (
            <Box borderStyle="round" borderColor="yellow" paddingX={1} flexDirection="column">
              <Text color="yellow" bold>
                emoji{picker.query ? ` matching “${picker.query}”` : ""}{" "}
                <Text color="gray">
                  {list.length > helpVisible
                    ? `· ${top + 1}-${Math.min(top + helpVisible, list.length)} of ${list.length} · ↑↓ pick · PgUp/PgDn page `
                    : "· ↑↓ pick "}
                  · Enter inserts · Esc closes
                </Text>
              </Text>
              {list.slice(top, top + helpVisible).map((e, i) => {
                const on = top + i === index;
                return (
                  <Text key={e.char}>
                    <Text color={on ? "yellow" : undefined} bold={on}>
                      {on ? "▸ " : "  "}
                      {e.char}
                      {"  "}
                    </Text>
                    <Text color={on ? "yellow" : "gray"} bold={on}>
                      {`:${e.names[0]}:`.padEnd(COMMAND_COLUMN - 5)}
                    </Text>
                    {e.names.length > 1 && <Text color="gray">also :{e.names.slice(1).join(": :")}:</Text>}
                  </Text>
                );
              })}
              <Text color="gray">these work typed out too — :{list[index]?.names[0]}: in a message</Text>
            </Box>
          );
        })()}

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
              <Text color="gray"> · /room goes back · Esc closes</Text>
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
        </Text>
        {s.status && <Text color="yellow">{s.status}</Text>}
      </Box>

      {showHelp && (
        <Box borderStyle="round" borderColor="gray" paddingX={1} flexDirection="column">
          <Text color="gray" bold>
            help{" "}
            <Text color="gray">
              {/* Where in the list this window sits, and how to move it — but
                  only when there's anything off the card. On a tall terminal
                  the whole table fits and there is nothing to scroll. */}
              {helpMax > 0
                ? `· ${helpAt + 1}-${Math.min(helpAt + helpVisible, HELP_ROWS.length)} of ${HELP_ROWS.length} · ↑↓ scroll · PgUp/PgDn page `
                : ""}
              · Esc closes
            </Text>
          </Text>
          {HELP_ROWS.slice(helpAt, helpAt + helpVisible).map(([cmd, desc]) => (
            <Text key={cmd}>
              <Text color="magenta">{cmd.padEnd(COMMAND_COLUMN)}</Text>
              <Text color="gray">{desc}</Text>
            </Text>
          ))}
        </Box>
      )}

      <InputLine
        line={line}
        active={!picker}
        arrowsOwned={showHelp}
        to={dm?.name ?? null}
        signedIn={!!s.account}
        accountsEnabled={s.accountsEnabled}
        onSubmit={handle}
        onChange={(next) => {
          setLine(next);
          // Only real chat text counts as "typing" — commands don't. Which end
          // hears about it follows wherever the line is headed.
          if (!next || next.startsWith("/")) return;
          if (dm) session.notifyDmTyping();
          else session.notifyTyping();
        }}
      />
      <Text color="gray">
        {dm
          ? `→ ${dm.name} · Esc or /room goes back to room chat`
          : // The link is an OSC 8 hyperlink, so terminals that support it make
            // it clickable to open; the rest just show the text. /copy is
            // named right beside it because clicking can't put it on a
            // clipboard, only opening it can.
            `type to chat · / lists commands · ctrl+c to leave · share: ${hyperlink(
              `${serverUrl}/room/${s.roomId}`,
              `${serverUrl.replace(/^https?:\/\//, "")}/room/${s.roomId}`,
            )} (/copy)`}
      </Text>
    </Box>
  );
}
