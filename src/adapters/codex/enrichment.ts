import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import Database from "better-sqlite3";

import {
  extractSkillEvidenceFromToolCall,
  type HimanLockSkillCache,
} from "./skillEvidence.js";
import { classifyCapability } from "../../normalizer/capabilityClassifier.js";
import { validateNormalizedEvent } from "../../normalizer/eventSchema.js";
import { createEventId } from "../../normalizer/normalizeEvent.js";
import type {
  AttributionConfidence,
  CapabilityAttributionContextSource,
  CapabilityInvocationOrigin,
  CapabilityType,
  CapabilityUsageEvent,
  EventStatus,
  NormalizedEvent,
  TokenUsage,
} from "../../types/events.js";

type RawRecord = Record<string, unknown>;

const TOKEN_TIMESTAMP_TOLERANCE_MS = 5_000;

export type CodexStopEnrichmentTask = {
  kind: "codex-stop";
  session_id: string;
  turn_id: string | null;
  occurred_at: string;
  transcript_path?: string;
};

export type CodexToolEnrichmentTask = {
  kind: "codex-tool";
  session_id: string;
  turn_id: string | null;
  occurred_at: string;
  tool_use_id: string;
  tool_name: string;
  transcript_path?: string;
};

export type CodexEnrichmentError = {
  phase: "codex_enrich";
  reason: string;
  transcript_file?: string;
};

type TokenSnapshot = {
  timestampMs: number;
  usage: TokenUsage;
};

type TranscriptTurnUsage = {
  model: string | null;
  tokenUsage: TokenUsage | null;
  durationMs: number | null;
  capabilities: TranscriptCapabilityUsage[];
};

type TranscriptCapabilityUsage = {
  occurred_at: string;
  turn_id: string | null;
  capability_type: Extract<CapabilityType, "skill" | "mcp_tool">;
  capability_name: string;
  duration_ms: number | null;
  status: EventStatus;
  attribution_confidence: AttributionConfidence;
  invocation_origin: CapabilityInvocationOrigin;
  attribution_basis: "transcript_mcp_tool_end" | "transcript_shell_skill_path";
  attribution_score: number;
  attribution_reason: string;
  attribution_context_source: CapabilityAttributionContextSource;
};

type TranscriptToolCallStart = {
  timestampMs: number;
  turnId: string | null;
};

type CodexThreadRow = {
  rollout_path?: string | null;
};

export function collectCodexEnrichmentTasks(
  payload: unknown,
  observedAt: string,
): Array<CodexStopEnrichmentTask | CodexToolEnrichmentTask> {
  return getRawEvents(payload).flatMap<CodexStopEnrichmentTask | CodexToolEnrichmentTask>((event) => {
    const hook =
      getString(event.hook) ?? getString(event.hook_event_name) ?? getString(event.type);

    if (hook === "PostToolUse") {
      const sessionId = getString(event.session_id);
      const toolUseId = getString(event.tool_use_id);
      const toolName = getString(event.tool_name) ?? getString(getRecord(event.tool)?.name);
      const occurredAt = getString(event.occurred_at) ?? observedAt;
      const hasDuration = getInteger(event.duration_ms) !== null;
      if (!sessionId || !toolUseId || !toolName || !occurredAt || hasDuration) {
        return [];
      }

      const transcriptPath = getString(event.transcript_path);
      return [
        {
          kind: "codex-tool",
          session_id: sessionId,
          turn_id: getString(event.turn_id) ?? null,
          occurred_at: occurredAt,
          tool_use_id: toolUseId,
          tool_name: toolName,
          ...(transcriptPath ? { transcript_path: transcriptPath } : {}),
        },
      ];
    }

    if (hook !== "Stop") {
      return [];
    }

    const sessionId = getString(event.session_id);
    const occurredAt = getString(event.occurred_at) ?? observedAt;
    if (!sessionId || !occurredAt) {
      return [];
    }

    const transcriptPath = getString(event.transcript_path);
    return [
      {
        kind: "codex-stop",
        session_id: sessionId,
        turn_id: getString(event.turn_id) ?? null,
        occurred_at: occurredAt,
        ...(transcriptPath ? { transcript_path: transcriptPath } : {}),
      },
    ];
  });
}

export async function enrichCodexEvents(
  events: NormalizedEvent[],
  tasks: Array<CodexStopEnrichmentTask | CodexToolEnrichmentTask>,
): Promise<{ events: NormalizedEvent[]; errors: CodexEnrichmentError[] }> {
  const enrichedEvents = events.map((event) => ({ ...event })) as NormalizedEvent[];
  const errors: CodexEnrichmentError[] = [];

  for (const task of tasks) {
    try {
      const transcriptPath =
        task.transcript_path ?? (await resolveTranscriptPathFromCodexState(task.session_id));
      if (!transcriptPath) {
        continue;
      }

      if (task.kind === "codex-tool") {
        const durationMs = await parseTranscriptToolDuration({
          transcriptPath,
          toolUseId: task.tool_use_id,
          occurredAt: task.occurred_at,
        });
        mergeToolDuration(enrichedEvents, task, durationMs);
        continue;
      }

      const usage = await parseTranscriptTurnUsage({
        transcriptPath,
        turnId: task.turn_id,
        occurredAt: task.occurred_at,
      });
      mergeTurnUsage(enrichedEvents, task, usage);
      mergeTranscriptCapabilities(enrichedEvents, task, usage.capabilities);
    } catch (error) {
      errors.push({
        phase: "codex_enrich",
        reason: getErrorMessage(error),
        ...(task.transcript_path
          ? { transcript_file: path.basename(task.transcript_path) }
          : {}),
      });
    }
  }

  return {
    events: enrichedEvents.map(validateNormalizedEvent),
    errors,
  };
}

async function parseTranscriptTurnUsage(options: {
  transcriptPath: string;
  turnId: string | null;
  occurredAt: string;
}): Promise<TranscriptTurnUsage> {
  const stopMs = Date.parse(options.occurredAt);
  if (Number.isNaN(stopMs)) {
    throw new Error("Codex enrichment stop timestamp is invalid");
  }

  const rawTranscript = await readFile(options.transcriptPath, "utf8");
  const tokenSnapshots: TokenSnapshot[] = [];
  const toolCallStarts = new Map<string, TranscriptToolCallStart>();
  const capabilities: TranscriptCapabilityUsage[] = [];
  const skillCapabilityKeys = new Set<string>();
  const himanLockSkillCache: HimanLockSkillCache = new Map();
  let currentTurnId: string | null = null;
  let latestMatchingTurnStartMs: number | null = null;
  let latestTaskStartMs: number | null = null;
  let model: string | null = null;
  let durationMs: number | null = null;

  for (const line of rawTranscript.split(/\r?\n/)) {
    if (line.trim().length === 0) {
      continue;
    }

    const record = parseJsonRecord(line);
    if (!record) {
      continue;
    }

    const timestampMs = parseTimestampMs(record.timestamp);
    if (timestampMs === null || timestampMs > stopMs + TOKEN_TIMESTAMP_TOLERANCE_MS) {
      continue;
    }

    if (record.type === "turn_context") {
      const payload = getRecord(record.payload);
      const turnId = getString(payload?.turn_id);
      currentTurnId = turnId ?? currentTurnId;
      if (!options.turnId || turnId === options.turnId) {
        latestMatchingTurnStartMs = timestampMs;
        model = getString(payload?.model) ?? model;
      }
      continue;
    }

    const payload = getRecord(record.payload);
    if (!payload) {
      continue;
    }

    if (
      record.type === "response_item" &&
      (payload.type === "function_call" || payload.type === "custom_tool_call")
    ) {
      const callId = getString(payload.call_id);
      if (callId) {
        toolCallStarts.set(callId, {
          timestampMs,
          turnId: currentTurnId,
        });
      }

      if (shouldCollectTranscriptCapability(currentTurnId, options.turnId)) {
        for (const skillEvidence of await extractSkillEvidenceFromToolCall(
          payload,
          himanLockSkillCache,
        )) {
          const key = `${currentTurnId ?? ""}\u001f${skillEvidence.skillName}`;
          if (skillCapabilityKeys.has(key)) {
            continue;
          }

          skillCapabilityKeys.add(key);
          capabilities.push({
            occurred_at: getString(record.timestamp) ?? options.occurredAt,
            turn_id: currentTurnId,
            capability_type: "skill",
            capability_name: skillEvidence.skillName,
            duration_ms: null,
            status: "unknown",
            attribution_confidence: "estimated",
            invocation_origin: "inferred",
            attribution_basis: "transcript_shell_skill_path",
            attribution_score: skillEvidence.attributionScore,
            attribution_reason: skillEvidence.attributionReason,
            attribution_context_source: skillEvidence.attributionContextSource,
          });
        }
      }
      continue;
    }

    if (record.type !== "event_msg") {
      continue;
    }

    if (payload?.type === "task_complete") {
      const payloadTurnId = getString(payload.turn_id);
      if (!options.turnId || payloadTurnId === options.turnId) {
        durationMs = getInteger(payload.duration_ms) ?? durationMs;
      }
      continue;
    }

    if (payload?.type === "task_started") {
      const payloadTurnId = getString(payload.turn_id);
      currentTurnId = payloadTurnId ?? currentTurnId;
      if (!options.turnId || payloadTurnId === options.turnId) {
        latestTaskStartMs = timestampMs;
      }
      continue;
    }

    if (payload?.type === "mcp_tool_call_end") {
      const callId = getString(payload.call_id);
      const callStart = callId ? toolCallStarts.get(callId) : undefined;
      const payloadTurnId = getString(payload.turn_id) ?? callStart?.turnId ?? currentTurnId;
      const invocation = getRecord(payload.invocation);
      const server = getString(invocation?.server);
      const tool = getString(invocation?.tool);

      if (server && tool && shouldCollectTranscriptCapability(payloadTurnId, options.turnId)) {
        const directDuration = parseDurationMs(payload.duration) ?? getInteger(payload.duration_ms);
        const inferredDuration =
          directDuration ??
          (callStart && timestampMs >= callStart.timestampMs
            ? timestampMs - callStart.timestampMs
            : null);

        capabilities.push({
          occurred_at: getString(record.timestamp) ?? options.occurredAt,
          turn_id: payloadTurnId,
          capability_type: "mcp_tool",
          capability_name: `${server}.${tool}`,
          duration_ms: inferredDuration,
          status: getMcpResultStatus(payload.result),
          attribution_confidence: "exact",
          invocation_origin: "observed",
          attribution_basis: "transcript_mcp_tool_end",
          attribution_score: 100,
          attribution_reason: "Structured mcp_tool_call_end event observed in transcript.",
          attribution_context_source: "transcript_only",
        });
      }
      continue;
    }

    if (payload?.type !== "token_count") {
      continue;
    }

    const info = getRecord(payload.info);
    const totalUsage = getTokenUsage(getRecord(info?.total_token_usage));
    if (totalUsage) {
      tokenSnapshots.push({ timestampMs, usage: totalUsage });
    }
  }

  const startMs = latestTaskStartMs ?? latestMatchingTurnStartMs;
  if (startMs === null) {
    return { model, tokenUsage: null, durationMs, capabilities };
  }

  const endSnapshot = findLatestSnapshot(
    tokenSnapshots,
    (snapshot) => snapshot.timestampMs <= stopMs + TOKEN_TIMESTAMP_TOLERANCE_MS,
  );
  if (!endSnapshot) {
    return { model, tokenUsage: null, durationMs, capabilities };
  }

  const baselineSnapshot = findLatestSnapshot(
    tokenSnapshots,
    (snapshot) => snapshot.timestampMs < startMs,
  );
  const baseline = baselineSnapshot?.usage ?? {
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
  };

  return {
    model,
    tokenUsage: subtractTokenUsage(endSnapshot.usage, baseline),
    durationMs,
    capabilities,
  };
}

async function parseTranscriptToolDuration(options: {
  transcriptPath: string;
  toolUseId: string;
  occurredAt: string;
}): Promise<number | null> {
  const observedMs = Date.parse(options.occurredAt);
  if (Number.isNaN(observedMs)) {
    throw new Error("Codex tool enrichment timestamp is invalid");
  }

  const rawTranscript = await readFile(options.transcriptPath, "utf8");
  const callStartTimestamps = new Map<string, number>();

  for (const line of rawTranscript.split(/\r?\n/)) {
    if (line.trim().length === 0) {
      continue;
    }

    const record = parseJsonRecord(line);
    if (!record) {
      continue;
    }

    const timestampMs = parseTimestampMs(record.timestamp);
    if (timestampMs === null || timestampMs > observedMs + TOKEN_TIMESTAMP_TOLERANCE_MS) {
      continue;
    }

    const payload = getRecord(record.payload);
    if (!payload) {
      continue;
    }

    if (
      record.type === "response_item" &&
      (payload.type === "function_call" || payload.type === "custom_tool_call")
    ) {
      const callId = getString(payload.call_id);
      if (callId) {
        callStartTimestamps.set(callId, timestampMs);
      }
      continue;
    }

    if (record.type !== "event_msg" || getString(payload.call_id) !== options.toolUseId) {
      continue;
    }

    const directDuration = parseDurationMs(payload.duration) ?? getInteger(payload.duration_ms);
    if (directDuration !== null) {
      return directDuration;
    }

    const startMs = callStartTimestamps.get(options.toolUseId);
    if (startMs !== undefined && timestampMs >= startMs) {
      return timestampMs - startMs;
    }
  }

  return null;
}

function mergeTurnUsage(
  events: NormalizedEvent[],
  task: CodexStopEnrichmentTask,
  usage: TranscriptTurnUsage,
): void {
  const turn = events.find(
    (event) =>
      event.event_type === "turn_summary" &&
      event.session_id === task.session_id &&
      (task.turn_id ? event.turn_id === task.turn_id : true),
  );

  if (!turn || turn.event_type !== "turn_summary") {
    return;
  }

  turn.duration_ms ??= usage.durationMs;

  if (!turn.model && usage.model) {
    turn.model = usage.model;
  }

  if (!usage.tokenUsage) {
    return;
  }

  turn.input_tokens ??= usage.tokenUsage.input_tokens;
  turn.output_tokens ??= usage.tokenUsage.output_tokens;
  turn.total_tokens ??= usage.tokenUsage.total_tokens;
}

function mergeToolDuration(
  events: NormalizedEvent[],
  task: CodexToolEnrichmentTask,
  durationMs: number | null,
): void {
  if (durationMs === null) {
    return;
  }

  const normalizedToolName = classifyCapability({
    capability_name: task.tool_name,
  }).name;
  const capability = events.find(
    (event) =>
      event.event_type === "capability_usage" &&
      event.session_id === task.session_id &&
      (task.turn_id ? event.turn_id === task.turn_id : true) &&
      (event.capability_name === task.tool_name || event.capability_name === normalizedToolName),
  );

  if (capability?.event_type === "capability_usage") {
    capability.duration_ms ??= durationMs;
  }
}

function mergeTranscriptCapabilities(
  events: NormalizedEvent[],
  task: CodexStopEnrichmentTask,
  capabilities: TranscriptCapabilityUsage[],
): void {
  for (const capability of capabilities) {
    const event = createTranscriptCapabilityEvent(events, task, capability);
    if (!hasSimilarCapabilityEvent(events, event)) {
      events.push(event);
    }
  }
}

function createTranscriptCapabilityEvent(
  events: NormalizedEvent[],
  task: CodexStopEnrichmentTask,
  capability: TranscriptCapabilityUsage,
): CapabilityUsageEvent {
  const sourceEvent = findSourceEventForTranscriptCapability(events, task, capability.turn_id);
  const eventWithoutId: Omit<CapabilityUsageEvent, "event_id"> = {
    schema_version: "1.0",
    event_type: "capability_usage",
    occurred_at: capability.occurred_at,
    agent: "codex",
    source: "codex-transcript",
    session_id: task.session_id,
    turn_id: capability.turn_id,
    repo_hash: sourceEvent?.repo_hash ?? null,
    status: capability.status,
    capability_type: capability.capability_type,
    capability_name: capability.capability_name,
    duration_ms: capability.duration_ms,
    input_tokens: null,
    output_tokens: null,
    total_tokens: null,
    adopted: "unknown",
    attribution_confidence: capability.attribution_confidence,
    invocation_origin: capability.invocation_origin,
    attribution_basis: capability.attribution_basis,
    attribution_score: capability.attribution_score,
    attribution_reason: capability.attribution_reason,
    attribution_context_source: capability.attribution_context_source,
  };

  return validateNormalizedEvent({
    ...eventWithoutId,
    event_id: createEventId(eventWithoutId),
  }) as CapabilityUsageEvent;
}

function findSourceEventForTranscriptCapability(
  events: NormalizedEvent[],
  task: CodexStopEnrichmentTask,
  turnId: string | null,
): NormalizedEvent | undefined {
  return (
    events.find(
      (event) =>
        event.session_id === task.session_id &&
        event.turn_id === turnId &&
        event.repo_hash,
    ) ??
    events.find((event) => event.session_id === task.session_id && event.repo_hash)
  );
}

function hasSimilarCapabilityEvent(
  events: NormalizedEvent[],
  candidate: CapabilityUsageEvent,
): boolean {
  return events.some((event) => {
    if (
      event.event_type !== "capability_usage" ||
      event.session_id !== candidate.session_id ||
      event.turn_id !== candidate.turn_id ||
      event.capability_type !== candidate.capability_type ||
      event.capability_name !== candidate.capability_name
    ) {
      return false;
    }

    if (candidate.capability_type === "skill") {
      return true;
    }

    const eventMs = parseTimestampMs(event.occurred_at);
    const candidateMs = parseTimestampMs(candidate.occurred_at);
    return (
      event.event_id === candidate.event_id ||
      (eventMs !== null &&
        candidateMs !== null &&
        Math.abs(eventMs - candidateMs) <= TOKEN_TIMESTAMP_TOLERANCE_MS)
    );
  });
}

function shouldCollectTranscriptCapability(
  transcriptTurnId: string | null,
  stopTurnId: string | null,
): boolean {
  return Boolean(stopTurnId && transcriptTurnId === stopTurnId);
}

function getMcpResultStatus(resultValue: unknown): EventStatus {
  const result = getRecord(resultValue);
  if (!result) {
    return "unknown";
  }

  if (Object.hasOwn(result, "Ok") || Object.hasOwn(result, "ok")) {
    return "success";
  }

  if (Object.hasOwn(result, "Err") || Object.hasOwn(result, "err")) {
    return "failure";
  }

  return "unknown";
}

async function resolveTranscriptPathFromCodexState(sessionId: string): Promise<string | null> {
  const stateDbPath = await resolveCodexStateDbPath();
  if (!stateDbPath) {
    return null;
  }

  let db: Database.Database | null = null;
  try {
    db = new Database(stateDbPath, { readonly: true, fileMustExist: true });
    const row = db
      .prepare("select rollout_path from threads where id = ?")
      .get(sessionId) as CodexThreadRow | undefined;

    return getString(row?.rollout_path) ?? null;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

async function resolveCodexStateDbPath(): Promise<string | null> {
  const codexHome =
    process.env.CODEX_HOME && process.env.CODEX_HOME.trim().length > 0
      ? path.resolve(process.env.CODEX_HOME)
      : path.join(homedir(), ".codex");

  try {
    const entries = await readdir(codexHome, { withFileTypes: true });
    const stateDbNames = entries
      .filter((entry) => entry.isFile() && /^state_\d+\.sqlite$/.test(entry.name))
      .map((entry) => entry.name)
      .sort((left, right) => getStateDbVersion(right) - getStateDbVersion(left));

    return stateDbNames[0] ? path.join(codexHome, stateDbNames[0]) : null;
  } catch {
    return null;
  }
}

function findLatestSnapshot(
  snapshots: TokenSnapshot[],
  predicate: (snapshot: TokenSnapshot) => boolean,
): TokenSnapshot | null {
  for (let index = snapshots.length - 1; index >= 0; index -= 1) {
    const snapshot = snapshots[index];
    if (snapshot && predicate(snapshot)) {
      return snapshot;
    }
  }

  return null;
}

function subtractTokenUsage(end: TokenUsage, baseline: TokenUsage): TokenUsage {
  const inputTokens = subtractNullableInteger(end.input_tokens, baseline.input_tokens);
  const outputTokens = subtractNullableInteger(end.output_tokens, baseline.output_tokens);
  const totalTokens =
    subtractNullableInteger(end.total_tokens, baseline.total_tokens) ??
    (inputTokens !== null || outputTokens !== null
      ? (inputTokens ?? 0) + (outputTokens ?? 0)
      : null);

  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
  };
}

function subtractNullableInteger(
  value: number | null,
  baseline: number | null,
): number | null {
  if (value === null || baseline === null || value < baseline) {
    return null;
  }

  return value - baseline;
}

function getTokenUsage(value: RawRecord | null): TokenUsage | null {
  if (!value) {
    return null;
  }

  const totalTokens = getInteger(value.total_tokens);
  const inputTokens = getInteger(value.input_tokens);
  const outputTokens = getInteger(value.output_tokens);

  if (totalTokens === null && inputTokens === null && outputTokens === null) {
    return null;
  }

  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
  };
}

function parseJsonRecord(line: string): RawRecord | null {
  try {
    const parsed = JSON.parse(line) as unknown;
    return getRecord(parsed);
  } catch {
    return null;
  }
}

function getRawEvents(payload: unknown): RawRecord[] {
  if (Array.isArray(payload)) {
    return payload.filter(isRecord);
  }

  if (!isRecord(payload)) {
    return [];
  }

  const events = payload.events;
  return Array.isArray(events) ? events.filter(isRecord) : [payload];
}

function getRecord(value: unknown): RawRecord | null {
  return isRecord(value) ? value : null;
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function getInteger(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    Number.isSafeInteger(value) &&
    value >= 0
    ? value
    : null;
}

function parseDurationMs(value: unknown): number | null {
  const duration = getRecord(value);
  if (!duration) {
    return null;
  }

  const seconds = getInteger(duration.secs);
  const nanos = getInteger(duration.nanos);
  if (seconds === null && nanos === null) {
    return null;
  }

  return Math.round((seconds ?? 0) * 1_000 + (nanos ?? 0) / 1_000_000);
}

function parseTimestampMs(value: unknown): number | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }

  const timestampMs = Date.parse(value);
  return Number.isNaN(timestampMs) ? null : timestampMs;
}

function getStateDbVersion(fileName: string): number {
  const match = /^state_(\d+)\.sqlite$/.exec(fileName);
  return match ? Number(match[1]) : 0;
}

function isRecord(value: unknown): value is RawRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
