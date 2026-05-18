create table if not exists ingest_file_cursors (
  file_path text primary key,
  inode text not null,
  size_bytes integer not null,
  offset_bytes integer not null,
  mtime_ms integer not null,
  updated_at text not null
);

create index if not exists idx_ingest_file_cursors_updated_at
  on ingest_file_cursors(updated_at);
