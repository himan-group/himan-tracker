import { open, readFile, stat } from "node:fs/promises";

import type { AdapterEvent, EventStatus } from "../../types/events.js";

type RawRecord = Record<string, unknown>;

type TranscriptEnrichment = {
  turn_id?: string;
  model?: string;
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
};

const MAX_TRANSCRIPT_FILE_SIZE = 5 * 1024 * 1024; // 5 MB
const TAIL_READ_SIZE = 1 * 1024 * 1024; // 1 MB tail read for large files

export type ParseClaudeCodeHookPayloadOptions = {
  observedAt?: string;
};

export async function parseClaudeCodeHookPayload(
  payload: unknown,
  options: ParseClaudeCodeHookPayloadOptions = {},
): Promise<AdapterEvent[]> {
  const results = await Promise.all(
    getRawEvents(payload).map((event) => parseClaudeCodeEvent(event, options)),
  );
  return results.flat();
}

async function parseClaudeCodeEvent(
  event: RawRecord,
  options: ParseClaudeCodeHookPayloadOptions,
): Promise<AdapterEvent[]> {
  const hookEventName = getString(event.hook_event_name);

  switch (hookEventName) {
    case "PreToolUse":
      return parseToolEvent(event, options);
    case "PostToolUse":
      return parseToolEvent(event, options);
    case "PostToolUseFailure":
      return parseToolFailureEvent(event, options);
    case "Stop":
      return await parseStop(event, options);
    case "SessionEnd":
      return parseSessionEnd(event, options);
    default:
      return [];
  }
}

function parseToolEvent(
  event: RawRecord,
  options: ParseClaudeCodeHookPayloadOptions,
): AdapterEvent[] {
  const base = createBaseEvent(event, options);
  const toolName = getToolName(event);

  if (!base || !toolName) {
    return [];
  }

  const toolUseId = getString(event.tool_use_id);
  const toolResponse = getRecord(event.tool_response);
  const status = toolResponse ? resolveToolResponseStatus(toolResponse) : undefined;

  return [
    {
      ...base,
      event_type: "capability_usage",
      capability_name: toolName,
      duration_ms: getNumber(event.duration_ms),
      status,
      attribution_confidence: "unknown",
      invocation_origin: "observed",
      attribution_basis: "transcript_tool_name",
      attribution_score: 40,
      attribution_reason: "Tool call observed from Claude Code hook event.",
      attribution_context_source: "none",
      ...(toolUseId ? { turn_id: toolUseId } : {}),
    },
  ];
}

function parseToolFailureEvent(
  event: RawRecord,
  options: ParseClaudeCodeHookPayloadOptions,
): AdapterEvent[] {
  const base = createBaseEvent(event, options);
  const toolName = getToolName(event);

  if (!base || !toolName) {
    return [];
  }

  const toolUseId = getString(event.tool_use_id);

  return [
    {
      ...base,
      event_type: "capability_usage",
      capability_name: toolName,
      status: "failure",
      attribution_confidence: "unknown",
      invocation_origin: "observed",
      attribution_basis: "transcript_tool_name",
      attribution_score: 40,
      attribution_reason: "Failed tool call observed from Claude Code hook event.",
      attribution_context_source: "none",
      ...(toolUseId ? { turn_id: toolUseId } : {}),
    },
  ];
}

async function parseStop(
  event: RawRecord,
  options: ParseClaudeCodeHookPayloadOptions,
): Promise<AdapterEvent[]> {
  const base = createBaseEvent(event, options);
  if (!base) {
    return [];
  }

  const enrichment = await enrichStopFromTranscript(event);

  return [
    {
      ...base,
      event_type: "turn_summary",
      turn_id: enrichment?.turn_id ?? base.turn_id,
      model: getString(event.model) ?? enrichment?.model ?? null,
      duration_ms: getNumber(event.duration_ms),
      input_tokens: enrichment?.input_tokens ?? null,
      cached_input_tokens: enrichment?.cached_input_tokens ?? null,
      output_tokens: enrichment?.output_tokens ?? null,
      total_tokens: enrichment?.total_tokens ?? null,
      status: "success",
    },
  ];
}

async function enrichStopFromTranscript(
  event: RawRecord,
): Promise<TranscriptEnrichment | null> {
  const transcriptPath = getString(event.transcript_path);
  if (!transcriptPath) return null;

  try {
    const content = await readTranscriptSafely(transcriptPath);
    if (!content) return null;

    // Scan from the end to find the last assistant message with usage data.
    // Claude Code transcripts use split-block format: multiple lines for one message.
    // Usage data (input_tokens, output_tokens, etc.) is in the last block of each message.
    const lines = content.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;

      let record: RawRecord;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }

      if (record.type !== "assistant") continue;

      const message = getRecord(record.message);
      if (!message) continue;

      const usage = getRecord(message.usage);
      if (!usage) continue;

      const model = getString(message.model);
      const messageId = getString(message.id);
      const inputTokens = getNumber(usage.input_tokens);
      const cachedInputTokens =
        getNumber(usage.cache_read_input_tokens) ??
        getNumber(usage.cached_input_tokens);
      const outputTokens = getNumber(usage.output_tokens);
      const totalTokens =
        getNumber(usage.total_tokens) ??
        (inputTokens !== undefined || outputTokens !== undefined
          ? (inputTokens ?? 0) + (outputTokens ?? 0)
          : undefined);

      return {
        ...(messageId ? { turn_id: messageId } : {}),
        ...(model ? { model } : {}),
        ...(inputTokens !== undefined ? { input_tokens: inputTokens } : {}),
        ...(cachedInputTokens !== undefined ? { cached_input_tokens: cachedInputTokens } : {}),
        ...(outputTokens !== undefined ? { output_tokens: outputTokens } : {}),
        ...(totalTokens !== undefined ? { total_tokens: totalTokens } : {}),
      };
    }

    return null;
  } catch {
    // Fail-open: any error reading/parsing the transcript is silently ignored.
    return null;
  }
}

async function readTranscriptSafely(filePath: string): Promise<string | null> {
  try {
    const fileStat = await stat(filePath);
    if (fileStat.size === 0) return null;

    if (fileStat.size <= MAX_TRANSCRIPT_FILE_SIZE) {
      return await readFile(filePath, "utf8");
    }

    // For large files, read only the tail portion.
    const readStart = Math.max(0, fileStat.size - TAIL_READ_SIZE);
    const fh = await open(filePath, "r");
    try {
      const buf = Buffer.alloc(fileStat.size - readStart);
      await fh.read(buf, 0, buf.length, readStart);
      // Skip the first (potentially partial) line.
      const raw = buf.toString("utf8");
      const firstNewline = raw.indexOf("\n");
      return firstNewline >= 0 ? raw.slice(firstNewline + 1) : raw;
    } finally {
      await fh.close();
    }
  } catch {
    return null;
  }
}

function parseSessionEnd(
  event: RawRecord,
  options: ParseClaudeCodeHookPayloadOptions,
): AdapterEvent[] {
  const base = createBaseEvent(event, options);
  if (!base) {
    return [];
  }

  return [
    {
      ...base,
      event_type: "session_summary",
      turn_id: null,
      turn_count: null,
      duration_ms: getNumber(event.duration_ms),
      status: "success",
    },
  ];
}

function createBaseEvent(
  event: RawRecord,
  options: ParseClaudeCodeHookPayloadOptions,
): Omit<AdapterEvent, "event_type"> | null {
  const occurredAt = options.observedAt;
  const sessionId = getString(event.session_id);

  if (!occurredAt || !sessionId) {
    return null;
  }

  return {
    occurred_at: occurredAt,
    agent: "claude-code",
    source: "claude-code-hook",
    session_id: sessionId,
    turn_id: getString(event.tool_use_id) ?? null,
    repo_path: getString(event.cwd),
    status: "unknown",
  };
}

function getToolName(event: RawRecord): string | undefined {
  return getString(event.tool_name) ?? getString(getRecord(event.tool)?.name);
}

function resolveToolResponseStatus(
  toolResponse: RawRecord,
): EventStatus | undefined {
  if ("success" in toolResponse) {
    return toolResponse.success === true
      ? "success"
      : toolResponse.success === false
        ? "failure"
        : undefined;
  }

  if (getString(toolResponse.status) === "failure") {
    return "failure";
  }

  return undefined;
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

function getNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is RawRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
