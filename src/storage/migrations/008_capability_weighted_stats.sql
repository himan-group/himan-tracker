alter table daily_capability_stats add column strict_attribution_count integer not null default 0;
alter table daily_capability_stats add column weighted_invocation_count real not null default 0;
alter table daily_capability_stats add column weighted_total_tokens real;
alter table daily_capability_stats add column weighted_duration_ms real;

alter table monthly_capability_stats add column strict_attribution_count integer not null default 0;
alter table monthly_capability_stats add column weighted_invocation_count real not null default 0;
alter table monthly_capability_stats add column weighted_total_tokens real;
alter table monthly_capability_stats add column weighted_duration_ms real;

update daily_capability_stats
set strict_attribution_count = (
    select coalesce(sum(
      case
        when coalesce(
          c.attribution_score,
          case
            when c.attribution_confidence = 'exact' then 100
            when c.capability_type = 'builtin_tool' then 55
            when c.capability_type = 'shell_command' then 50
            when c.attribution_confidence = 'estimated' then 60
            when c.attribution_confidence = 'unknown' then 0
            else 0
          end
        ) >= 80 then 1 else 0
      end
    ), 0)
    from capability_usages c
    where date(c.occurred_at, 'localtime') = daily_capability_stats.date
      and c.agent = daily_capability_stats.agent
      and c.capability_type = daily_capability_stats.capability_type
      and c.capability_name = daily_capability_stats.capability_name
  ),
  weighted_invocation_count = (
    select coalesce(sum(
      coalesce(
        c.attribution_score,
        case
          when c.attribution_confidence = 'exact' then 100
          when c.capability_type = 'builtin_tool' then 55
          when c.capability_type = 'shell_command' then 50
          when c.attribution_confidence = 'estimated' then 60
          when c.attribution_confidence = 'unknown' then 0
          else 0
        end
      ) / 100.0
    ), 0)
    from capability_usages c
    where date(c.occurred_at, 'localtime') = daily_capability_stats.date
      and c.agent = daily_capability_stats.agent
      and c.capability_type = daily_capability_stats.capability_type
      and c.capability_name = daily_capability_stats.capability_name
  ),
  weighted_total_tokens = (
    select case
      when count(c.total_tokens) = 0 then null
      else sum(
        c.total_tokens * (
          coalesce(
            c.attribution_score,
            case
              when c.attribution_confidence = 'exact' then 100
              when c.capability_type = 'builtin_tool' then 55
              when c.capability_type = 'shell_command' then 50
              when c.attribution_confidence = 'estimated' then 60
              when c.attribution_confidence = 'unknown' then 0
              else 0
            end
          ) / 100.0
        )
      )
    end
    from capability_usages c
    where date(c.occurred_at, 'localtime') = daily_capability_stats.date
      and c.agent = daily_capability_stats.agent
      and c.capability_type = daily_capability_stats.capability_type
      and c.capability_name = daily_capability_stats.capability_name
  ),
  weighted_duration_ms = (
    select case
      when count(
        coalesce(c.duration_ms, case when c.capability_type = 'skill' then t.duration_ms end)
      ) = 0 then null
      else sum(
        coalesce(c.duration_ms, case when c.capability_type = 'skill' then t.duration_ms end) * (
          coalesce(
            c.attribution_score,
            case
              when c.attribution_confidence = 'exact' then 100
              when c.capability_type = 'builtin_tool' then 55
              when c.capability_type = 'shell_command' then 50
              when c.attribution_confidence = 'estimated' then 60
              when c.attribution_confidence = 'unknown' then 0
              else 0
            end
          ) / 100.0
        )
      )
    end
    from capability_usages c
    left join turns t
      on c.turn_id = t.id
      and c.session_id = t.session_id
      and c.agent = t.agent
    where date(c.occurred_at, 'localtime') = daily_capability_stats.date
      and c.agent = daily_capability_stats.agent
      and c.capability_type = daily_capability_stats.capability_type
      and c.capability_name = daily_capability_stats.capability_name
  );
