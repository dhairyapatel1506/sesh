import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import cors from "cors";
import { createServer } from "node:http";
import { Server, type Socket } from "socket.io";

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
  app.use(cors({ origin: "http://localhost:5173" }));
}

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: isProd ? undefined : { origin: "http://localhost:5173" },
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
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

    // One extra unit fetches durations for all results at once.
    const durations = new Map<string, string>();
    const ids = items.map((item) => item.id.videoId).join(",");
    if (ids) {
      const videosUrl = new URL("https://www.googleapis.com/youtube/v3/videos");
      videosUrl.search = new URLSearchParams({
        part: "contentDetails",
        id: ids,
        key: YOUTUBE_API_KEY,
      }).toString();
      const videosRes = await fetch(videosUrl);
      if (videosRes.ok) {
        const videosData = (await videosRes.json()) as {
          items?: { id: string; contentDetails: { duration: string } }[];
        };
        for (const video of videosData.items ?? []) {
          durations.set(video.id, formatDuration(video.contentDetails.duration));
        }
      }
    }

    const results: SearchResult[] = items.map((item) => ({
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
};

type Room = {
  state: RoomState;
  users: Map<string, RoomUser>; // clientId -> user
  messages: ChatMessage[];
  queue: QueueItem[];
  pendingStart: PendingStart | null;
  createdAt: number; // when the room came into existence — drives the uptime display
};

const CHAT_MAX_LENGTH = 500;
// Chat is as ephemeral as the room itself (gone when the last person
// leaves); the cap just keeps a long sesh from growing memory unbounded.
const CHAT_HISTORY_LIMIT = 100;
const QUEUE_LIMIT = 50;
const QUEUE_TITLE_MAX_LENGTH = 200;
// How long a synchronized start waits for stragglers to finish buffering.
const PREPARE_TIMEOUT_MS = 8000;

const rooms = new Map<string, Room>();

function getOrCreateRoom(roomId: string): Room {
  let room = rooms.get(roomId);
  if (!room) {
    room = {
      state: { videoId: null, isPlaying: false, time: 0, updatedAt: Date.now() },
      users: new Map(),
      messages: [],
      queue: [],
      pendingStart: null,
      createdAt: Date.now(),
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
function startVideoForRoom(roomId: string, room: Room, videoId: string) {
  cancelPendingStart(room);
  room.state = { videoId, isPlaying: false, time: 0, updatedAt: Date.now() };
  room.pendingStart = {
    videoId,
    waiting: new Set(room.users.keys()),
    timer: setTimeout(() => beginPendingStart(roomId, room), PREPARE_TIMEOUT_MS),
  };
  io.to(roomId).emit("video:prepare", { videoId });
}

io.on("connection", (socket) => {
  console.log(`client connected: ${socket.id}`);

  socket.on(
    "room:join",
    ({ roomId, name, clientId }: { roomId: string; name: string; clientId: string }) => {
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
    socket.to(socket.data.roomId).emit("video:load", { videoId });
  });

  socket.on("video:play", ({ time }: { time: number }) => {
    const room = currentRoom(socket);
    if (!room) return;
    // Someone hit play themselves mid-prepare — the barrier is moot.
    cancelPendingStart(room);
    const at = Date.now();
    room.state = { ...room.state, isPlaying: true, time, updatedAt: at };
    // videoId rides along so a tab that missed a video:load (brief
    // disconnect) notices it's playing the wrong video instead of applying
    // this to whatever it still has loaded.
    socket.to(socket.data.roomId).emit("video:play", { time, at, videoId: room.state.videoId });
  });

  socket.on("video:pause", ({ time }: { time: number }) => {
    const room = currentRoom(socket);
    if (!room) return;
    const at = Date.now();
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
    // idea of "now" is still running past the end of the video.
    io.to(socket.data.roomId).emit("room:state", estimatedRoomState(room));
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

  socket.on("resync:request", () => {
    const room = currentRoom(socket);
    if (!room) return;
    socket.emit("room:state", estimatedRoomState(room));
  });

  socket.on("disconnect", () => {
    console.log(`client disconnected: ${socket.id}`);
    const roomId = socket.data.roomId as string | undefined;
    const clientId = socket.data.clientId as string | undefined;
    if (!roomId || !clientId) return;
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

httpServer.listen(PORT, () => {
  console.log(`sesh server listening on http://localhost:${PORT}`);
});
