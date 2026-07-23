// Curated emoji set, searchable by name and usable as :shortcode: in chat.
// Kept deliberately small — zero bundle weight, and the OS emoji keyboard
// covers everything else. (Duplicated verbatim in client/src/emoji.ts — the two
// workspaces share no package, keep them in sync by hand.)

export type Emoji = { char: string; names: string[] };

export const EMOJIS: Emoji[] = [
  { char: "😂", names: ["joy", "lol"] },
  { char: "🤣", names: ["rofl", "laughing"] },
  { char: "😊", names: ["smile", "happy"] },
  { char: "😍", names: ["heart_eyes", "love"] },
  { char: "🥰", names: ["smiling_hearts", "adore"] },
  { char: "😎", names: ["cool", "sunglasses"] },
  { char: "🤔", names: ["thinking", "hmm"] },
  { char: "🙄", names: ["eyeroll", "whatever"] },
  { char: "😭", names: ["sob", "crying"] },
  { char: "😅", names: ["sweat_smile", "phew"] },
  { char: "🙃", names: ["upside_down", "silly"] },
  { char: "😮", names: ["wow", "open_mouth"] },
  { char: "😴", names: ["sleeping", "zzz"] },
  { char: "🥳", names: ["party", "celebrate"] },
  { char: "😤", names: ["huff", "frustrated"] },
  { char: "🤯", names: ["mind_blown", "exploding_head"] },
  { char: "😢", names: ["cry", "tear"] },
  { char: "😡", names: ["angry", "rage"] },
  { char: "😱", names: ["scream", "shocked"] },
  { char: "🤗", names: ["hug", "hugging"] },
  { char: "🤫", names: ["shush", "quiet"] },
  { char: "😇", names: ["angel", "innocent"] },
  { char: "🤪", names: ["zany", "crazy"] },
  { char: "😏", names: ["smirk", "sly"] },
  { char: "❤️", names: ["heart", "red_heart"] },
  { char: "💔", names: ["broken_heart", "heartbreak"] },
  { char: "🔥", names: ["fire", "lit"] },
  { char: "💀", names: ["skull", "dead"] },
  { char: "💯", names: ["100", "hundred"] },
  { char: "👍", names: ["thumbsup", "+1", "yes"] },
  { char: "👎", names: ["thumbsdown", "-1", "no"] },
  { char: "👏", names: ["clap", "applause"] },
  { char: "🙌", names: ["raised_hands", "hooray"] },
  { char: "🙏", names: ["pray", "please", "thanks"] },
  { char: "👀", names: ["eyes", "looking"] },
  { char: "💪", names: ["muscle", "strong"] },
  { char: "🤝", names: ["handshake", "deal"] },
  { char: "👋", names: ["wave", "hello", "bye"] },
  { char: "✌️", names: ["peace", "victory"] },
  { char: "🤞", names: ["fingers_crossed", "luck"] },
  { char: "✨", names: ["sparkles", "shiny"] },
  { char: "🎉", names: ["tada", "confetti"] },
  { char: "🎶", names: ["music", "notes"] },
  { char: "🎵", names: ["musical_note", "song"] },
  { char: "🍿", names: ["popcorn", "movie"] },
  { char: "🍕", names: ["pizza", "slice"] },
  { char: "☕", names: ["coffee", "cafe"] },
  { char: "🍻", names: ["beers", "cheers"] },
  { char: "🎂", names: ["cake", "birthday"] },
  { char: "🌈", names: ["rainbow", "pride"] },
  { char: "⭐", names: ["star", "favorite"] },
  { char: "🌙", names: ["moon", "night"] },
  { char: "☀️", names: ["sun", "sunny"] },
  { char: "🌧️", names: ["rain", "rainy"] },
  { char: "🚀", names: ["rocket", "launch"] },
  { char: "💩", names: ["poop", "crap"] },
  { char: "🤖", names: ["robot", "bot"] },
  { char: "👻", names: ["ghost", "boo"] },
  { char: "🐐", names: ["goat", "greatest"] },
  { char: "🦆", names: ["duck", "quack"] },
];

export function searchEmojis(query: string): Emoji[] {
  const q = query.trim().toLowerCase();
  if (!q) return EMOJIS;
  return EMOJIS.filter((e) => e.names.some((n) => n.includes(q)));
}

// Replace :name: shortcodes in outgoing chat text with their emoji.
// Unknown names pass through untouched.
export function applyShortcodes(text: string): string {
  return text.replace(/:([a-z0-9_+-]+):/gi, (match, name: string) => {
    const hit = EMOJIS.find((e) => e.names.includes(name.toLowerCase()));
    return hit ? hit.char : match;
  });
}
