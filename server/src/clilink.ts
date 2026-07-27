import crypto from "node:crypto";

// Signing the terminal in, without a browser on the machine running it.
//
// The CLI can't do what the web client does — Google hands its credential to a
// page, not a process — and it shouldn't ask anyone to paste a password it has
// no business seeing. So it does what a TV does: shows a short code, and you
// approve it from somewhere already signed in. The terminal never touches your
// Google account; it ends up holding the same signed session string the browser
// would have had.
//
// Deliberately in memory. A pending link is worthless ten minutes from now, and
// a restart losing them costs someone one retry.

const LINK_TTL_MS = 10 * 60 * 1000;
// Same alphabet as room and friend codes: nothing that reads as something else
// when it's typed off a screen into another window.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 8;

type PendingLink = {
  code: string;
  pollToken: string;
  userId: string | null; // set once someone approves it
  expiresAt: number;
};

const byPollToken = new Map<string, PendingLink>();
const byCode = new Map<string, PendingLink>();

function randomCode(): string {
  const bytes = crypto.randomBytes(CODE_LENGTH);
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return code;
}

function prune(): void {
  const now = Date.now();
  for (const [token, link] of byPollToken) {
    if (link.expiresAt < now) {
      byPollToken.delete(token);
      byCode.delete(link.code);
    }
  }
}

setInterval(prune, 60_000).unref();

/** Codes are shown as ABCD-EFGH but typed however people feel like. */
export const normaliseCode = (raw: string): string =>
  String(raw ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

export const formatCode = (code: string): string => `${code.slice(0, 4)}-${code.slice(4)}`;

export function startLink(): { code: string; pollToken: string; expiresAt: number } {
  prune();
  let code = randomCode();
  // A collision would let one terminal's approval sign in a different one.
  while (byCode.has(code)) code = randomCode();

  const link: PendingLink = {
    code,
    pollToken: crypto.randomBytes(32).toString("hex"),
    userId: null,
    expiresAt: Date.now() + LINK_TTL_MS,
  };
  byPollToken.set(link.pollToken, link);
  byCode.set(code, link);
  return { code: formatCode(code), pollToken: link.pollToken, expiresAt: link.expiresAt };
}

/** Someone signed in, looking at the code their terminal printed, said yes. */
export function approveLink(rawCode: string, userId: string): boolean {
  prune();
  const link = byCode.get(normaliseCode(rawCode));
  if (!link || link.userId) return false;
  link.userId = userId;
  return true;
}

export type PollResult =
  | { status: "pending" }
  | { status: "expired" }
  | { status: "approved"; userId: string };

export function pollLink(pollToken: string): PollResult {
  prune();
  const link = byPollToken.get(String(pollToken ?? ""));
  if (!link) return { status: "expired" };
  if (!link.userId) return { status: "pending" };
  // Handed over exactly once — the poll token is spent the moment it becomes a
  // session, so a copy of it scraped from a log is worth nothing afterwards.
  byPollToken.delete(link.pollToken);
  byCode.delete(link.code);
  return { status: "approved", userId: link.userId };
}
