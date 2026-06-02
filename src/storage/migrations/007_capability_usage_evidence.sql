create table if not exists capability_usage_evidence (
  id text primary key,
  usage_id text not null,
  evidence_type text not null,
  confidence text not null,
  score integer,
  summary text not null,
  context_source text not null,
  occurred_at text not null
);

create index if not exists idx_capability_usage_evidence_usage
  on capability_usage_evidence(usage_id);

create index if not exists idx_capability_usage_evidence_occurred_at
  on capability_usage_evidence(occurred_at);
