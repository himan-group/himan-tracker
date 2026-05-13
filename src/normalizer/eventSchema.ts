import { z } from "zod";

import type { NormalizedEvent } from "../types/events.js";

const agentNameSchema = z.enum(["codex", "claude-code"]);
const eventStatusSchema = z.enum(["success", "failure", "cancelled", "unknown"]);
const capabilityTypeSchema = z.enum([
  "skill",
  "mcp_tool",
  "plugin",
  "builtin_tool",
  "shell_command",
  "unknown",
]);
const adoptedSchema = z.enum(["yes", "no", "unknown"]);
const attributionConfidenceSchema = z.enum(["exact", "estimated", "unknown"]);
const invocationOriginSchema = z.enum(["explicit", "inferred", "observed", "unknown"]);

const nullableNonNegativeIntegerSchema = z.number().int().nonnegative().nullable();
const nullableNonNegativeNumberSchema = z.number().nonnegative().nullable();

const eventBaseSchema = z.object({
  schema_version: z.literal("1.0"),
  event_id: z.string().min(1),
  event_type: z.enum(["turn_summary", "capability_usage", "session_summary"]),
  occurred_at: z.string().datetime({ offset: true }),
  agent: agentNameSchema,
  source: z.string().min(1),
  session_id: z.string().min(1),
  turn_id: z.string().min(1).nullable().optional(),
  repo_hash: z.string().min(1).nullable().optional(),
  status: eventStatusSchema,
});

const tokenUsageSchema = z.object({
  input_tokens: nullableNonNegativeIntegerSchema,
  output_tokens: nullableNonNegativeIntegerSchema,
  total_tokens: nullableNonNegativeIntegerSchema,
});

export const turnSummaryEventSchema = eventBaseSchema
  .extend({
    event_type: z.literal("turn_summary"),
    model: z.string().min(1).nullable().optional(),
    duration_ms: nullableNonNegativeNumberSchema,
  })
  .merge(tokenUsageSchema);

export const capabilityUsageEventSchema = eventBaseSchema
  .extend({
    event_type: z.literal("capability_usage"),
    capability_type: capabilityTypeSchema,
    capability_name: z.string().min(1),
    duration_ms: nullableNonNegativeNumberSchema,
    adopted: adoptedSchema,
    attribution_confidence: attributionConfidenceSchema,
    invocation_origin: invocationOriginSchema.default("unknown"),
  })
  .merge(tokenUsageSchema);

export const sessionSummaryEventSchema = eventBaseSchema.extend({
  event_type: z.literal("session_summary"),
  turn_count: nullableNonNegativeIntegerSchema,
  duration_ms: nullableNonNegativeNumberSchema,
});

export const normalizedEventSchema = z.discriminatedUnion("event_type", [
  turnSummaryEventSchema,
  capabilityUsageEventSchema,
  sessionSummaryEventSchema,
]);

export function validateNormalizedEvent(event: unknown): NormalizedEvent {
  return normalizedEventSchema.parse(event);
}

export function isNormalizedEvent(event: unknown): event is NormalizedEvent {
  return normalizedEventSchema.safeParse(event).success;
}
