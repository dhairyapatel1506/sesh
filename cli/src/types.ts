// Mirrors the server's wire types (server/src/index.ts) — the CLI speaks the
// exact same Socket.IO protocol as the web client.

export type RoomState = {
  videoId: string | null;
  isPlaying: boolean;
  time: number;
  at: number; // server-clock ms at which `time` was accurate
  createdAt?: number; // when the room came into existence (uptime display)
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

// Who you are once you've signed in — the same shape the web client's
// /api/auth/me hands its React context.
export type Account = {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  friendCode: string;
};

export type Friend = {
  id: string;
  name: string;
  avatarUrl: string | null;
  // "incoming" — they asked and you haven't answered; "outgoing" — the other
  // way round. Everything below is zero/false/null unless you're "accepted"
  // friends: a pending request must not become a way to watch someone.
  status: "accepted" | "incoming" | "outgoing";
  online: boolean;
  roomId: string | null;
  unread: number;
  lastMessage: { text: string; at: number; mine: boolean } | null;
};

export type DirectMessage = {
  id: string;
  from: string; // user id, not the per-room clientId room chat uses
  to: string;
  text: string;
  at: number;
  read: boolean;
};

export type SearchResult = {
  videoId: string;
  title: string;
  channel: string;
  thumbnail: string;
  duration: string;
};
