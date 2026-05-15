import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import {
  extractExplicitSkillNames,
  extractSkillNamesFromToolCall,
  type HimanLockSkillCache,
} from "./skillEvidence.js";
import type {
  AdapterEvent,
  AttributionConfidence,
  CapabilityInvocationOrigin,
  EventStatus,
  TokenUsage,
} from "../../types/events.js";

type RawRecord = Record<string, unknown>;

export type CodexTranscriptBackfillResult = {
  transcriptFiles: string[];
  events: AdapterEvent[];
};

type SessionState = {
  sessionId: string;
  cwd: string | null;
  startedAt: string | null;
};

type TurnState = {
  turnId: string;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  cwd: string | null;
  model: string | null;
};

type ToolCallState = {
  callId: string;
  name: string;
  turnId: string | null;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  status: EventStatus;
};

type McpToolEnd = {
  callId: string;
  occurredAt: string;
  turnId: string | null;
  capabilityName: string;
  durationMs: number | null;
  status: EventStatus;
};

type TokenSnapshot = {
  timestampMs: number;
  usage: TokenUsage;
};

type SkillUsage = {
  skillName: string;
  occurredAt: string;
  turnId: string | null;
  attributionConfidence: AttributionConfidence;
  invocationOrigin: CapabilityInvocationOrigin;
};

const TOKEN_TIMESTAMP_TOLERANCE_MS = 5_000;

export async function parseCodexTranscriptBackfill(options: {
  transcriptDir: string;
}): Promise<CodexTranscriptBackfillResult> {
  const transcriptFiles = await listTranscriptFiles(options.transcriptDir);
  const events = (
    await Promise.all(transcriptFiles.map((transcriptPath) => parseTranscriptFile(transcriptPath)))
  ).flat();

  return {
    transcriptFiles,
    events,
  };
}

async function listTranscriptFiles(transcriptDir: string): Promise<string[]> {
  try {
    const entries = await readdir(transcriptDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .map((entry) => path.join(transcriptDir, entry.name))
      .sort();
  } catch (error) {
    if (isMissingFileError(error)) {
      return [];
    }

    throw error;
  }
}

async function parseTranscriptFile(transcriptPath: string): Promise<AdapterEvent[]> {
  const rawTranscript = await readFile(transcriptPath, "utf8");
  const session = createSessionState(transcriptPath);
  const turns = new Map<string, TurnState>();
  const toolCalls = new Map<string, ToolCallState>();
  const mcpToolEnds = new Map<string, McpToolEnd>();
  const skillUsages = new Map<string, SkillUsage>();
  const himanLockSkillCache: HimanLockSkillCache = new Map();
  const tokenSnapshots: TokenSnapshot[] = [];
  let currentTurnId: string | null = null;

  for (const line of rawTranscript.split(/\r?\n/)) {
    if (line.trim().length === 0) {
      continue;
    }

    const record = parseJsonRecord(line);
    if (!record) {
      continue;
    }

    const timestamp = getString(record.timestamp);
    if (!timestamp) {
      continue;
    }

    const payload = getRecord(record.payload);

    if (record.type === "session_meta" && payload) {
      session.sessionId = getString(payload.id) ?? session.sessionId;
      session.cwd = getString(payload.cwd) ?? session.cwd;
      session.startedAt = getString(payload.timestamp) ?? session.startedAt ?? timestamp;
      continue;
    }

    if (record.type === "turn_context" && payload) {
      const turnId = getString(payload.turn_id);
      if (!turnId) {
        continue;
      }

      currentTurnId = turnId;
      const turn = getOrCreateTurn(turns, turnId);
      turn.startedAt ??= timestamp;
      turn.cwd = getString(payload.cwd) ?? turn.cwd ?? session.cwd;
      turn.model = getString(payload.model) ?? turn.model;
      continue;
    }

    if (!payload) {
      continue;
    }

    if (record.type === "response_item") {
      await parseResponseItem({
        payload,
        timestamp,
        currentTurnId,
        toolCalls,
        skillUsages,
        himanLockSkillCache,
      });
      continue;
    }

    if (record.type !== "event_msg") {
      continue;
    }

    if (payload.type === "task_started") {
      const turnId = getString(payload.turn_id);
      if (!turnId) {
        continue;
      }

      currentTurnId = turnId;
      const turn = getOrCreateTurn(turns, turnId);
      turn.startedAt = timestamp;
      turn.cwd ??= session.cwd;
      continue;
    }

    if (payload.type === "user_message") {
      const skillNames = extractExplicitSkillNames(getString(payload.message));
      for (const skillName of skillNames) {
        upsertSkillUsage(skillUsages, {
          skillName,
          occurredAt: timestamp,
          turnId: currentTurnId,
          attributionConfidence: "exact",
          invocationOrigin: "explicit",
        });
      }
      continue;
    }

    if (payload.type === "task_complete") {
      const turnId = getString(payload.turn_id) ?? currentTurnId;
      if (!turnId) {
        continue;
      }

      const turn = getOrCreateTurn(turns, turnId);
      turn.completedAt = timestamp;
      turn.durationMs = getInteger(payload.duration_ms) ?? inferDurationMs(turn.startedAt, timestamp);
      turn.cwd ??= session.cwd;
      continue;
    }

    if (payload.type === "token_count") {
      const usage = getTokenUsage(getRecord(getRecord(payload.info)?.total_token_usage));
      const timestampMs = Date.parse(timestamp);
      if (usage && !Number.isNaN(timestampMs)) {
        tokenSnapshots.push({ timestampMs, usage });
      }
      continue;
    }

    if (payload.type === "mcp_tool_call_end") {
      const mcpEnd = parseMcpToolEnd(payload, timestamp, currentTurnId, toolCalls);
      if (mcpEnd) {
        mcpToolEnds.set(mcpEnd.callId, mcpEnd);
      }
    }
  }

  return buildAdapterEvents({
    session,
    turns,
    toolCalls,
    mcpToolEnds,
    skillUsages,
    tokenSnapshots,
  });
}

function createSessionState(transcriptPath: string): SessionState {
  return {
    sessionId: path.basename(transcriptPath, ".jsonl"),
    cwd: null,
    startedAt: null,
  };
}

async function parseResponseItem(options: {
  payload: RawRecord;
  timestamp: string;
  currentTurnId: string | null;
  toolCalls: Map<string, ToolCallState>;
  skillUsages: Map<string, SkillUsage>;
  himanLockSkillCache: HimanLockSkillCache;
}): Promise<void> {
  const payloadType = getString(options.payload.type);

  if (payloadType === "function_call" || payloadType === "custom_tool_call") {
    const callId = getString(options.payload.call_id);
    const name = normalizeTranscriptToolName(getString(options.payload.name));
    if (!callId || !name) {
      return;
    }

    options.toolCalls.set(callId, {
      callId,
      name,
      turnId: options.currentTurnId,
      startedAt: options.timestamp,
      completedAt: null,
      durationMs: null,
      status: getStatus(options.payload.status),
    });

    for (const skillName of await extractSkillNamesFromToolCall(
      options.payload,
      options.himanLockSkillCache,
    )) {
      upsertSkillUsage(options.skillUsages, {
        skillName,
        occurredAt: options.timestamp,
        turnId: options.currentTurnId,
        attributionConfidence: "estimated",
        invocationOrigin: "inferred",
      });
    }
    return;
  }

  if (payloadType !== "function_call_output" && payloadType !== "custom_tool_call_output") {
    return;
  }

  const callId = getString(options.payload.call_id);
  const toolCall = callId ? options.toolCalls.get(callId) : undefined;
  if (!toolCall) {
    return;
  }

  toolCall.completedAt = options.timestamp;
  toolCall.durationMs = inferDurationMs(toolCall.startedAt, options.timestamp);
  toolCall.status = getStatus(options.payload.status);
}

function parseMcpToolEnd(
  payload: RawRecord,
  timestamp: string,
  currentTurnId: string | null,
  toolCalls: Map<string, ToolCallState>,
): McpToolEnd | null {
  const callId = getString(payload.call_id);
  const invocation = getRecord(payload.invocation);
  const server = getString(invocation?.server);
  const tool = getString(invocation?.tool);
  if (!callId || !server || !tool) {
    return null;
  }

  const callStart = toolCalls.get(callId);
  return {
    callId,
    occurredAt: timestamp,
    turnId: getString(payload.turn_id) ?? callStart?.turnId ?? currentTurnId,
    capabilityName: `${server}.${tool}`,
    durationMs:
      parseDurationMs(payload.duration) ??
      getInteger(payload.duration_ms) ??
      (callStart ? inferDurationMs(callStart.startedAt, timestamp) : null),
    status: getMcpResultStatus(payload.result),
  };
}

function buildAdapterEvents(options: {
  session: SessionState;
  turns: Map<string, TurnState>;
  toolCalls: Map<string, ToolCallState>;
  mcpToolEnds: Map<string, McpToolEnd>;
  skillUsages: Map<string, SkillUsage>;
  tokenSnapshots: TokenSnapshot[];
}): AdapterEvent[] {
  const events: AdapterEvent[] = [];
  const completedTurns = [...options.turns.values()].filter((turn) => turn.completedAt);

  for (const turn of completedTurns) {
    const tokenUsage = resolveTurnTokenUsage(turn, options.tokenSnapshots);
    events.push({
      event_type: "turn_summary",
      identity_key: `codex-transcript:turn:${turn.turnId}`,
      occurred_at: turn.completedAt ?? turn.startedAt ?? options.session.startedAt ?? new Date(0).toISOString(),
      agent: "codex",
      source: "codex-transcript",
      session_id: options.session.sessionId,
      turn_id: turn.turnId,
      repo_path: turn.cwd ?? options.session.cwd,
      status: "success",
      model: turn.model,
      duration_ms: turn.durationMs,
      ...tokenUsage,
    });
  }

  const sessionSummary = createSessionSummary(options.session, completedTurns);
  if (sessionSummary) {
    events.push(sessionSummary);
  }

  for (const skillUsage of options.skillUsages.values()) {
    events.push({
      event_type: "capability_usage",
      identity_key: `codex-transcript:skill:${skillUsage.turnId ?? "session"}:${skillUsage.skillName}`,
      occurred_at: skillUsage.occurredAt,
      agent: "codex",
      source: "codex-transcript",
      session_id: options.session.sessionId,
      turn_id: skillUsage.turnId,
      repo_path: findTurn(options.turns, skillUsage.turnId)?.cwd ?? options.session.cwd,
      status: "unknown",
      capability_type: "skill",
      capability_name: skillUsage.skillName,
      duration_ms: null,
      attribution_confidence: skillUsage.attributionConfidence,
      invocation_origin: skillUsage.invocationOrigin,
    });
  }

  for (const mcpEnd of options.mcpToolEnds.values()) {
    events.push({
      event_type: "capability_usage",
      identity_key: `codex-transcript:mcp:${mcpEnd.callId}:${mcpEnd.capabilityName}`,
      occurred_at: mcpEnd.occurredAt,
      agent: "codex",
      source: "codex-transcript",
      session_id: options.session.sessionId,
      turn_id: mcpEnd.turnId,
      repo_path: findTurn(options.turns, mcpEnd.turnId)?.cwd ?? options.session.cwd,
      status: mcpEnd.status,
      capability_type: "mcp_tool",
      capability_name: mcpEnd.capabilityName,
      duration_ms: mcpEnd.durationMs,
      attribution_confidence: "exact",
      invocation_origin: "observed",
    });
  }

  for (const toolCall of options.toolCalls.values()) {
    if (!toolCall.completedAt || options.mcpToolEnds.has(toolCall.callId)) {
      continue;
    }

    events.push({
      event_type: "capability_usage",
      identity_key: `codex-transcript:tool:${toolCall.callId}:${toolCall.name}`,
      occurred_at: toolCall.completedAt,
      agent: "codex",
      source: "codex-transcript",
      session_id: options.session.sessionId,
      turn_id: toolCall.turnId,
      repo_path: findTurn(options.turns, toolCall.turnId)?.cwd ?? options.session.cwd,
      status: toolCall.status,
      capability_name: toolCall.name,
      duration_ms: toolCall.durationMs,
      attribution_confidence: "exact",
      invocation_origin: "observed",
    });
  }

  return events;
}

function upsertSkillUsage(skillUsages: Map<string, SkillUsage>, usage: SkillUsage): void {
  const key = `${usage.turnId ?? ""}\u001f${usage.skillName}`;
  const existing = skillUsages.get(key);
  if (existing?.invocationOrigin === "explicit") {
    return;
  }

  if (usage.invocationOrigin === "explicit" || !existing) {
    skillUsages.set(key, usage);
  }
}

function createSessionSummary(
  session: SessionState,
  completedTurns: TurnState[],
): AdapterEvent | null {
  if (completedTurns.length === 0) {
    return null;
  }

  const completedTimes = completedTurns
    .map((turn) => turn.completedAt)
    .filter((value): value is string => Boolean(value))
    .sort();
  const startMs = Math.min(
    ...completedTurns
      .map((turn) => (turn.startedAt ? Date.parse(turn.startedAt) : Number.NaN))
      .filter((value) => !Number.isNaN(value)),
  );
  const endMs = Date.parse(completedTimes.at(-1) ?? "");

  return {
    event_type: "session_summary",
    identity_key: `codex-transcript:session:${session.sessionId}`,
    occurred_at: completedTimes.at(-1) ?? session.startedAt ?? new Date(0).toISOString(),
    agent: "codex",
    source: "codex-transcript",
    session_id: session.sessionId,
    turn_id: null,
    repo_path: session.cwd,
    status: "success",
    turn_count: completedTurns.length,
    duration_ms:
      !Number.isNaN(startMs) && !Number.isNaN(endMs) && endMs >= startMs ? endMs - startMs : null,
  };
}

function resolveTurnTokenUsage(turn: TurnState, tokenSnapshots: TokenSnapshot[]): Partial<TokenUsage> {
  const startMs = turn.startedAt ? Date.parse(turn.startedAt) : Number.NaN;
  const endMs = turn.completedAt ? Date.parse(turn.completedAt) : Number.NaN;
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) {
    return {};
  }

  const endSnapshot = findLatestSnapshot(
    tokenSnapshots,
    (snapshot) => snapshot.timestampMs <= endMs + TOKEN_TIMESTAMP_TOLERANCE_MS,
  );
  if (!endSnapshot) {
    return {};
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

  return subtractTokenUsage(endSnapshot.usage, baseline);
}

function findLatestSnapshot(
  snapshots: TokenSnapshot[],
  predicate: (snapshot: TokenSnapshot) => boolean,
): TokenSnapshot | null {
  let latest: TokenSnapshot | null = null;
  for (const snapshot of snapshots) {
    if (predicate(snapshot) && (!latest || snapshot.timestampMs >= latest.timestampMs)) {
      latest = snapshot;
    }
  }
  return latest;
}

function subtractTokenUsage(end: TokenUsage, baseline: TokenUsage): TokenUsage {
  return {
    input_tokens: subtractNullable(end.input_tokens, baseline.input_tokens),
    output_tokens: subtractNullable(end.output_tokens, baseline.output_tokens),
    total_tokens: subtractNullable(end.total_tokens, baseline.total_tokens),
  };
}

function subtractNullable(left: number | null, right: number | null): number | null {
  if (left === null) {
    return null;
  }

  return Math.max(0, left - (right ?? 0));
}

function findTurn(turns: Map<string, TurnState>, turnId: string | null): TurnState | undefined {
  return turnId ? turns.get(turnId) : undefined;
}

function getOrCreateTurn(turns: Map<string, TurnState>, turnId: string): TurnState {
  const existingTurn = turns.get(turnId);
  if (existingTurn) {
    return existingTurn;
  }

  const turn: TurnState = {
    turnId,
    startedAt: null,
    completedAt: null,
    durationMs: null,
    cwd: null,
    model: null,
  };
  turns.set(turnId, turn);
  return turn;
}

function normalizeTranscriptToolName(name: string | undefined): string | null {
  if (!name) {
    return null;
  }

  if (name === "exec_command") {
    return "functions.exec_command";
  }

  if (name === "update_plan") {
    return "functions.update_plan";
  }

  return name;
}

function getTokenUsage(value: RawRecord | null): TokenUsage | null {
  if (!value) {
    return null;
  }

  const inputTokens = getInteger(value.input_tokens);
  const outputTokens = getInteger(value.output_tokens);
  const totalTokens = getInteger(value.total_tokens);
  if (inputTokens === null && outputTokens === null && totalTokens === null) {
    return null;
  }

  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens ?? (inputTokens ?? 0) + (outputTokens ?? 0),
  };
}

function getMcpResultStatus(result: unknown): EventStatus {
  const resultRecord = getRecord(result);
  if (!resultRecord) {
    return "unknown";
  }

  if ("Ok" in resultRecord || "ok" in resultRecord) {
    return "success";
  }

  if ("Err" in resultRecord || "err" in resultRecord || "error" in resultRecord) {
    return "failure";
  }

  return "unknown";
}

function getStatus(value: unknown): EventStatus {
  return value === "success" || value === "failure" || value === "cancelled" || value === "unknown"
    ? value
    : "unknown";
}

function parseDurationMs(value: unknown): number | null {
  const duration = getRecord(value);
  if (!duration) {
    return null;
  }

  const secs = getInteger(duration.secs) ?? 0;
  const nanos = getInteger(duration.nanos) ?? 0;
  return secs * 1000 + Math.round(nanos / 1_000_000);
}

function inferDurationMs(startedAt: string | null, completedAt: string): number | null {
  if (!startedAt) {
    return null;
  }

  const startedMs = Date.parse(startedAt);
  const completedMs = Date.parse(completedAt);
  if (Number.isNaN(startedMs) || Number.isNaN(completedMs) || completedMs < startedMs) {
    return null;
  }

  return completedMs - startedMs;
}

function parseJsonRecord(line: string): RawRecord | null {
  try {
    const parsed = JSON.parse(line) as unknown;
    return getRecord(parsed);
  } catch {
    return null;
  }
}

function getRecord(value: unknown): RawRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as RawRecord)
    : null;
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function getInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
