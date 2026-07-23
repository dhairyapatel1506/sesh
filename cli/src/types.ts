// Mirrors the server's wire types (server/src/index.ts) — the CLI speaks the
// exact same Socket.IO protocol as the web client.

export type RoomState = {
  videoId: string | null;
  isPlaying: boolean;
  time: number;
  at: number; // server-clock ms at which `time` was accurate
};

export type ChatMessage = {
  id: string;
  senderId: string;
  name: string;
  text: string;
  at: number;
};

export type QueueItem = {
  id: string;
  videoId: string;
  title: string | null;
  addedBy: string;
};

export type RoomUser = { id: string; name: string };

export type SearchResult = {
  videoId: string;
  title: string;
  channel: string;
  thumbnail: string;
  duration: string;
};
