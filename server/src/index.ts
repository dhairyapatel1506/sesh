import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import cors from "cors";
import { createServer } from "node:http";
import { Server, type Socket } from "socket.io";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT ? Number(process.env.PORT) : 3001;
const isProd = process.env.NODE_ENV === "production";

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

type Room = {
  state: RoomState;
  users: Map<string, RoomUser>; // clientId -> user
};

const rooms = new Map<string, Room>();

function getOrCreateRoom(roomId: string): Room {
  let room = rooms.get(roomId);
  if (!room) {
    room = {
      state: { videoId: null, isPlaying: false, time: 0, updatedAt: Date.now() },
      users: new Map(),
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
function estimatedRoomState(room: Room): RoomState {
  if (!room.state.isPlaying) return room.state;
  const elapsedSeconds = (Date.now() - room.state.updatedAt) / 1000;
  return { ...room.state, time: room.state.time + elapsedSeconds };
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
    room.state = { ...room.state, isPlaying: true, time, updatedAt: Date.now() };
    socket.to(socket.data.roomId).emit("video:play", { time });
  });

  socket.on("video:pause", ({ time }: { time: number }) => {
    const room = currentRoom(socket);
    if (!room) return;
    room.state = { ...room.state, isPlaying: false, time, updatedAt: Date.now() };
    socket.to(socket.data.roomId).emit("video:pause", { time });
  });

  // The video played to its end. Freeze the state there rather than letting
  // the isPlaying extrapolation run past the video's duration forever. Not
  // rebroadcast: every client's own player ends naturally on its own.
  socket.on("video:ended", ({ time }: { time: number }) => {
    const room = currentRoom(socket);
    if (!room) return;
    room.state = { ...room.state, isPlaying: false, time, updatedAt: Date.now() };
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
