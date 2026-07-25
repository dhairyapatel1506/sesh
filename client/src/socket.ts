import { io } from "socket.io-client";

const SERVER_URL = import.meta.env.DEV ? "http://localhost:3001" : "/";

// withCredentials so the handshake carries the session cookie in dev, where
// the client and server are different origins. Without it the socket connects
// anonymously and friends never see you as online.
export const socket = io(SERVER_URL, { withCredentials: true });

// Base for plain HTTP calls to the API — empty string means same-origin in prod.
export const API_BASE = import.meta.env.DEV ? "http://localhost:3001" : "";
