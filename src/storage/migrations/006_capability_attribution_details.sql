alter table capability_usages add column attribution_basis text not null default 'unknown';
alter table capability_usages add column attribution_score integer;
alter table capability_usages add column attribution_reason text;
alter table capability_usages add column attribution_context_source text not null default 'none';

update capability_usages
set attribution_basis = case
    when invocation_origin = 'explicit' then 'prompt_explicit_skill'
    when capability_type = 'mcp_tool' and invocation_origin = 'observed' and attribution_confidence = 'exact'
      then 'transcript_mcp_tool_end'
    when capability_type = 'builtin_tool' then 'classifier_builtin'
    when capability_type = 'shell_command' then 'classifier_shell'
    when invocation_origin = 'inferred' then 'transcript_shell_skill_path'
    else 'fallback_unknown'
  end,
  attribution_score = case
    when attribution_confidence = 'exact' then 100
    when invocation_origin = 'inferred' then 60
    when capability_type = 'builtin_tool' then 55
    when capability_type = 'shell_command' then 50
    when attribution_confidence = 'unknown' then 0
    else null
  end,
  attribution_context_source = case
    when invocation_origin = 'inferred' then 'transcript_only'
    else 'none'
  end
where attribution_basis = 'unknown'
  and attribution_score is null
  and attribution_reason is null
  and attribution_context_source = 'none';
