// Every slash command, written down once. The help card, the suggestions that
// appear while someone is typing, and the "usage:" a mistyped command gets are
// all read off this table — keeping a second copy is how a TUI ends up
// advertising a command it no longer has, or hiding one it grew.

export type Command = {
  /** Without the leading slash. Two words when it's a subcommand. */
  name: string;
  /** Other spellings that run the same thing — matched, never suggested. */
  aliases?: readonly string[];
  /** The argument as it should be read: "<mm:ss>", "[on|off]". */
  args?: string;
  desc: string;
  /** Added to `usage:` where the argument alone doesn't explain itself. */
  hint?: string;
  /** Does nothing without an account, so the list can say so up front. */
  account?: boolean;
  /** Two commands nobody thinks of separately share one help-card line. */
  help?: { with: string; desc: string };
};

export const COMMANDS: readonly Command[] = [
  { name: "search", args: "<query>", desc: "search YouTube", hint: "e.g. /search lofi hip hop" },
  { name: "pick", args: "<n>", desc: "play search result n for everyone", hint: "the number beside a result" },
  { name: "queue", args: "<n>", desc: "add search result n to the queue", hint: "the number beside a result" },
  { name: "add", args: "<url>", desc: "queue a YouTube link (plays if the room is idle)" },
  {
    name: "play",
    aliases: ["resume"],
    desc: "start playback for everyone",
    help: { with: "pause", desc: "control playback for everyone" },
  },
  { name: "pause", desc: "pause playback for everyone" },
  { name: "seek", args: "<mm:ss>", desc: "jump everyone to a position", hint: "e.g. /seek 1:30" },
  { name: "skip", desc: "jump to the next queued track" },
  { name: "remove", args: "<n>", desc: "remove queue item n", hint: "the number in the queue" },
  { name: "autoplay", args: "[on|off]", desc: "keep the room going when the queue empties" },
  { name: "vol", args: "<0-130>", desc: "local volume (only affects you)", hint: "e.g. /vol 80" },
  { name: "emoji", args: "[query]", desc: "browse/search emoji + their :names:" },
  {
    name: "copy",
    args: "[code]",
    desc: "copy the invite link (or just the room code)",
    hint: "/copy for the link, /copy code for the code alone",
  },
  { name: "bug", args: "<description>", desc: "tell us something's broken", hint: "say what happened" },
  // Everything below needs an account — `sesh login` in a shell sets one up.
  { name: "friends", desc: "toggle the friends pane (n = a row in it)" },
  { name: "friends add", args: "<CODE>", desc: "send a friend request to that code", hint: "their friend code", account: true },
  { name: "friends accept", args: "<n>", desc: "take a friend request", hint: "the number in the requests list", account: true },
  { name: "friends remove", args: "<n>", desc: "drop a friend", hint: "/friends numbers them", account: true },
  { name: "invite", args: "<n>", desc: "ask friend n to come to this room", hint: "/friends numbers them", account: true },
  {
    name: "join",
    args: "<n>",
    desc: "go to friend n's room",
    hint: "/friends numbers them",
    account: true,
    help: { with: "accept", desc: "go to friend n's room · take an invite" },
  },
  { name: "accept", desc: "take the invite waiting for you", account: true },
  {
    name: "dms",
    desc: "your conversations",
    account: true,
    help: { with: "dm", desc: "your conversations · message a friend" },
  },
  { name: "dm", args: "<n|name>", desc: "message a friend", hint: "/friends lists them", account: true },
  { name: "room", desc: "back to room chat (Esc does it too)" },
  { name: "whoami", desc: "who this terminal is signed in as" },
  { name: "voice", desc: "why voice chat needs the web client" },
  {
    name: "help",
    desc: "toggle the help card",
    help: { with: "quit", desc: "toggle this help / leave" },
  },
  { name: "quit", aliases: ["exit"], desc: "leave" },
];

const byName = new Map(COMMANDS.map((cmd) => [cmd.name, cmd]));

/** "/friends add <CODE>" — the one way a command is ever written out. */
export function label(cmd: Command): string {
  return `/${cmd.name}${cmd.args ? ` ${cmd.args}` : ""}`;
}

/** The line a command gets when it was given something it can't use. */
export function usage(name: string): string {
  const cmd = byName.get(name);
  if (!cmd) return `unknown command: /${name}`;
  return `usage: ${label(cmd)}${cmd.hint ? ` — ${cmd.hint}` : ""}`;
}

/** "/friends add <CODE> · /friends accept <n> · …" — every subcommand of one. */
export function subcommandsOf(name: string): string {
  return COMMANDS.filter((cmd) => cmd.name.startsWith(`${name} `))
    .map(label)
    .join(" · ");
}

/** What's worth showing for a half-typed line, the "/" already stripped. */
export function matchCommands(typed: string): Command[] {
  const q = typed.toLowerCase();
  const starts = COMMANDS.filter(
    (cmd) => cmd.name.startsWith(q) || cmd.aliases?.some((alias) => alias.startsWith(q)),
  );
  // A name typed out in full is the one that was meant, whatever else it's the
  // start of — "/dm" is about `dm`, not about `dms` sitting above it.
  if (starts.length > 0) return starts.sort((a, b) => Number(b.name === q) - Number(a.name === q));
  // Past the name and into the argument. The only row worth the space now is
  // the command being typed, as a reminder of what it wants — longest match
  // first, so "/friends add X" is about `add` rather than about `friends`.
  return COMMANDS.filter(
    (cmd) =>
      q.startsWith(`${cmd.name} `) || cmd.aliases?.some((alias) => q.startsWith(`${alias} `)),
  )
    .sort((a, b) => b.name.length - a.name.length)
    .slice(0, 1);
}

/** What Tab should replace the line with, or null if there's nothing to finish. */
export function completion(line: string): string | null {
  if (!line.startsWith("/")) return null;
  const typed = line.slice(1).toLowerCase();
  const best = matchCommands(typed)[0];
  // Nothing matched, or the name is already typed out and the cursor is in the
  // arguments — completing there would only mangle what's been written.
  if (!best || !best.name.startsWith(typed)) return null;
  return `/${best.name}${best.args ? " " : ""}`;
}

// The two rows on the help card that aren't commands at all.
const CHAT_ROW: [string, string] = ["<text>", "send a chat message (:name: inserts emoji)"];
const KEYS_ROW: [string, string] = ["PgUp / PgDn", "scroll chat history (or this card, while it's open)"];

/** The help card's lines, generated so it can't drift from the table above. */
export function helpRows(): [string, string][] {
  const paired = new Set(COMMANDS.map((cmd) => cmd.help?.with).filter(Boolean));
  const rows: [string, string][] = [CHAT_ROW];
  for (const cmd of COMMANDS) {
    if (paired.has(cmd.name)) continue;
    const other = cmd.help && byName.get(cmd.help.with);
    rows.push(
      cmd.help && other ? [`${label(cmd)}  ${label(other)}`, cmd.help.desc] : [label(cmd), cmd.desc],
    );
  }
  rows.push(KEYS_ROW);
  return rows;
}
