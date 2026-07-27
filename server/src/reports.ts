import crypto from "node:crypto";
import { env, query } from "./db.js";

// Bug reports, and the rather larger amount of code needed to stop them being
// a free anonymous write endpoint with an image upload attached.
//
// The threat isn't clever, it's boring: somebody points a script at this and
// fills the database. So there are limits — but the first version of them was
// tuned as though every request were an attack, and the result was that the
// feature appeared broken to the first person who used it honestly.
//
// Two things were wrong. Three an hour is fewer than anyone testing a new
// report box naturally sends, so the third attempt reads as a bug rather than
// a limit. And counting by address alone means a household, an office or a
// campus shares one budget between everybody in it — NAT is universal, so an
// IP is a building, not a person.

export const REPORT_MIN_LENGTH = 10;
export const REPORT_MAX_LENGTH = 2000;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// Whoever this is being counted against. A signed-in person gets their own
// budget, so two people in the same flat — or one person on a laptop and a
// terminal — don't spend each other's. Anonymous reporters can only be
// identified by address, which is the honest limit of what's knowable.
const PER_SUBJECT_HOURLY = 12;
const PER_SUBJECT_DAILY = 40;

// The backstop: a distributed flood where every individual subject stays
// under its own limit still can't get past this.
const GLOBAL_HOURLY = 120;
// Screenshots are the part with a storage cost, so they get a tighter ceiling
// of their own. Text is cheap; two megabytes at a time is not.
const GLOBAL_IMAGE_HOURLY = 30;

export const IMAGE_MAX_BYTES = 2 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

// Reports are worth keeping longer than a conversation — a bug reported in
// March may still be open in May — but not forever, and the screenshots least
// of all.
export const REPORT_RETENTION_DAYS = 90;

// In memory, like every other rate limit here: it describes this process's
// recent traffic, and a restart losing it costs an abuser one extra window at
// worst while costing an honest reporter nothing.
const recent: { at: number; subject: string; withImage: boolean }[] = [];

function prune(now: number): void {
  const cutoff = now - DAY_MS;
  while (recent.length > 0 && recent[0].at < cutoff) recent.shift();
}

/** Who a report counts against: the account if there is one, else the address. */
export const subjectOf = (ipHash: string, userId?: string | null): string =>
  userId ? `u:${userId}` : `ip:${ipHash}`;

// "Try later" is a useless thing to be told. Work out when the oldest report in
// the window ages out, so the refusal can name a number.
function waitFor(subject: string, now: number, window: number, allowance: number): string {
  const mine = recent.filter((r) => r.subject === subject && r.at > now - window).map((r) => r.at);
  if (mine.length < allowance) return "shortly";
  const freesAt = mine.sort((a, b) => a - b)[mine.length - allowance] + window;
  const minutes = Math.max(1, Math.ceil((freesAt - now) / 60_000));
  if (minutes < 60) return `in ${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(minutes / 60);
  return `in about ${hours} hour${hours === 1 ? "" : "s"}`;
}

/**
 * The reporter's address, reduced to something that can be compared but not
 * read back. Keyed on SESSION_SECRET so the hashes aren't reversible with a
 * rainbow table of the whole IPv4 space, which a bare sha256 would be.
 */
export function hashIp(ip: string): string {
  const secret = env("SESSION_SECRET") ?? "sesh";
  return crypto.createHmac("sha256", secret).update(ip).digest("base64url").slice(0, 22);
}

export type ReportRefusal = { ok: false; error: string; status: number };
export type ReportInput = {
  text: string;
  client: "web" | "cli";
  ipHash: string;
  userId?: string | null;
  roomId?: string | null;
  userAgent?: string | null;
  image?: { data: Buffer; mime: string } | null;
};

/** Everything that can be checked without touching the database. */
export function vetReport(
  input: Pick<ReportInput, "text" | "ipHash" | "image" | "userId">,
): ReportRefusal | { ok: true } {
  const now = Date.now();
  prune(now);

  const text = input.text.trim();
  if (text.length < REPORT_MIN_LENGTH) {
    return {
      ok: false,
      status: 400,
      error: `Tell us a bit more than that — at least ${REPORT_MIN_LENGTH} characters.`,
    };
  }
  if (text.length > REPORT_MAX_LENGTH) {
    return { ok: false, status: 400, error: "That's longer than we can take — trim it a little." };
  }

  if (input.image) {
    if (!ALLOWED_IMAGE_TYPES.has(input.image.mime)) {
      return { ok: false, status: 400, error: "Screenshots need to be a PNG, JPEG or WebP." };
    }
    if (input.image.data.length > IMAGE_MAX_BYTES) {
      return { ok: false, status: 413, error: "That image is over 2 MB — try a smaller one." };
    }
  }

  const lastHour = recent.filter((r) => r.at > now - HOUR_MS);
  if (lastHour.length >= GLOBAL_HOURLY) {
    return {
      ok: false,
      status: 503,
      error: "We're getting an unusual number of reports right now — please try again later.",
    };
  }
  if (input.image && lastHour.filter((r) => r.withImage).length >= GLOBAL_IMAGE_HOURLY) {
    return {
      ok: false,
      status: 503,
      error: "We can't take more screenshots just now — send the report without one and describe it.",
    };
  }

  const subject = subjectOf(input.ipHash, input.userId);
  const mine = recent.filter((r) => r.subject === subject);
  if (mine.filter((r) => r.at > now - HOUR_MS).length >= PER_SUBJECT_HOURLY) {
    return {
      ok: false,
      status: 429,
      error: `That's a lot of reports in one hour — you can send another ${waitFor(subject, now, HOUR_MS, PER_SUBJECT_HOURLY)}.`,
    };
  }
  if (mine.length >= PER_SUBJECT_DAILY) {
    return {
      ok: false,
      status: 429,
      error: `That's as many reports as we take in a day — you can send another ${waitFor(subject, now, DAY_MS, PER_SUBJECT_DAILY)}. Thanks, we've got them.`,
    };
  }

  return { ok: true };
}

/** Records that a report was accepted, for the limits above. */
export function noteReport(subject: string, withImage: boolean): void {
  recent.push({ at: Date.now(), subject, withImage });
}

/**
 * Pulls an image out of a data URL. Returns null for anything that isn't one,
 * which includes every attempt to smuggle something else in — the shape is
 * checked before the decode, and the decode is bounded.
 */
export function decodeDataUrl(value: unknown): { data: Buffer; mime: string } | null {
  if (typeof value !== "string" || !value.startsWith("data:")) return null;
  // Bail before base64-decoding something enormous: 4 characters carry 3
  // bytes, so this is a cheap upper bound on what the decode would produce.
  if (value.length > IMAGE_MAX_BYTES * 1.4 + 100) return null;
  const match = value.match(/^data:([a-z]+\/[a-z0-9.+-]+);base64,(.+)$/i);
  if (!match) return null;
  try {
    return { data: Buffer.from(match[2], "base64"), mime: match[1].toLowerCase() };
  } catch {
    return null;
  }
}

export async function saveReport(input: ReportInput): Promise<string> {
  const id = crypto.randomUUID();
  await query(
    `insert into bug_reports
       (id, user_id, room_id, client, body, user_agent, image, image_mime, ip_hash)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      id,
      input.userId ?? null,
      input.roomId ?? null,
      input.client,
      input.text.trim().slice(0, REPORT_MAX_LENGTH),
      input.userAgent?.slice(0, 300) ?? null,
      input.image?.data ?? null,
      input.image?.mime ?? null,
      input.ipHash,
    ],
  );
  noteReport(subjectOf(input.ipHash, input.userId), Boolean(input.image));
  return id;
}

export type StoredReport = {
  id: string;
  at: number;
  client: string;
  roomId: string | null;
  body: string;
  userAgent: string | null;
  reporter: string | null;
  ipHash: string | null;
  hasImage: boolean;
};

export async function listReports(limit = 50): Promise<StoredReport[]> {
  const rows = await query<{
    id: string;
    created_at: Date;
    client: string;
    room_id: string | null;
    body: string;
    user_agent: string | null;
    name: string | null;
    ip_hash: string | null;
    has_image: boolean;
  }>(
    `select r.id, r.created_at, r.client, r.room_id, r.body, r.user_agent,
            u.name, r.ip_hash, (r.image is not null) as has_image
       from bug_reports r
       left join users u on u.id = r.user_id
      order by r.created_at desc
      limit $1`,
    [Math.min(Math.max(limit, 1), 200)],
  );
  return rows.map((row) => ({
    id: row.id,
    at: row.created_at.getTime(),
    client: row.client,
    roomId: row.room_id,
    body: row.body,
    userAgent: row.user_agent,
    reporter: row.name,
    ipHash: row.ip_hash,
    hasImage: row.has_image,
  }));
}

export async function reportImage(id: string): Promise<{ data: Buffer; mime: string } | null> {
  const rows = await query<{ image: Buffer | null; image_mime: string | null }>(
    "select image, image_mime from bug_reports where id = $1",
    [id],
  );
  const row = rows[0];
  if (!row?.image) return null;
  return { data: row.image, mime: row.image_mime ?? "application/octet-stream" };
}

export async function pruneOldReports(): Promise<number> {
  const rows = await query<{ id: string }>(
    `delete from bug_reports
      where created_at < now() - ($1 || ' days')::interval
      returning id`,
    [String(REPORT_RETENTION_DAYS)],
  );
  return rows.length;
}
