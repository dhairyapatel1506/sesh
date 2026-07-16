import { io } from "socket.io-client";

const SERVER_URL = import.meta.env.DEV ? "http://localhost:3001" : "/";

export const socket = io(SERVER_URL);

// Base for plain HTTP calls to the API — empty string means same-origin in prod.
export const API_BASE = import.meta.env.DEV ? "http://localhost:3001" : "";
