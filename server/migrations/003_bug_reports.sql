-- Somewhere for "this broke" to land. Anonymous people can file these too, so
-- there's no user to hang them off — which is also why the anti-abuse work
-- (see server/src/reports.ts) matters more here than anywhere else in Sesh.

create table if not exists bug_reports (
  id           text primary key,
  -- Null for anonymous reporters, which most will be.
  user_id      text references users(id) on delete set null,
  -- What they were looking at when it broke; far more useful than the report
  -- text alone, and free to collect.
  room_id      text,
  client       text not null,          -- 'web' | 'cli'
  body         text not null,
  user_agent   text,
  -- Kept as bytes rather than a URL: there's no object store here, images are
  -- small and few, and a screenshot that outlives its report is a liability.
  image        bytea,
  image_mime   text,
  -- HMAC of the reporter's address, not the address. Enough to see that forty
  -- reports came from one place; not a log of who visited.
  ip_hash      text,
  created_at   timestamptz not null default now()
);

create index if not exists bug_reports_created_idx on bug_reports (created_at desc);
create index if not exists bug_reports_ip_idx on bug_reports (ip_hash, created_at desc);
