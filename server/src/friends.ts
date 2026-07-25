import { query } from "./db.js";

export type Friend = {
  id: string;
  name: string;
  avatarUrl: string | null;
  // "accepted" — a friend. "incoming" — they asked, you haven't answered.
  // "outgoing" — you asked, they haven't. The database stores one row per
  // pair with a direction; these are that row seen from your side.
  status: "accepted" | "incoming" | "outgoing";
  // Which room they're in right now, if any. Filled in by the caller from
  // live presence, which lives in memory rather than the database.
  roomId?: string | null;
};

// The pair is stored sorted, so every read and write has to sort the same way
// before touching it. Getting this wrong doesn't error — it silently creates a
// second row for the same two people, pointing the other way.
const pair = (a: string, b: string) => (a < b ? [a, b] : [b, a]);

export async function listFriends(userId: string): Promise<Friend[]> {
  const rows = await query<{
    id: string;
    name: string;
    avatar_url: string | null;
    status: string;
    requested_by: string;
  }>(
    `select u.id, u.name, u.avatar_url, f.status, f.requested_by
       from friendships f
       join users u
         on u.id = case when f.user_a_id = $1 then f.user_b_id else f.user_a_id end
      where f.user_a_id = $1 or f.user_b_id = $1
      order by u.name`,
    [userId],
  );

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    avatarUrl: row.avatar_url,
    status:
      row.status === "accepted"
        ? "accepted"
        : row.requested_by === userId
          ? "outgoing"
          : "incoming",
  }));
}

export async function requestFriend(
  userId: string,
  friendCode: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const code = friendCode.trim().toUpperCase();
  if (!code) return { ok: false, error: "Enter a friend code." };

  const found = await query<{ id: string }>("select id from users where friend_code = $1", [code]);
  const target = found[0];
  if (!target) return { ok: false, error: "No one has that code." };
  if (target.id === userId) return { ok: false, error: "That's your own code." };

  const [a, b] = pair(userId, target.id);

  // If they already asked you, asking back is obviously a yes. Doing this as
  // part of the insert means the two requests can't race into two rows.
  const inserted = await query<{ status: string }>(
    `insert into friendships (user_a_id, user_b_id, requested_by, status)
     values ($1, $2, $3, 'pending')
     on conflict (user_a_id, user_b_id) do update
       set status = case
         when friendships.requested_by <> $3 then 'accepted'
         else friendships.status
       end
     returning status`,
    [a, b, userId],
  );

  return inserted[0]?.status === "accepted"
    ? { ok: true }
    : { ok: true };
}

export async function acceptFriend(userId: string, otherId: string): Promise<boolean> {
  const [a, b] = pair(userId, otherId);
  // Only the person who *didn't* send it can accept it, or someone could
  // accept their own request and appear in a stranger's friends list.
  const rows = await query(
    `update friendships set status = 'accepted'
      where user_a_id = $1 and user_b_id = $2
        and status = 'pending' and requested_by <> $3
      returning user_a_id`,
    [a, b, userId],
  );
  return rows.length > 0;
}

// Covers unfriending, declining a request, and cancelling one you sent —
// all of them are "this row shouldn't exist".
export async function removeFriend(userId: string, otherId: string): Promise<void> {
  const [a, b] = pair(userId, otherId);
  await query("delete from friendships where user_a_id = $1 and user_b_id = $2", [a, b]);
}

// Who to tell when something about this user changes. Only settled
// friendships: a pending request shouldn't leak where someone is.
export async function acceptedFriendIds(userId: string): Promise<string[]> {
  const rows = await query<{ id: string }>(
    `select case when user_a_id = $1 then user_b_id else user_a_id end as id
       from friendships
      where (user_a_id = $1 or user_b_id = $1) and status = 'accepted'`,
    [userId],
  );
  return rows.map((r) => r.id);
}

export async function areFriends(userId: string, otherId: string): Promise<boolean> {
  const [a, b] = pair(userId, otherId);
  const rows = await query(
    `select 1 from friendships
      where user_a_id = $1 and user_b_id = $2 and status = 'accepted'`,
    [a, b],
  );
  return rows.length > 0;
}
