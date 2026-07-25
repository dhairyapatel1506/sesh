import crypto from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { OAuth2Client } from "google-auth-library";
import { query, dbEnabled } from "./db.js";

const COOKIE_NAME = "sesh_session";
const SESSION_DAYS = 30;

// Same alphabet as room codes — no 0/O or 1/I/L, because these get read aloud
// and typed by someone else.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export type User = {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  friendCode: string;
};

export const authEnabled = () => dbEnabled() && Boolean(process.env.GOOGLE_CLIENT_ID);

let client: OAuth2Client | null = null;
const googleClient = () => (client ??= new OAuth2Client(process.env.GOOGLE_CLIENT_ID));

function randomCode(length = 6): string {
  const bytes = crypto.randomBytes(length);
  let code = "";
  for (let i = 0; i < length; i++) code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return code;
}

// A session is a signed statement that this browser is a given user, and
// nothing else — no server-side session table to look up, expire or clean.
// The tradeoff is that signing out can't invalidate a cookie already issued;
// it only removes it from the browser. For "who are my friends" that's a fair
// trade, and the cookie is httpOnly so script on the page can't read it.
function sign(payload: string): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET is not set");
  return crypto.createHmac("sha256", secret).update(payload).digest("base64url");
}

function issueSession(userId: string): string {
  const expiresAt = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
  const payload = `${userId}.${expiresAt}`;
  return `${payload}.${sign(payload)}`;
}

export function readSession(token: string | undefined): string | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [userId, expiresAt, signature] = parts;
  const expected = sign(`${userId}.${expiresAt}`);
  // Compare in constant time: a plain !== leaks, through timing, how much of a
  // forged signature was right, which is enough to guess one byte at a time.
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  if (Number(expiresAt) < Date.now()) return null;
  return userId;
}

export function setSessionCookie(res: Response, userId: string): void {
  res.cookie(COOKIE_NAME, issueSession(userId), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000,
  });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(COOKIE_NAME);
}

export async function getUser(userId: string): Promise<User | null> {
  const rows = await query<{
    id: string;
    email: string;
    name: string;
    avatar_url: string | null;
    friend_code: string;
  }>("select id, email, name, avatar_url, friend_code from users where id = $1", [userId]);
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    avatarUrl: row.avatar_url,
    friendCode: row.friend_code,
  };
}

// Turns a Google credential into one of our users, creating them on first
// sign-in. Keyed on Google's subject id rather than the email, so changing an
// email address doesn't strand someone's friends list behind a new account.
export async function signInWithGoogle(credential: string): Promise<User> {
  const ticket = await googleClient().verifyIdToken({
    idToken: credential,
    audience: process.env.GOOGLE_CLIENT_ID,
  });
  const payload = ticket.getPayload();
  if (!payload?.sub || !payload.email) throw new Error("incomplete Google profile");

  const existing = await query<{ id: string }>("select id from users where google_sub = $1", [
    payload.sub,
  ]);

  if (existing[0]) {
    await query(
      `update users set email = $2, name = $3, avatar_url = $4, last_seen_at = now()
       where id = $1`,
      [existing[0].id, payload.email, payload.name ?? payload.email, payload.picture ?? null],
    );
    const user = await getUser(existing[0].id);
    if (!user) throw new Error("user vanished mid-sign-in");
    return user;
  }

  // Friend codes are short enough to collide eventually. Retry rather than
  // widening them — a handful of attempts is cheaper than a code nobody can
  // read out over a call.
  for (let attempt = 0; attempt < 5; attempt++) {
    const id = crypto.randomUUID();
    try {
      await query(
        `insert into users (id, google_sub, email, name, avatar_url, friend_code)
         values ($1, $2, $3, $4, $5, $6)`,
        [
          id,
          payload.sub,
          payload.email,
          payload.name ?? payload.email,
          payload.picture ?? null,
          randomCode(),
        ],
      );
      const user = await getUser(id);
      if (!user) throw new Error("user vanished after insert");
      return user;
    } catch (err) {
      const message = (err as Error).message;
      // Only a friend_code clash is worth retrying; anything else is real.
      if (!message.includes("friend_code")) throw err;
    }
  }
  throw new Error("could not allocate a friend code");
}

// Attaches req.userId when the request carries a valid session. Never rejects:
// almost everything in Sesh works signed out, so routes decide for themselves
// whether they need a user.
export function withUser(req: Request, _res: Response, next: NextFunction): void {
  if (authEnabled()) {
    try {
      req.userId = readSession(req.cookies?.[COOKIE_NAME]) ?? undefined;
    } catch {
      // No SESSION_SECRET configured — treat as signed out rather than 500.
    }
  }
  next();
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userId?: string;
    }
  }
}
