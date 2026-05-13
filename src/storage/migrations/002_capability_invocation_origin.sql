alter table capability_usages add column source text not null default 'unknown';
alter table capability_usages add column invocation_origin text not null default 'unknown';

update capability_usages
set invocation_origin = case
  when capability_type = 'skill' and attribution_confidence = 'exact' then 'explicit'
  when capability_type = 'skill' and attribution_confidence = 'estimated' then 'inferred'
  else 'unknown'
end;

alter table daily_capability_stats add column estimated_attribution_count integer not null default 0;
alter table daily_capability_stats add column explicit_invocation_count integer not null default 0;
alter table daily_capability_stats add column inferred_invocation_count integer not null default 0;
alter table daily_capability_stats add column observed_invocation_count integer not null default 0;
alter table daily_capability_stats add column unknown_origin_count integer not null default 0;

update daily_capability_stats
set
  estimated_attribution_count = (
    select coalesce(sum(case when c.attribution_confidence = 'estimated' then 1 else 0 end), 0)
    from capability_usages c
    where date(c.occurred_at, 'localtime') = daily_capability_stats.date
      and c.agent = daily_capability_stats.agent
      and c.capability_type = daily_capability_stats.capability_type
      and c.capability_name = daily_capability_stats.capability_name
  ),
  explicit_invocation_count = (
    select coalesce(sum(case when c.invocation_origin = 'explicit' then 1 else 0 end), 0)
    from capability_usages c
    where date(c.occurred_at, 'localtime') = daily_capability_stats.date
      and c.agent = daily_capability_stats.agent
      and c.capability_type = daily_capability_stats.capability_type
      and c.capability_name = daily_capability_stats.capability_name
  ),
  inferred_invocation_count = (
    select coalesce(sum(case when c.invocation_origin = 'inferred' then 1 else 0 end), 0)
    from capability_usages c
    where date(c.occurred_at, 'localtime') = daily_capability_stats.date
      and c.agent = daily_capability_stats.agent
      and c.capability_type = daily_capability_stats.capability_type
      and c.capability_name = daily_capability_stats.capability_name
  ),
  observed_invocation_count = (
    select coalesce(sum(case when c.invocation_origin = 'observed' then 1 else 0 end), 0)
    from capability_usages c
    where date(c.occurred_at, 'localtime') = daily_capability_stats.date
      and c.agent = daily_capability_stats.agent
      and c.capability_type = daily_capability_stats.capability_type
      and c.capability_name = daily_capability_stats.capability_name
  ),
  unknown_origin_count = (
    select coalesce(sum(case when c.invocation_origin = 'unknown' then 1 else 0 end), 0)
    from capability_usages c
    where date(c.occurred_at, 'localtime') = daily_capability_stats.date
      and c.agent = daily_capability_stats.agent
      and c.capability_type = daily_capability_stats.capability_type
      and c.capability_name = daily_capability_stats.capability_name
  );
