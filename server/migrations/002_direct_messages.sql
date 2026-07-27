-- Messages between two friends, outside any room. The first thing in Sesh that
-- is deliberately *not* ephemeral — but only for a while: rows older than the
-- retention window are deleted on a timer (see server/src/dm.ts). A chat you
-- can scroll back through forever is a different product with different
-- promises; this one just means you don't lose the thread overnight.

create table if not exists direct_messages (
  id           text primary key,
  sender_id    text not null references users(id) on delete cascade,
  recipient_id text not null references users(id) on delete cascade,
  body         text not null,
  created_at   timestamptz not null default now(),
  -- When the recipient actually looked at it. Null means unread, which is all
  -- the badge needs; the timestamp is there because "unread since when" is the
  -- question you ask the moment anything looks wrong.
  read_at      timestamptz
);

-- A conversation is read in both directions at once, so neither ordering of
-- the pair is the "right" one — index both and let the planner pick.
create index if not exists dm_thread_idx on direct_messages (sender_id, recipient_id, created_at desc);
create index if not exists dm_inbox_idx on direct_messages (recipient_id, sender_id, created_at desc);

-- Pruning scans by age across every conversation, which neither index above
-- helps with.
create index if not exists dm_age_idx on direct_messages (created_at);
