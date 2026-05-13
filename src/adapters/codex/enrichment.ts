import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import Database from "better-sqlite3";

import { validateNormalizedEvent } from "../../normalizer/eventSchema.js";
import type { NormalizedEvent, TokenUsage } from "../../types/events.js";

type RawRecord = Record<string, unknown>;

const TOKEN_TIMESTAMP_TOLERANCE_MS = 5_000;

export type CodexStopEnrichmentTask = {
  kind: "codex-stop";
  session_id: string;
  turn_id: string | null;
  occurred_at: string;
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
};

type CodexThreadRow = {
  rollout_path?: string | null;
};

export function collectCodexEnrichmentTasks(
  payload: unknown,
  observedAt: string,
): CodexStopEnrichmentTask[] {
  return getRawEvents(payload).flatMap((event) => {
    const hook =
      getString(event.hook) ?? getString(event.hook_event_name) ?? getString(event.type);

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
  tasks: CodexStopEnrichmentTask[],
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

      const usage = await parseTranscriptTurnUsage({
        transcriptPath,
        turnId: task.turn_id,
        occurredAt: task.occurred_at,
      });
      mergeTurnUsage(enrichedEvents, task, usage);
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
  let latestMatchingTurnStartMs: number | null = null;
  let latestTaskStartMs: number | null = null;
  let model: string | null = null;

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
      if (!options.turnId || turnId === options.turnId) {
        latestMatchingTurnStartMs = timestampMs;
        model = getString(payload?.model) ?? model;
      }
      continue;
    }

    if (record.type !== "event_msg") {
      continue;
    }

    const payload = getRecord(record.payload);
    if (payload?.type === "task_started") {
      latestTaskStartMs = timestampMs;
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
    return { model, tokenUsage: null };
  }

  const endSnapshot = findLatestSnapshot(
    tokenSnapshots,
    (snapshot) => snapshot.timestampMs <= stopMs + TOKEN_TIMESTAMP_TOLERANCE_MS,
  );
  if (!endSnapshot) {
    return { model, tokenUsage: null };
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
  };
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
