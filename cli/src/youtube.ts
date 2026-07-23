import type { SearchResult } from "./types.js";

// Same pattern as the web client (client/src/youtube.ts).
export function extractVideoId(url: string): string | null {
  const match = url.match(
    /(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/,
  );
  if (match) return match[1];
  // A bare 11-char id is also accepted — handy at a prompt.
  return /^[a-zA-Z0-9_-]{11}$/.test(url) ? url : null;
}

// Keyless title lookup, same trick the web client uses for pasted links.
export async function fetchTitle(videoId: string): Promise<string | null> {
  try {
    const res = await fetch(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(
        `https://www.youtube.com/watch?v=${videoId}`,
      )}&format=json`,
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { title?: string };
    return data.title ?? null;
  } catch {
    return null;
  }
}

// Search goes through the sesh server's proxy (it holds the API key).
export async function search(serverUrl: string, query: string): Promise<SearchResult[]> {
  const res = await fetch(`${serverUrl}/api/search?q=${encodeURIComponent(query)}`);
  const data = (await res.json()) as { results?: SearchResult[]; error?: string };
  if (!res.ok) throw new Error(data.error ?? `search failed (${res.status})`);
  return data.results ?? [];
}

export function formatTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

// Accepts "90", "1:30" or "1:02:03".
export function parseTime(input: string): number | null {
  if (!/^\d+(:\d{1,2}){0,2}$/.test(input)) return null;
  return input.split(":").reduce((total, part) => total * 60 + Number(part), 0);
}
