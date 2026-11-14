-- A report now says what kind it is (bug or idea) and the name the sender went
-- by in the room, so the inbox can tell a feature request from a complaint and
-- who it came from. Both are optional: older rows simply have neither.

alter table bug_reports add column if not exists kind text not null default 'bug';
alter table bug_reports add column if not exists display_name text;
