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

type Room = {
  state: RoomState;
  users: Map<string, RoomUser>; // clientId -> user
  messages: ChatMessage[];
};

const CHAT_MAX_LENGTH = 500;
// Chat is as ephemeral as the room itself (gone when the last person
// leaves); the cap just keeps a long sesh from growing memory unbounded.
const CHAT_HISTORY_LIMIT = 100;

const rooms = new Map<string, Room>();

function getOrCreateRoom(roomId: string): Room {
  let room = rooms.get(roomId);
  if (!room) {
    room = {
      state: { videoId: null, isPlaying: false, time: 0, updatedAt: Date.now() },
      users: new Map(),
      messages: [],
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
  };
}

function userList(room: Room) {
  return Array.from(room.users, ([clientId, user]) => ({ id: clientId, name: user.name }));
}

io.on("connection", (socket) => {
  console.log(`client connected: ${socket.id}`);

  socket.on(
    "room:join",
    ({ roomId, name, clientId }: { roomId: string; name: string; clientId: string }) => {
      socket.data.roomId = roomId;
      socket.data.clientId = clientId;
      socket.join(roomId);

      const room = getOrCreateRoom(roomId);
      // Keyed by a stable per-tab clientId (not socket.id) so a reconnect
      // (new socket.id) updates this user's existing entry instead of
      // appearing as a duplicate until the old socket's disconnect fires.
      room.users.set(clientId, { name, socketId: socket.id });

      socket.emit("room:state", estimatedRoomState(room));
      // Late joiners (and reconnects) get what was said before they arrived.
      socket.emit("chat:history", room.messages);
      io.to(roomId).emit("room:users", userList(room));
    },
  );

  socket.on("video:load", ({ videoId }: { videoId: string }) => {
    const room = currentRoom(socket);
    if (!room) return;
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

  // NTP-style probe: the client measures round-trip time and uses it to
  // estimate the offset between its clock and ours, which makes the `at`
  // timestamps on playback state directly comparable to its local clock.
  socket.on("clock:ping", (respond: (serverTime: number) => void) => {
    if (typeof respond === "function") respond(Date.now());
  });

  // The video played to its end. Freeze the state there rather than letting
  // the isPlaying extrapolation run past the video's duration forever. Not
  // rebroadcast: every client's own player ends naturally on its own.
  socket.on("video:ended", ({ time }: { time: number }) => {
    const room = currentRoom(socket);
    if (!room) return;
    room.state = { ...room.state, isPlaying: false, time, updatedAt: Date.now() };
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

    if (room.users.size === 0) {
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
    res.sendFile(path.join(clientDist, "index.html"));
  });
}

httpServer.listen(PORT, () => {
  console.log(`sesh server listening on http://localhost:${PORT}`);
});
