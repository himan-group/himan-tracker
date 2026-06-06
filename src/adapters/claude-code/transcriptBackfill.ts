import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import type { AdapterEvent, EventStatus, TokenUsage } from "../../types/events.js";

type RawRecord = Record<string, unknown>;

export type ClaudeCodeTranscriptBackfillOptions = {
  transcriptDir: string;
};

export type ClaudeCodeTranscriptBackfillResult = {
  transcriptFiles: string[];
  events: AdapterEvent[];
};

export async function parseClaudeCodeTranscriptBackfill(
  options: ClaudeCodeTranscriptBackfillOptions,
): Promise<ClaudeCodeTranscriptBackfillResult> {
  const transcriptDir = options.transcriptDir;

  let entries;
  try {
    entries = await readdir(transcriptDir, { withFileTypes: true });
  } catch {
    return { transcriptFiles: [], events: [] };
  }

  const jsonlFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => path.join(transcriptDir, entry.name))
    .sort();

  const events: AdapterEvent[] = [];
  const transcriptFiles: string[] = [];

  for (const filePath of jsonlFiles) {
    const sessionId = path.basename(filePath, ".jsonl");
    const sessionEvents = await parseTranscriptFile(filePath, sessionId);
    if (sessionEvents.length > 0) {
      events.push(...sessionEvents);
      transcriptFiles.push(filePath);
    }
  }

  return { transcriptFiles, events };
}

async function parseTranscriptFile(
  filePath: string,
  sessionId: string,
): Promise<AdapterEvent[]> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch {
    return [];
  }

  const lines = raw.split(/\r?\n/);

  // Collect all assistant message rows, grouped by message.id.
  // Each message may span multiple rows (split-block format).
  const assistantRows = new Map<string, RawRecord[]>();
  let sessionStartedAt: string | null = null;
  let sessionEndedAt: string | null = null;
  let repoPath: string | undefined;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }

    let record: RawRecord;
    try {
      record = JSON.parse(trimmed);
    } catch {
      continue;
    }

    const type = getString(record.type);

    // Track session boundaries from first/last timestamp
    const timestamp = getString(record.timestamp);
    if (timestamp && (!sessionStartedAt || timestamp < sessionStartedAt)) {
      sessionStartedAt = timestamp;
    }
    if (timestamp && (!sessionEndedAt || timestamp > sessionEndedAt)) {
      sessionEndedAt = timestamp;
    }

    // Capture cwd from the first record that has it
    if (!repoPath) {
      repoPath = getString(record.cwd);
    }

    if (type === "assistant") {
      const message = getRecord(record.message);
      if (message) {
        const messageId = getString(message.id) ?? `${sessionId}-${assistantRows.size}`;
        const rows = assistantRows.get(messageId) ?? [];
        rows.push(record);
        assistantRows.set(messageId, rows);
      }
    }
  }

  const events: AdapterEvent[] = [];

  // Process each assistant message group as a turn
  for (const [messageId, rows] of assistantRows) {
    // All rows for a message share the same usage and model.
    // Pick the first row that has usage info.
    const usageRow = rows.find((r) => getRecord(r.message)?.usage);
    const message = usageRow ? getRecord(usageRow.message) : getRecord(rows[0]?.message);
    if (!message) continue;

    const usage = getRecord(message.usage);
    const model = getString(message.model);

    // Collect all content blocks across all rows for this message (split-block format).
    const content: RawRecord[] = [];
    for (const row of rows) {
      const rowMessage = getRecord(row.message);
      if (rowMessage && Array.isArray(rowMessage.content)) {
        content.push(...rowMessage.content.filter(isRecord));
      }
    }

    // Determine occurred_at from the first row's timestamp
    const firstTimestamp = rows.length > 0 ? getString(rows[0]?.timestamp) : undefined;
    const occurredAt = firstTimestamp;

    // Emit turn_summary if we have usage info
    if (usage) {
      const turnEvent: AdapterEvent = {
        event_type: "turn_summary",
        occurred_at: occurredAt ?? "",
        agent: "claude-code",
        source: "claude-code-transcript",
        session_id: sessionId,
        turn_id: messageId,
        repo_path: repoPath,
        model,
        duration_ms: computeTurnDuration(rows),
        input_tokens: getNumber(usage.input_tokens),
        cached_input_tokens: getNumber(usage.cache_read_input_tokens) ?? getNumber(usage.cached_input_tokens),
        output_tokens: getNumber(usage.output_tokens),
        total_tokens: getNumber(usage.total_tokens) ?? computeTotalTokens(usage),
        status: "success",
      };

      if (turnEvent.occurred_at) {
        events.push(turnEvent);
      }
    } else {
      // Emit turn_summary without token data
      const turnEvent: AdapterEvent = {
        event_type: "turn_summary",
        occurred_at: occurredAt ?? "",
        agent: "claude-code",
        source: "claude-code-transcript",
        session_id: sessionId,
        turn_id: messageId,
        repo_path: repoPath,
        model,
        duration_ms: computeTurnDuration(rows),
        status: "success",
      };

      if (turnEvent.occurred_at) {
        events.push(turnEvent);
      }
    }

    // Emit capability_usage for each tool_use in the content blocks
    for (const block of content) {
      const blockType = getString(block.type);
      if (blockType !== "tool_use") continue;

      const toolName = getString(block.name);
      if (!toolName) continue;

      const toolEvent: AdapterEvent = {
        event_type: "capability_usage",
        occurred_at: occurredAt ?? "",
        agent: "claude-code",
        source: "claude-code-transcript",
        session_id: sessionId,
        turn_id: messageId,
        repo_path: repoPath,
        capability_name: toolName,
        ...(usage ? normalizeTokenUsage(usage) : {}),
        status: getStatus(rows[0]?.status),
        adopted: "unknown",
        attribution_confidence: "unknown",
        invocation_origin: "observed",
        attribution_basis: "transcript_tool_name",
        attribution_score: 40,
        attribution_reason: "Tool call observed from Claude Code transcript.",
        attribution_context_source: "transcript_only",
      };

      if (toolEvent.occurred_at) {
        events.push(toolEvent);
      }
    }
  }

  // Emit session_summary
  if (sessionStartedAt) {
    events.push({
      event_type: "session_summary",
      occurred_at: sessionEndedAt ?? sessionStartedAt,
      agent: "claude-code",
      source: "claude-code-transcript",
      session_id: sessionId,
      turn_id: null,
      repo_path: repoPath,
      turn_count: assistantRows.size,
      duration_ms: computeSessionDuration(sessionStartedAt, sessionEndedAt),
      status: "success",
    });
  }

  return events;
}

function computeTurnDuration(rows: RawRecord[]): number | null {
  const timestamps = rows
    .map((r) => getString(r.timestamp))
    .filter((t): t is string => t !== undefined)
    .sort();

  if (timestamps.length < 2) return null;

  const start = new Date(timestamps[0]).getTime();
  const end = new Date(timestamps[timestamps.length - 1]).getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) return null;

  return end - start;
}

function computeSessionDuration(startedAt: string | null, endedAt: string | null): number | null {
  if (!startedAt || !endedAt) return null;
  const start = new Date(startedAt).getTime();
  const end = new Date(endedAt).getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return end - start;
}

function computeTotalTokens(usage: RawRecord): number | null {
  const input = getNumber(usage.input_tokens);
  const output = getNumber(usage.output_tokens);
  if (input === undefined && output === undefined) return null;
  return (input ?? 0) + (output ?? 0);
}

function normalizeTokenUsage(usage: RawRecord): Partial<TokenUsage> {
  return {
    input_tokens: getNumber(usage.input_tokens) ?? null,
    cached_input_tokens: getNumber(usage.cache_read_input_tokens) ?? getNumber(usage.cached_input_tokens) ?? null,
    output_tokens: getNumber(usage.output_tokens) ?? null,
    total_tokens: getNumber(usage.total_tokens) ?? computeTotalTokens(usage),
  };
}

function getRecord(value: unknown): RawRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as RawRecord : null;
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function getNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function getStatus(value: unknown): EventStatus | undefined {
  return value === "success" || value === "failure" || value === "cancelled" || value === "unknown"
    ? value
    : undefined;
}

function isRecord(value: unknown): value is RawRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
