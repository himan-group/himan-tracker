import { BUILTIN_TOOL_NAMES } from "../normalizer/capabilityClassifier.js";

export function createExcludeSystemCapabilityCondition(
  tableAlias?: string,
): { sql: string; params: string[] } {
  const prefix = tableAlias ? `${tableAlias}.` : "";
  const placeholders = BUILTIN_TOOL_NAMES.map(() => "?").join(", ");

  return {
    sql:
      `not (${prefix}capability_type = 'builtin_tool' ` +
      `or (${prefix}capability_type = 'unknown' ` +
      `and ${prefix}capability_name in (${placeholders})))`,
    params: [...BUILTIN_TOOL_NAMES],
  };
}
