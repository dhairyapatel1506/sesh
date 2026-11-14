-- Anonymous reporters can leave an address if they'd like a reply. Optional,
-- and only ever stored when they typed it into the form themselves.

alter table bug_reports add column if not exists contact_email text;
