import crypto from "node:crypto";
import { query } from "./db.js";

// How long a conversation sticks around. Long enough that "what did she say
// last week" works, short enough that this never becomes an archive nobody
// asked Sesh to keep. Deleting is the feature, not the housekeeping.
export const DM_RETENTION_DAYS = 30;

export const DM_MAX_LENGTH = 1000;
// One screenful of scrollback, which is all the UI ever shows at once. Older
// messages are still there until the retention window eats them — `before`
// pages back through them.
export const DM_PAGE_SIZE = 50;

export type DirectMessage = {
  id: string;
  from: string;
  to: string;
  text: string;
  at: number;
  read: boolean;
};

type Row = {
  id: string;
  sender_id: string;
  recipient_id: string;
  body: string;
  created_at: Date;
  read_at: Date | null;
};

const toMessage = (row: Row): DirectMessage => ({
  id: row.id,
  from: row.sender_id,
  to: row.recipient_id,
  text: row.body,
  at: row.created_at.getTime(),
  read: row.read_at !== null,
});

// Both halves of one conversation, newest last so the caller can append
// straight onto what it already has. `before` pages backwards.
export async function conversation(
  userId: string,
  otherId: string,
  before?: number,
): Promise<DirectMessage[]> {
  const rows = await query<Row>(
    `select id, sender_id, recipient_id, body, created_at, read_at
       from direct_messages
      where ((sender_id = $1 and recipient_id = $2)
          or (sender_id = $2 and recipient_id = $1))
        and ($3::timestamptz is null or created_at < $3::timestamptz)
      order by created_at desc
      limit ${DM_PAGE_SIZE}`,
    [userId, otherId, before ? new Date(before).toISOString() : null],
  );
  return rows.map(toMessage).reverse();
}

export async function sendDirect(
  fromId: string,
  toId: string,
  text: string,
): Promise<DirectMessage | null> {
  const body = text.trim().slice(0, DM_MAX_LENGTH);
  if (!body) return null;
  const rows = await query<Row>(
    `insert into direct_messages (id, sender_id, recipient_id, body)
     values ($1, $2, $3, $4)
     returning id, sender_id, recipient_id, body, created_at, read_at`,
    [crypto.randomUUID(), fromId, toId, body],
  );
  return rows[0] ? toMessage(rows[0]) : null;
}

// Marks everything *they* sent *you* as read. Returns whether anything
// changed, so a redundant call doesn't set off a round of notifications.
export async function markRead(userId: string, otherId: string): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `update direct_messages set read_at = now()
      where recipient_id = $1 and sender_id = $2 and read_at is null
      returning id`,
    [userId, otherId],
  );
  return rows.length > 0;
}

// One query for every badge on screen, rather than one per friend.
export async function unreadBySender(userId: string): Promise<Map<string, number>> {
  const rows = await query<{ sender_id: string; count: string }>(
    `select sender_id, count(*) as count
       from direct_messages
      where recipient_id = $1 and read_at is null
      group by sender_id`,
    [userId],
  );
  return new Map(rows.map((row) => [row.sender_id, Number(row.count)]));
}

// The most recent line of each conversation, for the friends list preview.
// distinct on is Postgres-specific and exactly the right tool: sort into the
// order you want, then keep the first row per pair.
export async function latestPerFriend(userId: string): Promise<Map<string, DirectMessage>> {
  const rows = await query<Row & { other_id: string }>(
    `select distinct on (other_id) *
       from (
         select id, sender_id, recipient_id, body, created_at, read_at,
                case when sender_id = $1 then recipient_id else sender_id end as other_id
           from direct_messages
          where sender_id = $1 or recipient_id = $1
       ) t
      order by other_id, created_at desc`,
    [userId],
  );
  return new Map(rows.map((row) => [row.other_id, toMessage(row)]));
}

export async function pruneOldMessages(): Promise<number> {
  const rows = await query<{ id: string }>(
    `delete from direct_messages
      where created_at < now() - ($1 || ' days')::interval
      returning id`,
    [String(DM_RETENTION_DAYS)],
  );
  return rows.length;
}
