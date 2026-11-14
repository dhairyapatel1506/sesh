-- A report can carry several screenshots now (up to five), so they get a table
-- of their own. The single-image columns on bug_reports stay for reports filed
-- before this; new ones leave them empty.

create table if not exists bug_report_images (
  report_id  text not null references bug_reports(id) on delete cascade,
  idx        integer not null,
  image      bytea not null,
  image_mime text not null,
  primary key (report_id, idx)
);
