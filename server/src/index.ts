import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import cors from "cors";
import { createServer } from "node:http";
import { Server } from "socket.io";

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

// Single global room for now — per-room state lands in Phase 3.
let roomState: RoomState = {
  videoId: null,
  isPlaying: false,
  time: 0,
  updatedAt: Date.now(),
};

// `time` is only ever a snapshot from the last play/pause action, not a
// live clock. While playing, extrapolate how far the video has actually
// progressed since that snapshot so late joiners land in the right spot.
function estimatedRoomState(): RoomState {
  if (!roomState.isPlaying) return roomState;
  const elapsedSeconds = (Date.now() - roomState.updatedAt) / 1000;
  return { ...roomState, time: roomState.time + elapsedSeconds };
}

io.on("connection", (socket) => {
  console.log(`client connected: ${socket.id}`);
  socket.emit("room:state", estimatedRoomState());

  socket.on("video:load", ({ videoId }: { videoId: string }) => {
    roomState = { videoId, isPlaying: false, time: 0, updatedAt: Date.now() };
    socket.broadcast.emit("video:load", { videoId });
  });

  socket.on("video:play", ({ time }: { time: number }) => {
    roomState = { ...roomState, isPlaying: true, time, updatedAt: Date.now() };
    socket.broadcast.emit("video:play", { time });
  });

  socket.on("video:pause", ({ time }: { time: number }) => {
    roomState = { ...roomState, isPlaying: false, time, updatedAt: Date.now() };
    socket.broadcast.emit("video:pause", { time });
  });

  socket.on("resync:request", () => {
    socket.emit("room:state", estimatedRoomState());
  });

  socket.on("disconnect", () => {
    console.log(`client disconnected: ${socket.id}`);
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
