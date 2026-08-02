// Curated emoji set, searchable by name and usable as :shortcode: in chat.
// Kept curated rather than exhaustive — zero bundle weight, glyphs picked to
// render in ordinary terminal fonts, and the OS emoji keyboard covers the
// rest. (client/src/emoji.ts carries the original base set; the codes they
// share must keep meaning the same characters — the two workspaces share no
// package, so that's kept in sync by hand.)

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
  // ---- everything below joined in 0.7.0; the codes above are shipped API
  // and never change. Names must stay unique across the whole table:
  // applyShortcodes takes the first hit, so a duplicate would shadow one. ----
  // More faces.
  { char: "😀", names: ["grinning"] },
  { char: "😄", names: ["grin", "haha"] },
  { char: "😆", names: ["xd", "squint"] },
  { char: "😉", names: ["wink"] },
  { char: "😋", names: ["yum", "tasty"] },
  { char: "😜", names: ["tongue", "playful"] },
  { char: "😔", names: ["sad", "pensive"] },
  { char: "😩", names: ["weary", "ugh"] },
  { char: "🥺", names: ["pleading", "puppy_eyes"] },
  { char: "😳", names: ["flushed", "blushing"] },
  { char: "🤩", names: ["star_struck", "starry_eyes"] },
  { char: "🤢", names: ["nauseated", "sick"] },
  { char: "😷", names: ["mask", "masked"] },
  { char: "🤡", names: ["clown", "clowning"] },
  { char: "😈", names: ["devil", "evil"] },
  { char: "🥶", names: ["cold", "freezing"] },
  // More hands and bodies.
  { char: "👌", names: ["ok", "perfect"] },
  { char: "👊", names: ["fist_bump", "punch"] },
  { char: "🤘", names: ["rock_on", "horns"] },
  { char: "🤙", names: ["call_me", "shaka"] },
  { char: "🖕", names: ["middle_finger", "rude"] },
  { char: "💅", names: ["nails", "sassy"] },
  { char: "🤷", names: ["shrug", "dunno"] },
  { char: "🤦", names: ["facepalm", "smh"] },
  { char: "💃", names: ["dancing", "dancer"] },
  { char: "🕺", names: ["disco", "groove"] },
  // Hearts in every colour — ":hea" should have somewhere to go.
  { char: "💕", names: ["two_hearts"] },
  { char: "💖", names: ["sparkling_heart"] },
  { char: "💓", names: ["heartbeat"] },
  { char: "💘", names: ["cupid", "heart_arrow"] },
  { char: "💙", names: ["blue_heart"] },
  { char: "💚", names: ["green_heart"] },
  { char: "💛", names: ["yellow_heart"] },
  { char: "🧡", names: ["orange_heart"] },
  { char: "💜", names: ["purple_heart"] },
  { char: "🖤", names: ["black_heart"] },
  { char: "🤍", names: ["white_heart"] },
  // Animals.
  { char: "🐶", names: ["dog", "puppy"] },
  { char: "🐱", names: ["cat", "kitty"] },
  { char: "🦄", names: ["unicorn", "magical"] },
  { char: "🐸", names: ["frog", "ribbit"] },
  { char: "🙈", names: ["see_no_evil", "hiding"] },
  { char: "🐍", names: ["snake", "hiss"] },
  { char: "🐼", names: ["panda"] },
  { char: "🐧", names: ["penguin"] },
  { char: "🐝", names: ["bee", "buzz"] },
  // Food and drink.
  { char: "🍔", names: ["burger"] },
  { char: "🍟", names: ["fries"] },
  { char: "🌮", names: ["taco"] },
  { char: "🍣", names: ["sushi"] },
  { char: "🍜", names: ["ramen", "noodles"] },
  { char: "🍩", names: ["donut", "doughnut"] },
  { char: "🍪", names: ["cookie"] },
  { char: "🍌", names: ["banana"] },
  { char: "🥑", names: ["avocado", "guac"] },
  { char: "🍷", names: ["wine"] },
  { char: "🍵", names: ["tea", "matcha"] },
  // Music and games — it's a listening room, after all.
  { char: "🎧", names: ["headphones", "vibing"] },
  { char: "🎤", names: ["mic", "karaoke"] },
  { char: "🎸", names: ["guitar"] },
  { char: "🎹", names: ["piano", "keys"] },
  { char: "🔊", names: ["loud", "volume_up"] },
  { char: "🔇", names: ["muted", "silence"] },
  { char: "🎬", names: ["clapper", "action"] },
  { char: "🎮", names: ["gaming", "controller"] },
  { char: "🎲", names: ["dice", "random"] },
  { char: "🏆", names: ["trophy", "winner"] },
  { char: "🎯", names: ["bullseye", "target"] },
  { char: "⚽", names: ["soccer", "football"] },
  { char: "🏀", names: ["basketball", "hoops"] },
  // Symbols, weather, things.
  { char: "⚡", names: ["zap", "lightning"] },
  { char: "💥", names: ["boom", "bam"] },
  { char: "🌟", names: ["glowing_star", "superstar"] },
  { char: "❄️", names: ["snowflake", "chilly"] },
  { char: "🌊", names: ["ocean", "surf"] },
  { char: "🌸", names: ["blossom", "sakura"] },
  { char: "🌍", names: ["earth", "world"] },
  { char: "🔑", names: ["key"] },
  { char: "📈", names: ["stonks", "chart_up"] },
  { char: "📉", names: ["not_stonks", "chart_down"] },
  { char: "✅", names: ["check", "done"] },
  { char: "❌", names: ["x", "nope"] },
  { char: "⚠️", names: ["warning", "careful"] },
  { char: "❓", names: ["question", "huh"] },
  { char: "💤", names: ["snore", "sleepy"] },
  { char: "🎁", names: ["gift", "present"] },
  { char: "💰", names: ["money_bag", "rich"] },
  { char: "💎", names: ["gem", "diamond"] },
  { char: "✈️", names: ["airplane", "flight"] },
  { char: "🏠", names: ["home", "house"] },
];

export function searchEmojis(query: string): Emoji[] {
  const q = query.trim().toLowerCase();
  if (!q) return EMOJIS;
  return EMOJIS.filter((e) => e.names.some((n) => n.includes(q)));
}

// The same substring match, ordered for a suggestion list: names that *start*
// with what's typed come first, because ":hea" is almost always the beginning
// of a name and heart should beat sweat_smile to the top row.
export function matchEmojis(partial: string): Emoji[] {
  const q = partial.toLowerCase();
  const starts = (e: Emoji) => Number(e.names.some((n) => n.startsWith(q)));
  return EMOJIS.filter((e) => e.names.some((n) => n.includes(q))).sort((a, b) => starts(b) - starts(a));
}

// The half-typed :code: under the cursor (which in this input is always the
// end of the line), or null if the line doesn't end in one. Two characters
// minimum before anything is suggested — ":d" is usually a smiley being typed
// out as text, not a request. A finished pair like ":smile:" never matches:
// the final colon closes it, and there's no partial name after it.
export function emojiToken(line: string): string | null {
  const match = line.match(/(?:^|[^a-zA-Z0-9_+-]):([a-zA-Z0-9_+-]{2,})$/);
  return match ? match[1] : null;
}

// Replace :name: shortcodes in outgoing chat text with their emoji.
// Unknown names pass through untouched.
export function applyShortcodes(text: string): string {
  return text.replace(/:([a-z0-9_+-]+):/gi, (match, name: string) => {
    const hit = EMOJIS.find((e) => e.names.includes(name.toLowerCase()));
    return hit ? hit.char : match;
  });
}
