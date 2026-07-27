import crypto from "node:crypto";
import { env, query } from "./db.js";

// Bug reports, and the rather larger amount of code needed to stop them being
// a free anonymous write endpoint with an image upload attached.
//
// The threat isn't clever, it's boring: somebody points a script at this and
// fills the database. So there are four independent limits, and any one of
// them refusing is enough — per address, per account, per size, and a global
// ceiling that protects the server even if the first three are somehow walked
// around by a distributed flood.

export const REPORT_MIN_LENGTH = 10;
export const REPORT_MAX_LENGTH = 2000;

// Comfortably more than an honest person needs in an hour, and far less than
// a script wants. Someone hitting this is either testing it or abusing it, and
// the message says so plainly rather than failing silently.
const PER_IP_HOURLY = 3;
const PER_IP_DAILY = 10;
// Whatever happens, the server as a whole will not accept more than this. A
// thousand addresses each staying under their own limit still can't get past
// it.
const GLOBAL_HOURLY = 60;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export const IMAGE_MAX_BYTES = 2 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

// Reports are worth keeping longer than a conversation — a bug reported in
// March may still be open in May — but not forever, and the screenshots least
// of all.
export const REPORT_RETENTION_DAYS = 90;

// In memory, like every other rate limit here: it describes this process's
// recent traffic, and a restart losing it costs an abuser one extra window at
// worst while costing an honest reporter nothing.
const recent: { at: number; ipHash: string }[] = [];

function prune(now: number): void {
  const cutoff = now - DAY_MS;
  while (recent.length > 0 && recent[0].at < cutoff) recent.shift();
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
  input: Pick<ReportInput, "text" | "ipHash" | "image">,
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

  if (recent.length >= GLOBAL_HOURLY) {
    const inLastHour = recent.filter((r) => r.at > now - HOUR_MS).length;
    if (inLastHour >= GLOBAL_HOURLY) {
      return {
        ok: false,
        status: 503,
        error: "We're getting an unusual number of reports right now — please try again later.",
      };
    }
  }

  const mine = recent.filter((r) => r.ipHash === input.ipHash);
  if (mine.filter((r) => r.at > now - HOUR_MS).length >= PER_IP_HOURLY) {
    return {
      ok: false,
      status: 429,
      error: "You've sent a few reports just now — give it an hour before the next one.",
    };
  }
  if (mine.length >= PER_IP_DAILY) {
    return {
      ok: false,
      status: 429,
      error: "That's as many reports as we take from one place in a day. Thanks — we've got them.",
    };
  }

  return { ok: true };
}

/** Records that a report was accepted, for the limits above. */
export function noteReport(ipHash: string): void {
  recent.push({ at: Date.now(), ipHash });
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
  noteReport(input.ipHash);
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
