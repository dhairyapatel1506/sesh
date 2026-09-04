import { env } from "./db.js";

// "Keep playing something like this" once the queue runs dry.
//
// The obvious way to build this is gone: search.list used to take a
// relatedToVideoId and hand back YouTube's own related videos, and YouTube
// removed it in 2023 — it now answers 400. What still works, and is actually
// better, is the Mix: every video has an auto-generated radio playlist at
// RD<videoId>, and playlistItems.list will read it. That's YouTube's real
// recommendation engine rather than a guess assembled from tags, and it costs
// *one* quota unit against the 10,000/day allowance where a search costs a
// hundred. Autoplay would have been unaffordable the other way.

export type RadioPick = { videoId: string; title: string; channel: string };

const MIX_SIZE = 25;
// Mixes are personalised-ish and change slowly; a day is well inside how long
// one stays a sensible answer, and it keeps a long sesh down to a handful of
// API calls in total.
const MIX_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_MAX_ENTRIES = 300;
const EMPTY_CACHE_TTL_MS = 2 * 60 * 1000;

type Mix = { ids: string[]; fetchedAt: number };
const mixCache = new Map<string, Mix>();

// Whether a video can actually be played in an embedded player, which a mix
// makes no promise about. Cached forever within a process — it's a property of
// the video, not of when you asked.
type Details = { title: string; channel: string; playable: boolean };
const detailCache = new Map<string, Details>();

function remember<T>(cache: Map<string, T>, key: string, value: T): void {
  if (cache.size >= CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, value);
}

function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

async function mixFor(seed: string): Promise<string[]> {
  const cached = mixCache.get(seed);
  if (cached && Date.now() - cached.fetchedAt < MIX_CACHE_TTL_MS) return cached.ids;

  const key = env("YOUTUBE_API_KEY");
  if (!key) return [];

  const url = new URL("https://www.googleapis.com/youtube/v3/playlistItems");
  url.search = new URLSearchParams({
    part: "snippet",
    playlistId: `RD${seed}`,
    maxResults: String(MIX_SIZE),
    key,
  }).toString();

  const res = await fetch(url);
  let ids: string[] = [];
  // Not every video has a mix — YouTube only builds them for music. A 404
  // here is an ordinary answer, not a fault; what it means is "ask the
  // expensive way".
  if (res.ok) {
    const data = (await res.json()) as {
      items?: { snippet: { resourceId?: { videoId?: string }; title?: string } }[];
    };
    for (const item of data.items ?? []) {
      const id = item.snippet?.resourceId?.videoId;
      // A mix always opens with the video it was built from.
      if (!id || id === seed) continue;
      // "Deleted video" / "Private video" come back as real entries.
      const title = item.snippet?.title ?? "";
      if (title === "Deleted video" || title === "Private video") continue;
      ids.push(id);
    }
  }
  // No mix (YouTube only builds them for music): ask for what YouTube's own
  // watch page shows beside this video. Free, and right for every kind of
  // video.
  if (ids.length === 0) ids = await watchNextFor(seed);
  // An empty answer is remembered only briefly: it's as likely a stalled
  // request as a video with nothing beside it, and a day of "nothing to
  // suggest" for a stall is the wrong trade.
  const fetchedAt = ids.length > 0 ? Date.now() : Date.now() - MIX_CACHE_TTL_MS + EMPTY_CACHE_TTL_MS;
  remember(mixCache, seed, { ids, fetchedAt });
  return ids;
}

// The "Up next" column of YouTube's own watch page, fetched the way the page
// itself fetches it: the internal `next` endpoint, as an anonymous client.
// Unofficial, so parsed defensively — walk the whole response for anything
// shaped like a recommendation card rather than trusting one exact path —
// and any failure is an empty list, never an error. Costs no API quota, and
// unlike a mix it exists for every video.
//
// The watch page's HTML is asked first, then the endpoint under several
// client identities: from a datacenter address YouTube treats these
// differently (see watchNextFor), and the timing of each attempt is logged
// so the next such change is a log line, not a mystery.
const NEXT_CLIENTS = [
  {
    name: "WEB",
    client: { clientName: "WEB", clientVersion: "2.20240701.00.00" },
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  },
  {
    name: "MWEB",
    client: { clientName: "MWEB", clientVersion: "2.20240701.00.00" },
    ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  },
  {
    name: "TVHTML5",
    client: { clientName: "TVHTML5", clientVersion: "7.20240701.00.00" },
    ua: "Mozilla/5.0 (ChromiumStylePlatform) Cobalt/Version",
  },
];
const NEXT_ATTEMPT_TIMEOUT_MS = 6000;

// Every card shape YouTube has used for "up next" and the end screen.
function collectVideoIds(root: unknown, seed: string): string[] {
  const ids: string[] = [];
  const seen = new Set<string>([seed]);
  const add = (id: unknown) => {
    if (typeof id === "string" && /^[\w-]{11}$/.test(id) && !seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  };
  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    const obj = node as Record<string, any>;
    if (obj.compactVideoRenderer?.videoId) add(obj.compactVideoRenderer.videoId);
    else if (obj.videoWithContextRenderer?.videoId) add(obj.videoWithContextRenderer.videoId);
    else if (obj.endScreenVideoRenderer?.videoId) add(obj.endScreenVideoRenderer.videoId);
    else if (obj.lockupViewModel?.contentType === "LOCKUP_CONTENT_TYPE_VIDEO") add(obj.lockupViewModel.contentId);
    for (const value of Object.values(obj)) walk(value);
  };
  walk(root);
  return ids;
}

async function watchNextFor(seed: string): Promise<string[]> {
  // The watch page first: from Render's network every POST to the internal
  // endpoint stalled past its timeout, whatever client it claimed to be,
  // while a plain GET of the page answered in a second. The page embeds the
  // same data (ytInitialData), so it's the primary route and the endpoint is
  // the fallback for the day the page's markup changes.
  const pageStarted = Date.now();
  try {
    const res = await fetch(`https://www.youtube.com/watch?v=${seed}&hl=en`, {
      headers: { "user-agent": NEXT_CLIENTS[0].ua, "accept-language": "en-US,en;q=0.9" },
      signal: AbortSignal.timeout(NEXT_ATTEMPT_TIMEOUT_MS),
    });
    const html = await res.text();
    const match = html.match(/ytInitialData\s*=\s*(\{.*?\});\s*<\/script>/s);
    const ids = match ? collectVideoIds(JSON.parse(match[1]), seed) : [];
    console.log(`radio: watch-page gave ${ids.length} for ${seed} in ${Date.now() - pageStarted}ms (status ${res.status})`);
    if (ids.length > 0) return ids.slice(0, MIX_SIZE);
  } catch (err) {
    console.warn(`radio: watch-page failed after ${Date.now() - pageStarted}ms: ${(err as Error).message}`);
  }
  for (const attempt of NEXT_CLIENTS) {
    const started = Date.now();
    try {
      const res = await fetch("https://www.youtube.com/youtubei/v1/next?prettyPrint=false", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": attempt.ua,
          "accept-language": "en-US,en;q=0.9",
        },
        body: JSON.stringify({ context: { client: { ...attempt.client, hl: "en", gl: "US" } }, videoId: seed }),
        signal: AbortSignal.timeout(NEXT_ATTEMPT_TIMEOUT_MS),
      });
      const elapsed = Date.now() - started;
      if (!res.ok) {
        console.warn(`radio: watch-next ${attempt.name} answered ${res.status} in ${elapsed}ms`);
        continue;
      }
      const ids = collectVideoIds(await res.json(), seed);
      console.log(`radio: watch-next ${attempt.name} gave ${ids.length} for ${seed} in ${elapsed}ms`);
      if (ids.length > 0) return ids.slice(0, MIX_SIZE);
    } catch (err) {
      console.warn(`radio: watch-next ${attempt.name} failed after ${Date.now() - started}ms: ${(err as Error).message}`);
    }
  }
  return [];
}

// What videos.list has to be asked before believing a video will embed.
// status.embeddable alone lies twice over: an age-restricted video reports
// embeddable:true and then refuses to play embedded, and a region-locked one
// plays only in its allowed countries — the failing search result that
// prompted this was "public, embeddable", and watchable in exactly 4
// countries. Both failures show the same misleading "owner has disabled
// playback" error on screen, so they have to be caught here, before display.
export type VideoDetails = {
  status?: { embeddable?: boolean; privacyStatus?: string };
  contentDetails?: {
    contentRating?: { ytRating?: string };
    regionRestriction?: { allowed?: string[]; blocked?: string[] };
  };
};

// "Will this play embedded, for a general audience?" A room's viewers can be
// in different countries, so a video locked down to a small allowed-list is a
// broken tile for nearly everyone — the thresholds just separate "worldwide
// minus the odd dispute" from "four countries only".
export function embedPlayable(video: VideoDetails): boolean {
  if (video.status?.embeddable !== true || video.status?.privacyStatus !== "public") return false;
  if (video.contentDetails?.contentRating?.ytRating === "ytAgeRestricted") return false;
  const region = video.contentDetails?.regionRestriction;
  if (region?.allowed && region.allowed.length < 60) return false;
  if (region?.blocked && region.blocked.length > 130) return false;
  return true;
}

// One call covers up to 50 ids, so checking a whole mix is a single unit.
async function detailsFor(ids: string[]): Promise<void> {
  const missing = ids.filter((id) => !detailCache.has(id));
  if (missing.length === 0) return;
  const key = env("YOUTUBE_API_KEY");
  if (!key) return;

  const url = new URL("https://www.googleapis.com/youtube/v3/videos");
  url.search = new URLSearchParams({
    part: "snippet,status,contentDetails",
    id: missing.slice(0, 50).join(","),
    key,
  }).toString();

  const res = await fetch(url);
  if (!res.ok) return;
  const data = (await res.json()) as {
    items?: ({
      id: string;
      snippet: { title: string; channelTitle?: string; liveBroadcastContent?: string };
    } & VideoDetails)[];
  };
  for (const item of data.items ?? []) {
    remember(detailCache, item.id, {
      title: decodeEntities(item.snippet.title),
      channel: decodeEntities(item.snippet.channelTitle ?? ""),
      playable:
        embedPlayable(item) &&
        // A live stream has no end, so it would pin the room to one video
        // forever and quietly break the thing that called this.
        (item.snippet.liveBroadcastContent ?? "none") === "none",
    });
  }
  // Anything the API didn't return at all is gone; record that so it isn't
  // asked about again on the next track.
  for (const id of missing) {
    if (!detailCache.has(id)) remember(detailCache, id, { title: "", channel: "", playable: false });
  }
}

/**
 * The next thing to play after `seed`, avoiding anything in `exclude` (what
 * the room has already heard). Null means "nothing suitable" — the caller
 * should stop rather than invent something.
 */
export async function radioPick(seed: string, exclude: Set<string>): Promise<RadioPick | null> {
  const picks = await radioRelated(seed, exclude, 1);
  return picks[0] ?? null;
}

/**
 * The same lookup, but the whole shortlist: every playable video from the
 * seed's mix, in mix order. This is what "recommended after this video"
 * means here — YouTube's own answer, minus anything that can't actually play
 * in an embedded player, so nothing on screen is a dead end.
 */
export async function radioRelated(
  seed: string,
  exclude: Set<string>,
  limit: number,
): Promise<RadioPick[]> {
  try {
    const candidates = (await mixFor(seed)).filter((id) => !exclude.has(id));
    if (candidates.length === 0) return [];
    await detailsFor(candidates);
    const picks: RadioPick[] = [];
    for (const id of candidates) {
      const details = detailCache.get(id);
      if (details?.playable) picks.push({ videoId: id, title: details.title, channel: details.channel });
      if (picks.length >= limit) break;
    }
    return picks;
  } catch (err) {
    // A radio that fails is a room that stops, which is exactly where it would
    // have been without this. Never worth throwing over.
    console.error("radio lookup failed:", (err as Error).message);
    return [];
  }
}

export const radioAvailable = () => Boolean(env("YOUTUBE_API_KEY"));
