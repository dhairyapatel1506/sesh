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

type Room = {
  state: RoomState;
  users: Map<string, string>; // socket id -> name
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
  return Array.from(room.users, ([id, name]) => ({ id, name }));
}

io.on("connection", (socket) => {
  console.log(`client connected: ${socket.id}`);

  socket.on("room:join", ({ roomId, name }: { roomId: string; name: string }) => {
    socket.data.roomId = roomId;
    socket.data.name = name;
    socket.join(roomId);

    const room = getOrCreateRoom(roomId);
    room.users.set(socket.id, name);

    socket.emit("room:state", estimatedRoomState(room));
    io.to(roomId).emit("room:users", userList(room));
  });

  socket.on("video:load", ({ videoId }: { videoId: string }) => {
    const room = currentRoom(socket);
    if (!room) return;
    room.state = { videoId, isPlaying: false, time: 0, updatedAt: Date.now() };
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

  socket.on("resync:request", () => {
    const room = currentRoom(socket);
    if (!room) return;
    socket.emit("room:state", estimatedRoomState(room));
  });

  socket.on("disconnect", () => {
    console.log(`client disconnected: ${socket.id}`);
    const roomId = socket.data.roomId as string | undefined;
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;
    room.users.delete(socket.id);
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
