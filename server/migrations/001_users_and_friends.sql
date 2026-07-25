-- Sesh's first persistent storage. Everything before this lived in memory and
-- died with the process, on purpose — rooms, names, chat. That stays true.
-- This is only for the part that can't work that way: knowing who your friends
-- are between visits.

create table if not exists users (
  id           text primary key,
  -- Google's stable identifier for a person. Not the email: people change
  -- those, and Google reuses nothing but this.
  google_sub   text unique not null,
  email        text not null,
  name         text not null,
  avatar_url   text,
  -- What you give someone so they can add you — same shape as a room code,
  -- for the same reason: short enough to read aloud.
  friend_code  text unique not null,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

-- One row per friendship, not two. The pair is stored with the lower id first
-- so that "are these two friends" is a single lookup with no ors, and a
-- duplicate request in the opposite direction collides with the primary key
-- instead of quietly creating a second, contradictory row.
create table if not exists friendships (
  user_a_id    text not null references users(id) on delete cascade,
  user_b_id    text not null references users(id) on delete cascade,
  -- Who sent the request. Needed because the pair above is sorted, so the
  -- row itself no longer remembers which direction it went.
  requested_by text not null references users(id) on delete cascade,
  status       text not null check (status in ('pending', 'accepted')),
  created_at   timestamptz not null default now(),
  primary key (user_a_id, user_b_id),
  check (user_a_id < user_b_id)
);

-- "Show me my friends" is the single hottest query this feature has — it runs
-- on every page load — and it has to match on either side of the pair.
create index if not exists friendships_user_b_idx on friendships (user_b_id);
