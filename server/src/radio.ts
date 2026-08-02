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
  // Not every video has a mix — a private upload, something obscure, a video
  // that's been taken down. A 404 here is an ordinary answer, not a fault.
  if (!res.ok) {
    remember(mixCache, seed, { ids: [], fetchedAt: Date.now() });
    return [];
  }
  const data = (await res.json()) as {
    items?: { snippet: { resourceId?: { videoId?: string }; title?: string } }[];
  };
  const ids: string[] = [];
  for (const item of data.items ?? []) {
    const id = item.snippet?.resourceId?.videoId;
    // A mix always opens with the video it was built from.
    if (!id || id === seed) continue;
    // "Deleted video" / "Private video" come back as real entries.
    const title = item.snippet?.title ?? "";
    if (title === "Deleted video" || title === "Private video") continue;
    ids.push(id);
  }
  remember(mixCache, seed, { ids, fetchedAt: Date.now() });
  return ids;
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
