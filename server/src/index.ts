import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import cors from "cors";
import { createServer } from "node:http";
import { Server, type Socket } from "socket.io";
import cookieParser from "cookie-parser";
import { parse as parseCookie } from "cookie";
import { dbEnabled, env, migrate, query } from "./db.js";
import {
  authEnabled,
  bearerToken,
  clearSessionCookie,
  getUser,
  issueSession,
  readSession,
  setSessionCookie,
  signInWithGoogle,
  withUser,
} from "./auth.js";
import {
  acceptFriend,
  acceptedFriendIds,
  areFriends,
  listFriends,
  removeFriend,
  requestFriend,
} from "./friends.js";
import {
  conversation,
  DM_RETENTION_DAYS,
  latestPerFriend,
  markRead,
  pruneOldMessages,
  sendDirect,
  unreadBySender,
} from "./dm.js";
import { approveLink, pollLink, startLink } from "./clilink.js";
import { embedPlayable, radioAvailable, radioPick, radioRelated, type RadioPick, type VideoDetails } from "./radio.js";
import { mailEnabled, sendReportMail } from "./mail.js";
import {
  decodeDataUrl,
  hashIp,
  listReports,
  pruneOldReports,
  REPORT_MAX_LENGTH,
  REPORT_MIN_LENGTH,
  reportImage,
  REPORT_RETENTION_DAYS,
  saveReport,
  vetReport,
} from "./reports.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Local dev keeps secrets in server/.env (gitignored); on Render they come
// from the dashboard instead and no .env file exists.
try {
  process.loadEnvFile(path.join(__dirname, "../.env"));
} catch {
  // No .env file — fine.
}

const PORT = process.env.PORT ? Number(process.env.PORT) : 3001;
const isProd = process.env.NODE_ENV === "production";
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;

const app = express();

if (!isProd) {
  // Vite dev server runs on a different port/origin than this API in dev.
  // credentials, or the session cookie is neither sent nor accepted across
  // that origin boundary and sign-in silently does nothing in dev only.
  app.use(cors({ origin: "http://localhost:5173", credentials: true }));
}

const httpServer = createServer(app);
const io = new Server(httpServer, {
  // credentials here too: the socket handshake carries the session cookie,
  // which is how presence knows who connected.
  cors: isProd ? undefined : { origin: "http://localhost:5173", credentials: true },
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.use(cookieParser());

// Bodies stay small everywhere except the one endpoint that carries a
// screenshot. Raising the limit globally would hand every other route a 4 MB
// budget it has no use for, which is a free way to make the server work hard.
const smallBody = express.json({ limit: "100kb" });
const reportBody = express.json({ limit: "4mb" });
app.use((req, res, next) =>
  (req.path === "/api/report" ? reportBody : smallBody)(req, res, next),
);
app.use(withUser);

// The client asks what sign-in is available rather than being built with it
// baked in: the client ID then lives in one place (the server's environment),
// and a deploy without one simply shows no sign-in button instead of a broken
// one. Not a secret — it's public by design, visible in any page that uses it.
app.get("/api/auth/config", (_req, res) => {
  res.json({
    enabled: authEnabled(),
    clientId: authEnabled() ? env("GOOGLE_CLIENT_ID") : null,
  });
});

app.get("/api/auth/me", async (req, res) => {
  if (!req.userId) return res.json({ user: null });
  try {
    res.json({ user: await getUser(req.userId) });
  } catch {
    res.json({ user: null });
  }
});

app.post("/api/auth/google", async (req, res) => {
  if (!authEnabled()) return res.status(503).json({ error: "sign-in isn't configured" });
  const credential = req.body?.credential;
  if (typeof credential !== "string") return res.status(400).json({ error: "no credential" });
  try {
    const user = await signInWithGoogle(credential);
    setSessionCookie(res, user.id);
    res.json({ user });
  } catch (err) {
    console.error("sign-in failed:", (err as Error).message);
    res.status(401).json({ error: "couldn't verify that sign-in" });
  }
});

app.post("/api/auth/logout", (_req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

// Which signed-in people are in which room, right now. In memory alongside the
// rooms themselves, not in the database: it describes this process's live
// connections, and a restart makes every word of it false.
//
// Two different questions live here, and conflating them was the original
// mistake: `presence` answers "which room are they watching in", `userSockets`
// answers "is Sesh open at all". Someone sitting on the homepage with nothing
// playing is *online* — which is the whole point of a friends list, and what
// makes it possible to message them or know an invite will land.
const presence = new Map<string, string>(); // userId -> roomId
const userSockets = new Map<string, Set<string>>(); // userId -> socket ids

const isOnline = (userId: string) => userSockets.has(userId);

// Tell a user's own tabs, and their friends' tabs, that something they render
// has changed. The client refetches rather than being handed a patch — the
// list is small and this way there's one code path that builds it.
async function notifyFriends(userId: string): Promise<void> {
  const audience = new Set<string>([userId]);
  try {
    for (const id of await acceptedFriendIds(userId)) audience.add(id);
  } catch {
    // Database hiccup — the periodic refetch still catches up.
  }
  for (const id of audience) {
    for (const socketId of userSockets.get(id) ?? []) {
      io.to(socketId).emit("friends:changed");
    }
  }
}

// Presence flaps. Signing in reconnects the socket on purpose, a laptop lid
// closes and reopens, a phone hops from wi-fi to data, and a page navigation
// between rooms is two events in quick succession. Announcing every edge as it
// happens makes a friends list blink offline and back for no reason anyone
// watching it could explain — so a presence change settles first, and one that
// reverses inside the window is never sent at all.
const PRESENCE_SETTLE_MS = 600;
const presenceTimers = new Map<string, ReturnType<typeof setTimeout>>();
const lastAnnounced = new Map<string, string>();

const presenceShape = (userId: string) =>
  `${isOnline(userId) ? "on" : "off"}:${presence.get(userId) ?? ""}`;

function notifyPresence(userId: string): void {
  clearTimeout(presenceTimers.get(userId));
  presenceTimers.set(
    userId,
    setTimeout(() => {
      presenceTimers.delete(userId);
      const shape = presenceShape(userId);
      // Offline-and-nowhere is the resting state, so it needs no stored entry —
      // which also keeps this map from growing one row per person who ever
      // connected.
      if ((lastAnnounced.get(userId) ?? "off:") === shape) return;
      if (shape === "off:") lastAnnounced.delete(userId);
      else lastAnnounced.set(userId, shape);
      void notifyFriends(userId);
    }, PRESENCE_SETTLE_MS).unref(),
  );
}

// Everyone who should be told about a message between two people: both ends,
// on every tab and terminal either of them has open.
function emitToUsers(userIds: string[], event: string, payload: unknown): void {
  for (const id of new Set(userIds)) {
    for (const socketId of userSockets.get(id) ?? []) {
      io.to(socketId).emit(event, payload);
    }
  }
}

const requireUser = (req: express.Request, res: express.Response): string | null => {
  if (!authEnabled()) {
    res.status(503).json({ error: "accounts aren't configured" });
    return null;
  }
  if (!req.userId) {
    res.status(401).json({ error: "sign in first" });
    return null;
  }
  return req.userId;
};

app.get("/api/friends", async (req, res) => {
  const userId = requireUser(req, res);
  if (!userId) return;
  try {
    const [friends, unread, latest] = await Promise.all([
      listFriends(userId),
      unreadBySender(userId),
      latestPerFriend(userId),
    ]);
    res.json({
      friends: friends.map((friend) => {
        // Only settled friends reveal anything about themselves. A pending
        // request must not become a way to watch someone — not where they are,
        // not whether they're at the keyboard.
        const settled = friend.status === "accepted";
        const last = latest.get(friend.id);
        return {
          ...friend,
          online: settled && isOnline(friend.id),
          roomId: settled ? (presence.get(friend.id) ?? null) : null,
          unread: settled ? (unread.get(friend.id) ?? 0) : 0,
          // Enough to sort the list by recency and show a one-line preview
          // without fetching every conversation up front.
          lastMessage: settled && last ? { text: last.text, at: last.at, mine: last.from === userId } : null,
        };
      }),
    });
  } catch (err) {
    console.error("friends list failed:", (err as Error).message);
    res.status(500).json({ error: "couldn't load your friends" });
  }
});

app.post("/api/friends/request", async (req, res) => {
  const userId = requireUser(req, res);
  if (!userId) return;
  try {
    const result = await requestFriend(userId, String(req.body?.code ?? ""));
    if (!result.ok) return res.status(400).json({ error: result.error });
    await notifyFriends(userId);
    // The person who was asked won't be in notifyFriends' audience until the
    // request is accepted, so tell their tabs directly.
    const target = await query<{ id: string }>("select id from users where friend_code = $1", [
      String(req.body?.code ?? "").trim().toUpperCase(),
    ]);
    for (const socketId of userSockets.get(target[0]?.id ?? "") ?? []) {
      io.to(socketId).emit("friends:changed");
    }
    res.json({ ok: true });
  } catch (err) {
    console.error("friend request failed:", (err as Error).message);
    res.status(500).json({ error: "couldn't send that request" });
  }
});

app.post("/api/friends/accept", async (req, res) => {
  const userId = requireUser(req, res);
  if (!userId) return;
  const otherId = String(req.body?.userId ?? "");
  try {
    const accepted = await acceptFriend(userId, otherId);
    if (!accepted) return res.status(400).json({ error: "no request to accept" });
    await notifyFriends(userId);
    res.json({ ok: true });
  } catch (err) {
    console.error("friend accept failed:", (err as Error).message);
    res.status(500).json({ error: "couldn't accept that" });
  }
});

app.post("/api/friends/remove", async (req, res) => {
  const userId = requireUser(req, res);
  if (!userId) return;
  const otherId = String(req.body?.userId ?? "");
  try {
    // Collect the audience before deleting, or the person being removed never
    // hears about it and keeps showing a friend who's gone.
    const audience = await acceptedFriendIds(userId);
    await removeFriend(userId, otherId);
    for (const id of new Set([userId, otherId, ...audience])) {
      for (const socketId of userSockets.get(id) ?? []) {
        io.to(socketId).emit("friends:changed");
      }
    }
    res.json({ ok: true });
  } catch (err) {
    console.error("friend remove failed:", (err as Error).message);
    res.status(500).json({ error: "couldn't do that" });
  }
});

// ---- Direct messages ------------------------------------------------------
// Sending and reading live on the socket (below) — this is only the scrollback
// you get when you open a conversation, which is a request/response shape and
// has no business being an event.
app.get("/api/dm/:userId", async (req, res) => {
  const userId = requireUser(req, res);
  if (!userId) return;
  const otherId = String(req.params.userId ?? "");
  try {
    // Friends only, checked here rather than assumed from the fact that you
    // know someone's id — ids travel in every friends list you've ever been in.
    if (!(await areFriends(userId, otherId))) {
      return res.status(403).json({ error: "you two aren't friends" });
    }
    const before = req.query.before ? Number(req.query.before) : undefined;
    const messages = await conversation(userId, otherId, Number.isFinite(before!) ? before : undefined);
    // Opening a conversation is reading it.
    if (await markRead(userId, otherId)) emitToUsers([userId], "friends:changed", undefined);
    res.json({ messages, retentionDays: DM_RETENTION_DAYS });
  } catch (err) {
    console.error("dm history failed:", (err as Error).message);
    res.status(500).json({ error: "couldn't load that conversation" });
  }
});

// ---- Linking a terminal ---------------------------------------------------
// The CLI shows a code; you approve it from a browser that's already signed in.
// See server/src/clilink.ts for why it works this way.
app.post("/api/auth/cli/start", (_req, res) => {
  if (!authEnabled()) return res.status(503).json({ error: "accounts aren't configured" });
  const { code, pollToken, expiresAt } = startLink();
  res.json({ code, pollToken, expiresAt });
});

app.post("/api/auth/cli/approve", (req, res) => {
  const userId = requireUser(req, res);
  if (!userId) return;
  if (!approveLink(String(req.body?.code ?? ""), userId)) {
    return res.status(400).json({ error: "that code has expired or was already used" });
  }
  res.json({ ok: true });
});

app.post("/api/auth/cli/poll", async (req, res) => {
  if (!authEnabled()) return res.status(503).json({ error: "accounts aren't configured" });
  const result = pollLink(String(req.body?.pollToken ?? ""));
  if (result.status !== "approved") return res.json({ status: result.status });
  try {
    const user = await getUser(result.userId);
    if (!user) return res.status(500).json({ error: "that account is gone" });
    // The very same signed string the browser gets in a cookie. The terminal
    // just has to store it itself.
    res.json({ status: "approved", token: issueSession(result.userId), user });
  } catch (err) {
    console.error("cli poll failed:", (err as Error).message);
    res.status(500).json({ error: "couldn't finish signing in" });
  }
});

// ---- Bug reports ----------------------------------------------------------
// Deliberately open to anonymous reporters — the people most likely to hit a
// bug are the ones who never signed in — which is why server/src/reports.ts is
// mostly limits rather than storage.
app.post("/api/report", async (req, res) => {
  if (!dbEnabled()) return res.status(503).json({ error: "reports aren't set up on this server" });

  // Behind Render's proxy the socket address is the proxy's. Express only
  // trusts the forwarded header when told to, and taking the first entry is
  // right because anything after it is client-supplied.
  const forwarded = String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim();
  const ipHash = hashIp(forwarded || req.socket.remoteAddress || "unknown");

  const text = String(req.body?.text ?? "");
  const image = decodeDataUrl(req.body?.image);
  if (req.body?.image && !image) {
    return res.status(400).json({ error: "That attachment didn't look like an image." });
  }

  const verdict = vetReport({ text, ipHash, image, userId: req.userId ?? null });
  if (!verdict.ok) return res.status(verdict.status).json({ error: verdict.error });

  try {
    const roomId = typeof req.body?.roomId === "string" ? req.body.roomId.slice(0, 12) : null;
    const id = await saveReport({
      text,
      client: req.body?.client === "cli" ? "cli" : "web",
      ipHash,
      userId: req.userId ?? null,
      roomId,
      userAgent: req.headers["user-agent"] ?? null,
      image,
    });
    res.json({ ok: true });

    // After the response, and never allowed to affect it: the report is
    // already stored and the person has already been thanked, so a mail
    // provider having a bad afternoon is not their problem.
    if (mailEnabled()) {
      const reporter = req.userId ? ((await getUser(req.userId).catch(() => null))?.name ?? null) : null;
      void sendReportMail({
        id,
        text,
        client: req.body?.client === "cli" ? "cli" : "web",
        roomId,
        reporter,
        userAgent: (req.headers["user-agent"] as string | undefined) ?? null,
        image,
        dashboardUrl: statsToken() ? `${publicOrigin(req)}/admin?token=${statsToken()}` : null,
      });
    }
  } catch (err) {
    console.error("bug report failed:", (err as Error).message);
    res.status(500).json({ error: "couldn't file that — sorry" });
  }
});

// What the client should tell people before they type: the same numbers the
// server enforces, so the two can't drift apart.
app.get("/api/report/limits", (_req, res) => {
  res.json({
    enabled: dbEnabled(),
    minLength: REPORT_MIN_LENGTH,
    maxLength: REPORT_MAX_LENGTH,
    imageMaxBytes: 2 * 1024 * 1024,
    retentionDays: REPORT_RETENTION_DAYS,
  });
});

// Reading them back is behind the same token the stats endpoint uses — these
// contain screenshots of whatever someone had on screen.
const statsToken = () =>
  String(process.env.STATS_TOKEN ?? "").trim().replace(/^["']|["']$/g, "");

// The origin as the outside world sees it. Behind Render's proxy the socket
// says http and a private host, so a link built from it would be unreachable
// by the person reading the email.
const publicOrigin = (req: express.Request): string => {
  const proto = String(req.headers["x-forwarded-proto"] ?? "").split(",")[0] || req.protocol;
  const host = String(req.headers["x-forwarded-host"] ?? req.headers.host ?? "");
  return `${proto}://${host}`;
};

const withStatsToken = (req: express.Request, res: express.Response): boolean => {
  const token = statsToken();
  const given = String(req.query.token ?? "").trim().replace(/^["']|["']$/g, "");
  if (!token) {
    res.status(503).json({ error: "set STATS_TOKEN to enable this" });
    return false;
  }
  if (given !== token) {
    res.status(403).json({ error: "bad token" });
    return false;
  }
  return true;
};

app.get("/api/reports", async (req, res) => {
  if (!withStatsToken(req, res)) return;
  try {
    res.json({ reports: await listReports(Number(req.query.limit ?? 50)) });
  } catch (err) {
    console.error("listing reports failed:", (err as Error).message);
    res.status(500).json({ error: "couldn't read those" });
  }
});

app.get("/api/reports/:id/image", async (req, res) => {
  if (!withStatsToken(req, res)) return;
  try {
    const image = await reportImage(String(req.params.id));
    if (!image) return res.status(404).json({ error: "no image on that report" });
    res.type(image.mime).send(image.data);
  } catch (err) {
    console.error("reading a report image failed:", (err as Error).message);
    res.status(500).json({ error: "couldn't read that" });
  }
});

// Somewhere to actually read them. Server-rendered rather than a route in the
// client, so it stays out of the public bundle entirely and needs no sign-in
// machinery of its own — the token in the URL is the whole gate, which is the
// same bargain /api/stats already makes.
//
// Everything interpolated below goes through escapeHtml first. It's all
// attacker-controlled: a report body is a stranger's text, and the one page
// certain to display it is this one.
const escapeHtml = (value: unknown): string =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

app.get("/admin", async (req, res) => {
  if (!withStatsToken(req, res)) return;
  if (!dbEnabled()) return res.status(503).send("No database configured.");
  const token = encodeURIComponent(statsToken());
  try {
    const reports = await listReports(200);
    const rows = reports
      .map((report) => {
        const when = new Date(report.at).toISOString().replace("T", " ").slice(0, 16);
        const meta = [
          report.reporter ? escapeHtml(report.reporter) : "signed out",
          escapeHtml(report.client),
          report.roomId ? `room ${escapeHtml(report.roomId)}` : "no room",
          when,
        ].join(" · ");
        return `<article>
  <p class="meta">${meta}</p>
  <p class="body">${escapeHtml(report.body)}</p>
  ${report.hasImage ? `<a href="/api/reports/${encodeURIComponent(report.id)}/image?token=${token}"><img src="/api/reports/${encodeURIComponent(report.id)}/image?token=${token}" alt="screenshot"></a>` : ""}
  <p class="ua">${escapeHtml(report.userAgent ?? "")}</p>
</article>`;
      })
      .join("\n");

    res.type("html").send(`<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sesh — bug reports</title>
<style>
  :root { color-scheme: light dark; --line: #8883; }
  body { font: 15px/1.5 system-ui, sans-serif; max-width: 46rem; margin: 2rem auto; padding: 0 1rem; }
  h1 { font-size: 1.1rem; }
  .empty { opacity: .7; }
  article { border-top: 1px solid var(--line); padding: 1rem 0; }
  .meta { font-size: .8rem; opacity: .7; margin: 0 0 .4rem; }
  .body { margin: 0 0 .6rem; white-space: pre-wrap; overflow-wrap: anywhere; }
  .ua { font-size: .7rem; opacity: .45; margin: .5rem 0 0; overflow-wrap: anywhere; }
  img { max-width: 100%; border-radius: 8px; border: 1px solid var(--line); }
</style>
</head><body>
<h1>Bug reports <span class="meta">${reports.length} kept · deleted after ${REPORT_RETENTION_DAYS} days</span></h1>
${rows || '<p class="empty">Nothing reported yet.</p>'}
</body></html>`);
  } catch (err) {
    console.error("admin page failed:", (err as Error).message);
    res.status(500).send("Couldn't read those.");
  }
});

// Live traffic, straight from the process that already sees it all. Guarded
// by STATS_TOKEN (set it in the Render dashboard; without it the endpoint
// stays off). Counters are in-memory and reset on every deploy — same
// lifetime as the rooms themselves.
const serverStartedAt = Date.now();
let pageViews = 0;

app.get("/api/stats", (req, res) => {
  // Pasted env values grow invisible whitespace (and sometimes quotes) —
  // compare the meaningful characters, not the paste accidents.
  const clean = (v: unknown) => String(v ?? "").trim().replace(/^["']|["']$/g, "");
  const token = clean(process.env.STATS_TOKEN);
  if (!token) return res.status(503).json({ error: "stats disabled — set STATS_TOKEN" });
  if (clean(req.query.token) !== token) return res.status(403).json({ error: "bad token" });
  res.json({
    now: Date.now(),
    serverStartedAt,
    pageViewsSinceBoot: pageViews,
    connectedSockets: io.engine.clientsCount,
    rooms: [...rooms.entries()].map(([roomId, room]) => ({
      roomId,
      upForMs: Date.now() - room.createdAt,
      users: [...room.users.values()].map((u) => u.name),
      videoId: room.state.videoId,
      isPlaying: room.state.isPlaying,
      queued: room.queue.length,
    })),
  });
});

type SearchResult = {
  videoId: string;
  title: string;
  channel: string;
  thumbnail: string;
  duration: string;
};

// A search.list call costs 100 of the API's 10,000 free daily quota units
// (~100 searches/day), so repeated queries are served from this cache.
const searchCache = new Map<string, { results: SearchResult[]; fetchedAt: number }>();
const SEARCH_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const SEARCH_CACHE_MAX_ENTRIES = 500;

// The API reports durations as ISO 8601, e.g. "PT1H2M3S".
function formatDuration(iso: string): string {
  const match = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return "";
  const hours = match[1];
  const minutes = match[2] ?? "0";
  const seconds = (match[3] ?? "0").padStart(2, "0");
  if (hours) return `${hours}:${minutes.padStart(2, "0")}:${seconds}`;
  return `${minutes}:${seconds}`;
}

// Snippet titles come back with HTML entities still encoded.
function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

type YouTubeSearchItem = {
  id: { videoId: string };
  snippet: {
    title: string;
    channelTitle: string;
    thumbnails: { medium?: { url: string }; default?: { url: string } };
  };
};

app.get("/api/search", async (req, res) => {
  const query = String(req.query.q ?? "").trim();
  if (!query) {
    res.status(400).json({ error: "Type something to search for." });
    return;
  }
  if (!YOUTUBE_API_KEY) {
    res.status(503).json({ error: "Search isn't set up on this server — paste a YouTube link instead." });
    return;
  }

  const cacheKey = query.toLowerCase();
  const cached = searchCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < SEARCH_CACHE_TTL_MS) {
    res.json({ results: cached.results });
    return;
  }

  try {
    const searchUrl = new URL("https://www.googleapis.com/youtube/v3/search");
    searchUrl.search = new URLSearchParams({
      part: "snippet",
      type: "video",
      videoEmbeddable: "true",
      maxResults: "8",
      q: query,
      key: YOUTUBE_API_KEY,
    }).toString();
    const searchRes = await fetch(searchUrl);
    if (searchRes.status === 403) {
      // Almost always quota exhaustion (resets midnight Pacific).
      res.status(429).json({ error: "Daily search limit reached — paste a YouTube link instead." });
      return;
    }
    if (!searchRes.ok) throw new Error(`search.list responded ${searchRes.status}`);
    const searchData = (await searchRes.json()) as { items?: YouTubeSearchItem[] };
    const items = (searchData.items ?? []).filter((item) => item.id?.videoId);

    // One extra unit fetches durations for all results at once — and, since
    // the same call can carry `status`, whether each result can actually play
    // in an embedded player. search.list's own videoEmbeddable filter is
    // famously leaky: embed-blocked uploads sail through it and then die on
    // screen with "the owner has disabled playback on other sites". videos.list
    // is the authority, so anything it marks unembeddable (or non-public) is
    // dropped here rather than shown as a result that can't work.
    const durations = new Map<string, string>();
    const playable = new Set<string>();
    let vetted = false;
    const ids = items.map((item) => item.id.videoId).join(",");
    if (ids) {
      const videosUrl = new URL("https://www.googleapis.com/youtube/v3/videos");
      videosUrl.search = new URLSearchParams({
        part: "contentDetails,status",
        id: ids,
        key: YOUTUBE_API_KEY,
      }).toString();
      const videosRes = await fetch(videosUrl);
      if (videosRes.ok) {
        vetted = true;
        const videosData = (await videosRes.json()) as {
          items?: ({ id: string; contentDetails: { duration: string } } & VideoDetails)[];
        };
        for (const video of videosData.items ?? []) {
          durations.set(video.id, formatDuration(video.contentDetails.duration));
          // The same bar the radio holds its picks to — see embedPlayable for
          // the two ways status.embeddable alone turned out to be a lie.
          if (embedPlayable(video)) playable.add(video.id);
        }
      }
    }

    // Only filter on an answer actually received — if videos.list failed,
    // unvetted results beat no results.
    const kept = vetted ? items.filter((item) => playable.has(item.id.videoId)) : items;

    const results: SearchResult[] = kept.map((item) => ({
      videoId: item.id.videoId,
      title: decodeEntities(item.snippet.title),
      channel: decodeEntities(item.snippet.channelTitle),
      thumbnail: item.snippet.thumbnails.medium?.url ?? item.snippet.thumbnails.default?.url ?? "",
      duration: durations.get(item.id.videoId) ?? "",
    }));

    if (searchCache.size >= SEARCH_CACHE_MAX_ENTRIES) {
      const oldest = searchCache.keys().next().value;
      if (oldest !== undefined) searchCache.delete(oldest);
    }
    searchCache.set(cacheKey, { results, fetchedAt: Date.now() });
    res.json({ results });
  } catch (err) {
    console.error("search failed:", err);
    res.status(502).json({ error: "YouTube search failed — try again in a moment." });
  }
});

// What YouTube would play after this video — the same mix the radio draws
// from, already filtered down to videos that can actually play embedded. The
// client's end screen shows these instead of YouTube's own wall, whose tiles
// can only open youtube.com in another tab. Thumbnails come straight off
// YouTube's image CDN by id: no API call, no quota.
app.get("/api/related", async (req, res) => {
  const videoId = String(req.query.videoId ?? "").trim();
  if (!/^[\w-]{11}$/.test(videoId)) {
    res.status(400).json({ error: "That doesn't look like a YouTube video id." });
    return;
  }
  if (!radioAvailable()) {
    res.status(503).json({ error: "Recommendations aren't set up on this server." });
    return;
  }
  const picks = await radioRelated(videoId, new Set(), 8);
  res.json({
    results: picks.map((pick) => ({
      videoId: pick.videoId,
      title: pick.title,
      channel: pick.channel,
      thumbnail: `https://i.ytimg.com/vi/${pick.videoId}/mqdefault.jpg`,
    })),
  });
});

type RoomState = {
  videoId: string | null;
  isPlaying: boolean;
  time: number;
  updatedAt: number;
};

type RoomUser = {
  name: string;
  socketId: string;
};

type ChatMessage = {
  id: string;
  senderId: string; // clientId — lets each tab recognize its own messages
  name: string;
  text: string;
  at: number;
};

type QueueItem = {
  id: string;
  videoId: string;
  title: string | null; // the adding client resolves this (search/oembed)
  addedBy: string;
};

// A server-initiated video switch in flight: every tab is pre-buffering the
// video paused, and playback begins once all of them report video:ready (or
// the timeout fires, so one stuck/hidden tab can't hold the room hostage).
type PendingStart = {
  videoId: string;
  waiting: Set<string>; // clientIds yet to report ready
  timer: ReturnType<typeof setTimeout>;
  startedAt: number; // for the ceiling on extensions — see video:preparing
};

// What the room has watched, newest first, for going back to something.
type HistoryEntry = { videoId: string; title: string | null; at: number };
const HISTORY_LIMIT = 20;

type Room = {
  state: RoomState;
  history: HistoryEntry[];
  users: Map<string, RoomUser>; // clientId -> user
  messages: ChatMessage[];
  queue: QueueItem[];
  pendingStart: PendingStart | null;
  createdAt: number; // when the room came into existence — drives the uptime display
  // Keep playing something similar when the queue runs out. On unless someone
  // turns it off: the alternative at that exact moment is silence and going
  // back to the search box, which is the thing this exists to avoid. It can
  // only ever engage on an empty queue, so it never overrides a decision
  // anybody actually made.
  autoplay: boolean;
  // What this room has already played, newest last, so radio doesn't circle
  // back to the same handful of tracks. Trimmed — it's a memory of a sitting,
  // not a history.
  played: string[];
  // A radio lookup is async, and every client reports the same video ending.
  // Without this, three reports become three lookups and the room starts the
  // third one's answer.
  radioPending: boolean;
  // What radio would play after the current video, decided when the video
  // *starts* rather than when it ends — so clients can show "up next" the way
  // YouTube does, and the end-of-video handoff doesn't wait on a lookup. The
  // seed records which video the pick was made for: a stale pick (the room
  // moved on mid-lookup) must never be trusted at the next ending.
  upnext: { seed: string; pick: RadioPick } | null;
};

const CHAT_MAX_LENGTH = 500;
// Spam control: at most this many messages per window, per sender.
const CHAT_BURST_LIMIT = 5;
const CHAT_BURST_WINDOW_MS = 5000;
// Chat is as ephemeral as the room itself (gone when the last person
// leaves); the cap just keeps a long sesh from growing memory unbounded.
const CHAT_HISTORY_LIMIT = 100;
const QUEUE_LIMIT = 50;
const QUEUE_TITLE_MAX_LENGTH = 200;

// Last time each (person, video) pair was queued, to swallow double-fired
// clicks. Small and self-pruning — see below.
const DUPLICATE_QUEUE_WINDOW_MS = 2000;
const recentQueueAdds = new Map<string, number>();
setInterval(() => {
  const cutoff = Date.now() - DUPLICATE_QUEUE_WINDOW_MS;
  for (const [key, at] of recentQueueAdds) if (at < cutoff) recentQueueAdds.delete(key);
}, 30_000).unref();
// How long a synchronized start waits for stragglers to finish buffering.
const PREPARE_TIMEOUT_MS = 8000;
// ...unless a client keeps saying it's still loading (video:preparing), which
// extends the wait a window at a time up to this ceiling.
const PREPARE_MAX_WAIT_MS = 45000;

const rooms = new Map<string, Room>();

function getOrCreateRoom(roomId: string): Room {
  let room = rooms.get(roomId);
  if (!room) {
    room = {
      state: { videoId: null, isPlaying: false, time: 0, updatedAt: Date.now() },
      history: [],
      users: new Map(),
      messages: [],
      queue: [],
      pendingStart: null,
      createdAt: Date.now(),
      autoplay: true,
      played: [],
      radioPending: false,
      upnext: null,
    };
    rooms.set(roomId, room);
  }
  return room;
}

// A socket only ever belongs to the one room it joined.
function currentRoom(socket: Socket): Room | undefined {
  const roomId = socket.data.roomId as string | undefined;
  if (!roomId) return undefined;
  return rooms.get(roomId);
}

// `time` is only ever a snapshot from the last play/pause action, not a
// live clock. While playing, extrapolate how far the video has actually
// progressed since that snapshot so late joiners land in the right spot.
// `at` stamps when (in server-clock ms) `time` was accurate, so clients —
// which sync their clocks to ours via clock:ping — can extrapolate the
// remaining network latency out of it themselves.
function estimatedRoomState(room: Room) {
  const now = Date.now();
  const { videoId, isPlaying, time, updatedAt } = room.state;
  return {
    videoId,
    isPlaying,
    time: isPlaying ? time + (now - updatedAt) / 1000 : time,
    at: now,
    createdAt: room.createdAt,
  };
}

function userList(room: Room) {
  return Array.from(room.users, ([clientId, user]) => ({ id: clientId, name: user.name }));
}

function cancelPendingStart(room: Room) {
  if (!room.pendingStart) return;
  clearTimeout(room.pendingStart.timer);
  room.pendingStart = null;
}

// The barrier opens: every tab (hopefully) has the video buffered and paused
// at 0, so one broadcast starts them all at the same instant.
// When a play/pause actually happened, as opposed to when its packet arrived.
// Clients send the moment on the server's own clock (they run an NTP-style
// sync at join), because stamping on arrival buries one-way latency in the
// room's anchor: everyone then reads the room as being that far behind, and
// their drift correction dutifully slows the video down to "catch up" with a
// past that never existed. Clamped both ways, so a wrong clock — or a client
// making things up — can shift the room by at most a moment.
const CLAIM_WINDOW_MS = 2000;

function stampedAt(claimed?: number): number {
  const now = Date.now();
  if (typeof claimed !== "number" || !Number.isFinite(claimed)) return now;
  return Math.min(now, Math.max(now - CLAIM_WINDOW_MS, claimed));
}

function beginPendingStart(roomId: string, room: Room) {
  const pending = room.pendingStart;
  if (!pending) return;
  cancelPendingStart(room);
  const at = Date.now();
  room.state = { videoId: pending.videoId, isPlaying: true, time: 0, updatedAt: at };
  io.to(roomId).emit("video:play", { time: 0, at, videoId: pending.videoId });
}

// Server-initiated playback switch (auto-advance, play-from-queue). Unlike a
// user's video:load — where the loader's own click plays their tab right away
// and everyone else chases it — nobody's player is on this video yet, so
// there's a chance to start everyone together: tell all tabs to pre-buffer it
// paused (video:prepare), collect their video:ready reports, and only then
// broadcast the play. Without the barrier, each tab starts as soon as its own
// buffering finishes — fast tabs run ahead while slow ones stall, then jump.
const PLAYED_MEMORY = 60;

function rememberPlayed(room: Room, videoId: string) {
  if (room.played[room.played.length - 1] === videoId) return;
  room.played.push(videoId);
  if (room.played.length > PLAYED_MEMORY) room.played.shift();
}

// Titles for the history list, without spending API quota: YouTube's oEmbed
// endpoint answers for any public video, keyless. Cached per process — a
// title is a property of the video, not of when you asked.
const titleCache = new Map<string, string | null>();
async function titleFor(videoId: string): Promise<string | null> {
  const cached = titleCache.get(videoId);
  if (cached !== undefined) return cached;
  let title: string | null = null;
  try {
    const url =
      "https://www.youtube.com/oembed?format=json&url=" +
      encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`);
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (res.ok) title = ((await res.json()) as { title?: string }).title ?? null;
  } catch {
    // Keyless and best-effort: a history entry without a title still plays.
  }
  if (titleCache.size > 1000) titleCache.delete(titleCache.keys().next().value!);
  titleCache.set(videoId, title);
  return title;
}

// Every video the room starts goes to the front of its history — once, so
// replaying something moves it up rather than listing it twice.
function recordHistory(roomId: string, room: Room, videoId: string) {
  const existing = room.history.find((entry) => entry.videoId === videoId);
  const entry: HistoryEntry = { videoId, title: existing?.title ?? null, at: Date.now() };
  room.history = [entry, ...room.history.filter((e) => e.videoId !== videoId)].slice(0, HISTORY_LIMIT);
  io.to(roomId).emit("history:state", room.history);
  if (entry.title !== null) return;
  void titleFor(videoId).then((title) => {
    if (title === null || rooms.get(roomId) !== room) return;
    const current = room.history.find((e) => e.videoId === videoId);
    if (!current || current.title !== null) return;
    current.title = title;
    io.to(roomId).emit("history:state", room.history);
  });
}

function startVideoForRoom(roomId: string, room: Room, videoId: string) {
  cancelPendingStart(room);
  rememberPlayed(room, videoId);
  recordHistory(roomId, room, videoId);
  room.state = { videoId, isPlaying: false, time: 0, updatedAt: Date.now() };
  room.pendingStart = {
    videoId,
    waiting: new Set(room.users.keys()),
    timer: setTimeout(() => beginPendingStart(roomId, room), PREPARE_TIMEOUT_MS),
    startedAt: Date.now(),
  };
  io.to(roomId).emit("video:prepare", { videoId });
  prepareUpnext(roomId, room, videoId);
}

// Decide "up next" while the current video is still playing. rememberPlayed
// has already run, so this pick and the one an ending would compute see the
// same exclude set — same mix, same cache, same answer. That's what lets the
// ending reuse it without a lookup.
function prepareUpnext(roomId: string, room: Room, videoId: string) {
  room.upnext = null;
  io.to(roomId).emit("radio:upnext", null);
  if (!room.autoplay || !radioAvailable()) return;
  void radioPick(videoId, new Set(room.played)).then((pick) => {
    // The room may have moved on (or been torn down) while the lookup was out.
    if (rooms.get(roomId) !== room || room.state.videoId !== videoId) return;
    if (!pick) return;
    room.upnext = { seed: videoId, pick };
    io.to(roomId).emit("radio:upnext", pick);
  });
}

// A socket carries the same session cookie the page does — the handshake is a
// normal HTTP request. Reading it here means presence knows *who* connected,
// not just that someone did, without the client asserting an identity it could
// simply make up.
io.use((socket, next) => {
  if (authEnabled()) {
    try {
      const header = socket.handshake.headers.cookie;
      const parsed = header ? parseCookie(header) : {};
      // The terminal has no cookie to send, so it puts the same signed string
      // in the handshake's auth payload instead. Both roads, one identity.
      const token =
        parsed["sesh_session"] ??
        (typeof socket.handshake.auth?.token === "string" ? socket.handshake.auth.token : undefined) ??
        bearerToken(socket.handshake.headers.authorization);
      socket.data.userId = readSession(token) ?? undefined;
    } catch {
      // Unsigned or unreadable — connect as anonymous, same as signed out.
    }
  }
  next();
});

io.on("connection", (socket) => {
  console.log(`client connected: ${socket.id}`);

  const userId = socket.data.userId as string | undefined;
  if (userId) {
    let sockets = userSockets.get(userId);
    if (!sockets) userSockets.set(userId, (sockets = new Set()));
    sockets.add(socket.id);
    // Having Sesh open at all is the thing friends want to know about — this
    // fires whether or not a room is ever joined.
    notifyPresence(userId);
  }

  socket.on(
    "room:join",
    ({ roomId, name, clientId }: { roomId: string; name: string; clientId: string }) => {
      // Moving straight from one room to another (the client is a single page
      // app — no reconnect happens in between) must vacate the old one first,
      // or this socket stays a member of both: still listed to the people it
      // left, and receiving their playback events on top of its new room's.
      if (socket.data.roomId && socket.data.roomId !== roomId) leaveRoom();

      const room = getOrCreateRoom(roomId);
      // Until real accounts exist, a name IS a person within a room — a
      // second client can't take one that's in use. Same clientId is fine:
      // that's the same user rejoining/reconnecting, not a collision.
      const wanted = (typeof name === "string" ? name : "").trim();
      const taken = [...room.users.entries()].some(
        ([id, user]) => id !== clientId && user.name.toLowerCase() === wanted.toLowerCase(),
      );
      if (taken) {
        socket.emit("room:join-denied", {
          reason: `"${wanted}" is already taken in this room — pick another name`,
        });
        return;
      }

      socket.data.roomId = roomId;
      if (socket.data.userId) {
        presence.set(socket.data.userId as string, roomId);
        notifyPresence(socket.data.userId as string);
      }
      socket.data.clientId = clientId;
      socket.join(roomId);

      // Keyed by a stable per-tab clientId (not socket.id) so a reconnect
      // (new socket.id) updates this user's existing entry instead of
      // appearing as a duplicate until the old socket's disconnect fires.
      room.users.set(clientId, { name: wanted, socketId: socket.id });

      socket.emit("room:state", estimatedRoomState(room));
      // Late joiners (and reconnects) get what was said before they arrived.
      socket.emit("chat:history", room.messages);
      socket.emit("queue:state", room.queue);
      socket.emit("history:state", room.history);
      socket.emit("radio:state", { autoplay: room.autoplay, available: radioAvailable() });
      // Broadcast only on change, so an arrival has to be told what's up next.
      socket.emit("radio:upnext", room.upnext?.pick ?? null);
      io.to(roomId).emit("room:users", userList(room));
    },
  );

  socket.on("video:load", ({ videoId }: { videoId: string }) => {
    const room = currentRoom(socket);
    if (!room) return;
    // A user picking a video overrides any synchronized start in flight.
    cancelPendingStart(room);
    // The loader's own click reliably starts playback right away (it's a
    // real gesture, so autoplay isn't blocked). Mark the room as playing
    // immediately rather than waiting for a separate video:play event —
    // otherwise a resync landing in that gap sees a stale isPlaying:false
    // and force-pauses the loader's own already-playing video back to 0.
    room.state = { videoId, isPlaying: true, time: 0, updatedAt: Date.now() };
    // Counts as heard, so the radio doesn't later offer back something the
    // room chose for itself twenty minutes ago.
    rememberPlayed(room, videoId);
    recordHistory(socket.data.roomId, room, videoId);
    socket.to(socket.data.roomId).emit("video:load", { videoId });
    // This path doesn't go through startVideoForRoom, so it has to arrange
    // its own "up next" or directly-loaded videos would end with nothing ready.
    prepareUpnext(socket.data.roomId, room, videoId);
  });

  socket.on("video:play", ({ time, at: clientAt }: { time: number; at?: number }) => {
    const room = currentRoom(socket);
    if (!room) return;
    // Someone hit play themselves mid-prepare — the barrier is moot.
    cancelPendingStart(room);
    const at = stampedAt(clientAt);
    room.state = { ...room.state, isPlaying: true, time, updatedAt: at };
    // videoId rides along so a tab that missed a video:load (brief
    // disconnect) notices it's playing the wrong video instead of applying
    // this to whatever it still has loaded.
    socket.to(socket.data.roomId).emit("video:play", { time, at, videoId: room.state.videoId });
  });

  socket.on("video:pause", ({ time, at: clientAt }: { time: number; at?: number }) => {
    const room = currentRoom(socket);
    if (!room) return;
    const at = stampedAt(clientAt);
    room.state = { ...room.state, isPlaying: false, time, updatedAt: at };
    socket.to(socket.data.roomId).emit("video:pause", { time, at, videoId: room.state.videoId });
  });

  // A tab finished pre-buffering a synchronized start. When the last one
  // reports in, the barrier opens early instead of waiting out the timeout.
  socket.on("video:ready", ({ videoId }: { videoId: string }) => {
    const room = currentRoom(socket);
    const clientId = socket.data.clientId as string | undefined;
    if (!room || !clientId || !room.pendingStart) return;
    if (room.pendingStart.videoId !== videoId) return;
    room.pendingStart.waiting.delete(clientId);
    if (room.pendingStart.waiting.size === 0) {
      beginPendingStart(socket.data.roomId, room);
    }
  });

  // "I'm still working on it." A browser tab buffers in a second or two, but
  // the terminal has to run yt-dlp to resolve a stream before mpv can buffer
  // a frame at all, and on a cold or throttled extraction that routinely
  // outlasts the barrier — so the room started without it and it arrived
  // seconds into a video everyone else was already watching. Rather than
  // making every room wait for the slowest client that could ever join, a
  // client that is genuinely still loading says so and the barrier waits.
  // A client that dies stops saying it, and the ordinary timeout applies.
  socket.on("video:preparing", ({ videoId }: { videoId: string }) => {
    const room = currentRoom(socket);
    const pending = room?.pendingStart;
    const clientId = socket.data.clientId as string | undefined;
    if (!room || !pending || !clientId) return;
    if (pending.videoId !== videoId || !pending.waiting.has(clientId)) return;
    // The ceiling: no amount of "still working" holds a room forever.
    if (Date.now() - pending.startedAt >= PREPARE_MAX_WAIT_MS) return;
    clearTimeout(pending.timer);
    pending.timer = setTimeout(
      () => beginPendingStart(socket.data.roomId, room),
      PREPARE_TIMEOUT_MS,
    );
  });

  // NTP-style probe: the client measures round-trip time and uses it to
  // estimate the offset between its clock and ours, which makes the `at`
  // timestamps on playback state directly comparable to its local clock.
  socket.on("clock:ping", (respond: (serverTime: number) => void) => {
    if (typeof respond === "function") respond(Date.now());
  });

  // The video played to its end: advance to the next queued video, or freeze
  // the state at the end rather than letting the isPlaying extrapolation run
  // past the video's duration forever. Every client reports the end — the
  // videoId guard makes the advance idempotent: the first report switches the
  // room to the next video, so the rest no longer match and are dropped.
  socket.on("video:ended", ({ time, videoId }: { time: number; videoId?: string | null }) => {
    const room = currentRoom(socket);
    if (!room) return;
    if (videoId !== room.state.videoId) return;
    const next = room.queue.shift();
    if (next) {
      io.to(socket.data.roomId).emit("queue:state", room.queue);
      startVideoForRoom(socket.data.roomId, room, next.videoId);
      return;
    }
    // Already settled by another client's report of the same ending — don't
    // restamp it (a late report would otherwise shove a room someone had
    // since paused mid-video back to the end).
    if (!room.state.isPlaying) return;
    room.state = { ...room.state, isPlaying: false, time, updatedAt: Date.now() };

    // Announce it. Without this, the end is invisible to everyone else until
    // their next resync, so for a few seconds they still believe the video is
    // playing — and anyone who hits replay in that window races clients whose
    // idea of "now" is still running past the end of the video. Said before
    // the radio runs, too: a lookup takes a moment, and a room that looks
    // stuck during it is worse than one that looks finished.
    const roomId = socket.data.roomId as string;
    io.to(roomId).emit("room:state", estimatedRoomState(room));

    // Nothing queued, but the room asked to keep going. Marking it in flight
    // *before* awaiting is what stops the other clients' reports of this same
    // ending from each starting their own lookup.
    if (!room.autoplay || !radioAvailable() || !videoId || room.radioPending) return;

    // The usual case: the pick was made when this video started and the room
    // has been showing it as "up next" ever since. Playing that exact pick
    // keeps the promise and skips the lookup — the handoff is instant.
    const ready = room.upnext && room.upnext.seed === videoId ? room.upnext.pick : null;
    if (ready) {
      io.to(roomId).emit("radio:picked", { videoId: ready.videoId, title: ready.title });
      startVideoForRoom(roomId, room, ready.videoId);
      return;
    }

    room.radioPending = true;
    io.to(roomId).emit("radio:searching");
    void radioPick(videoId, new Set(room.played))
      .then((pick) => {
        room.radioPending = false;
        // Someone queued or played something while the lookup was out — their
        // choice wins over the machine's, and so does turning autoplay off.
        if (rooms.get(roomId) !== room) return;
        if (!room.autoplay || room.state.videoId !== videoId || room.state.isPlaying) return;
        if (!pick) return io.to(roomId).emit("radio:dry");
        io.to(roomId).emit("radio:picked", { videoId: pick.videoId, title: pick.title });
        startVideoForRoom(roomId, room, pick.videoId);
      })
      .catch(() => {
        room.radioPending = false;
      });
  });

  // Autoplay is the room's setting, not a personal one — everyone is listening
  // to the same thing, so it has to be.
  socket.on("radio:set", ({ on }: { on: boolean }) => {
    const room = currentRoom(socket);
    if (!room) return;
    room.autoplay = Boolean(on);
    // The same shape as the one sent on join. Dropping `available` here made
    // the field mean two things — "off" and "not mentioned this time" — and a
    // client that believed it would hide the control the moment anyone used it.
    io.to(socket.data.roomId).emit("radio:state", {
      autoplay: room.autoplay,
      available: radioAvailable(),
    });
    // Turning autoplay on mid-video: the pre-pick was skipped when this video
    // started, so make it now or the room reaches the end with nothing ready.
    const videoId = room.state.videoId;
    if (room.autoplay && videoId && room.upnext?.seed !== videoId) {
      prepareUpnext(socket.data.roomId, room, videoId);
    }
  });

  socket.on("queue:add", ({ videoId, title }: { videoId: string; title?: string | null }) => {
    const room = currentRoom(socket);
    const clientId = socket.data.clientId as string | undefined;
    if (!room || !clientId) return;
    if (typeof videoId !== "string" || !videoId) return;
    // Queueing onto an idle room means "play it" (the client normally makes
    // that call itself so the click's autoplay permission isn't wasted, but
    // cover the race where the room went idle in between).
    if (!room.state.videoId) {
      startVideoForRoom(socket.data.roomId, room, videoId);
      return;
    }
    if (room.queue.length >= QUEUE_LIMIT) return;
    // The same person queueing the same video twice within a couple of seconds
    // is a double-fired click, not two decisions — one reported laptop did it
    // on every add. Queueing it twice on purpose that fast isn't a thing
    // anyone does, and the queue already allows the same video twice if you
    // wait. Guarding here covers every cause: a doubled tap, a trackpad, a
    // buffered emit flushed after a reconnect.
    const now = Date.now();
    const justQueued = recentQueueAdds.get(`${clientId}:${videoId}`);
    if (justQueued && now - justQueued < DUPLICATE_QUEUE_WINDOW_MS) return;
    recentQueueAdds.set(`${clientId}:${videoId}`, now);

    room.queue.push({
      id: crypto.randomUUID(),
      videoId,
      title: typeof title === "string" && title ? title.slice(0, QUEUE_TITLE_MAX_LENGTH) : null,
      addedBy: room.users.get(clientId)?.name ?? "Someone",
    });
    io.to(socket.data.roomId).emit("queue:state", room.queue);
  });

  socket.on("queue:remove", ({ id }: { id: string }) => {
    const room = currentRoom(socket);
    if (!room) return;
    const index = room.queue.findIndex((item) => item.id === id);
    if (index === -1) return;
    room.queue.splice(index, 1);
    io.to(socket.data.roomId).emit("queue:state", room.queue);
  });

  // Jump the whole room to a queued video right now (doubles as "skip" when
  // used on the first item). The item leaves the queue either way.
  socket.on("queue:play", ({ id }: { id: string }) => {
    const room = currentRoom(socket);
    if (!room) return;
    const index = room.queue.findIndex((item) => item.id === id);
    if (index === -1) return;
    const [item] = room.queue.splice(index, 1);
    io.to(socket.data.roomId).emit("queue:state", room.queue);
    startVideoForRoom(socket.data.roomId, room, item.videoId);
  });

  // "I'm typing" is a stateless relay: the sender pings while composing
  // (client-throttled), everyone else shows the indicator briefly and lets
  // it expire — no "stopped typing" event needed.
  socket.on("chat:typing", () => {
    const room = currentRoom(socket);
    const clientId = socket.data.clientId as string | undefined;
    if (!room || !clientId) return;
    const user = room.users.get(clientId);
    if (!user) return;
    socket.to(socket.data.roomId).emit("chat:typing", { clientId, name: user.name });
  });

  socket.on("chat:message", ({ text }: { text: string }) => {
    const room = currentRoom(socket);
    const clientId = socket.data.clientId as string | undefined;
    if (!room || !clientId) return;
    const trimmed = String(text ?? "").trim().slice(0, CHAT_MAX_LENGTH);
    if (!trimmed) return;
    // Spam control: a sliding window per sender. Over it, the message is
    // dropped and only the sender hears about it — the room never sees a
    // flood, and the flooder sees exactly why their line didn't land.
    const now = Date.now();
    const recent = (socket.data.chatTimes as number[] | undefined)?.filter(
      (at) => now - at < CHAT_BURST_WINDOW_MS,
    ) ?? [];
    if (recent.length >= CHAT_BURST_LIMIT) {
      const waitMs = CHAT_BURST_WINDOW_MS - (now - recent[0]);
      socket.data.chatTimes = recent;
      socket.emit("chat:rejected", { reason: "slow-down", waitMs });
      return;
    }
    recent.push(now);
    socket.data.chatTimes = recent;
    const message: ChatMessage = {
      id: crypto.randomUUID(),
      senderId: clientId,
      name: room.users.get(clientId)?.name ?? "Someone",
      text: trimmed,
      at: Date.now(),
    };
    room.messages.push(message);
    if (room.messages.length > CHAT_HISTORY_LIMIT) room.messages.shift();
    // Broadcast to everyone including the sender — rendering only the
    // server's echo keeps one source of truth and doubles as delivery
    // confirmation.
    io.to(socket.data.roomId).emit("chat:message", message);
  });

  // The other half of typing: an explicit "stopped" the moment the draft is
  // sent or cleared, so the dots don't linger for the expiry period after a
  // person has plainly finished.
  socket.on("chat:typing-stop", () => {
    const room = currentRoom(socket);
    const clientId = socket.data.clientId as string | undefined;
    if (!room || !clientId) return;
    socket.to(socket.data.roomId).emit("chat:typing-stop", { clientId });
  });

  socket.on("resync:request", () => {
    const room = currentRoom(socket);
    if (!room) return;
    socket.emit("room:state", estimatedRoomState(room));
  });

  // Take this socket out of whatever room it's in. Closing the tab is only
  // one way to leave — navigating back to the homepage or opening a different
  // room leaves too, and in a single-page app that happens without the socket
  // ever dropping. Without an explicit exit those people lingered in the user
  // list (and the stats) until they finally closed the tab.
  const leaveRoom = (opts: { disconnecting?: boolean } = {}) => {
    const roomId = socket.data.roomId as string | undefined;
    const clientId = socket.data.clientId as string | undefined;
    socket.data.roomId = undefined;
    if (!roomId || !clientId) return;
    if (!opts.disconnecting) socket.leave(roomId);
    const room = rooms.get(roomId);
    if (!room) return;

    // A dead connection can take a while to be detected server-side. If the
    // tab already reconnected with a new socket before that detection fires,
    // its entry has already been overwritten — don't delete the new one.
    const entry = room.users.get(clientId);
    if (entry && entry.socketId === socket.id) {
      room.users.delete(clientId);
    }

    // Don't let a synchronized start wait out its timeout on someone who left.
    if (room.pendingStart?.waiting.delete(clientId) && room.pendingStart.waiting.size === 0) {
      beginPendingStart(roomId, room);
    }

    if (room.users.size === 0) {
      cancelPendingStart(room);
      rooms.delete(roomId);
    } else {
      io.to(roomId).emit("room:users", userList(room));
    }

    // Only clear presence if this socket is still the one holding it. A second
    // tab, or a reconnect that already re-joined, owns it now.
    const uid = socket.data.userId as string | undefined;
    if (uid && presence.get(uid) === roomId) {
      const stillHere = [...(userSockets.get(uid) ?? [])].some(
        (id) => id !== socket.id && io.sockets.sockets.get(id)?.data.roomId === roomId,
      );
      if (!stillHere) {
        presence.delete(uid);
        notifyPresence(uid);
      }
    }
  };

  socket.on("room:leave", () => leaveRoom());

  // "Come watch this" — a nudge to a friend's open tabs, carrying the room
  // they'd be joining. Checked against the friendship rather than trusted:
  // otherwise any signed-in stranger could push a link at anyone.
  socket.on("friend:invite", async ({ toUserId }: { toUserId: string }) => {
    const fromId = socket.data.userId as string | undefined;
    const roomId = socket.data.roomId as string | undefined;
    if (!fromId || !roomId || !toUserId) return;
    try {
      if (!(await areFriends(fromId, toUserId))) return;
      const from = await getUser(fromId);
      if (!from) return;
      for (const socketId of userSockets.get(toUserId) ?? []) {
        io.to(socketId).emit("friend:invited", { from: from.name, roomId });
      }
    } catch (err) {
      console.error("invite failed:", (err as Error).message);
    }
  });

  // ---- Direct messages ---------------------------------------------------
  // Unlike room chat, these outlive the connection — so the socket's job is
  // only delivery, and the row is written before anyone is told about it.
  // Every message goes to both ends: the sender's other tabs are watching the
  // same conversation, and rendering only the server's echo means one code
  // path builds a message, exactly as room chat already does.
  socket.on("dm:send", async ({ toUserId, text }: { toUserId: string; text: string }) => {
    const fromId = socket.data.userId as string | undefined;
    if (!fromId || !toUserId || typeof text !== "string") return;
    try {
      if (!(await areFriends(fromId, toUserId))) return;
      const message = await sendDirect(fromId, toUserId, text);
      if (!message) return;
      emitToUsers([fromId, toUserId], "dm:message", message);
      // The recipient's badge changed even if their conversation isn't open.
      emitToUsers([toUserId], "friends:changed", undefined);
    } catch (err) {
      console.error("dm send failed:", (err as Error).message);
    }
  });

  socket.on("dm:read", async ({ withUserId }: { withUserId: string }) => {
    const userId = socket.data.userId as string | undefined;
    if (!userId || !withUserId) return;
    try {
      if (await markRead(userId, withUserId)) {
        // Only this person's own tabs: a read receipt is not something the
        // other end gets told about.
        emitToUsers([userId], "friends:changed", undefined);
      }
    } catch (err) {
      console.error("dm read failed:", (err as Error).message);
    }
  });

  // Same stateless relay as room typing: a ping while composing, expired by
  // the receiver. Nothing is stored and nothing needs a "stopped" event.
  socket.on("dm:typing", async ({ toUserId }: { toUserId: string }) => {
    const fromId = socket.data.userId as string | undefined;
    if (!fromId || !toUserId) return;
    try {
      if (!(await areFriends(fromId, toUserId))) return;
      emitToUsers([toUserId], "dm:typing", { from: fromId });
    } catch {
      // Not worth logging — a dropped typing dot is invisible.
    }
  });

  socket.on("disconnect", () => {
    console.log(`client disconnected: ${socket.id}`);
    leaveRoom({ disconnecting: true });
    const uid = socket.data.userId as string | undefined;
    if (uid) {
      const sockets = userSockets.get(uid);
      sockets?.delete(socket.id);
      if (sockets && sockets.size === 0) userSockets.delete(uid);
      // Closing one tab of three isn't going offline; the settle window and the
      // shape comparison make that a no-op rather than a false alarm.
      notifyPresence(uid);
    }
  });
});

if (isProd) {
  const clientDist = path.join(__dirname, "../../client/dist");
  app.use(express.static(clientDist));
  app.get("*", (_req, res) => {
    // Anything reaching here is a page navigation (assets were served
    // above) — that's the page-view count for /api/stats.
    pageViews++;
    res.sendFile(path.join(clientDist, "index.html"));
  });
}

// Schema first, then serve. If the database is configured but broken, that's
// worth failing loudly on — the alternative is a server that looks healthy and
// errors on every sign-in. No database configured at all is fine, though: the
// app just runs without accounts.
if (dbEnabled()) {
  try {
    await migrate();
    console.log("database ready");
  } catch (err) {
    console.error(err);
    process.exit(1);
  }

  // Retention is a promise, so it runs on a timer rather than only at boot — a
  // server that stays up for a month would otherwise never keep it.
  const prune = async () => {
    try {
      const removed = await pruneOldMessages();
      if (removed > 0) console.log(`pruned ${removed} message(s) older than ${DM_RETENTION_DAYS} days`);
    } catch (err) {
      console.error("message pruning failed:", (err as Error).message);
    }
    try {
      const removed = await pruneOldReports();
      if (removed > 0) console.log(`pruned ${removed} report(s) older than ${REPORT_RETENTION_DAYS} days`);
    } catch (err) {
      console.error("report pruning failed:", (err as Error).message);
    }
  };
  void prune();
  setInterval(() => void prune(), 6 * 60 * 60 * 1000).unref();
} else {
  console.log("no DATABASE_URL — running without accounts");
}

httpServer.listen(PORT, () => {
  console.log(`sesh server listening on http://localhost:${PORT}`);
});
