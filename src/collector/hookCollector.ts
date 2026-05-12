import type { TrackerPaths } from "../config/paths.js";
import { resolveTrackerPaths } from "../config/paths.js";
import { readOrCreateUserConfig } from "../config/userConfig.js";
import { normalizeEvent } from "../normalizer/normalizeEvent.js";
import type { UserConfig } from "../types/config.js";
import type { AdapterEvent, AgentName, NormalizedEvent } from "../types/events.js";
import { appendJsonlRecord } from "./jsonlWriter.js";

export type CollectorErrorRecord = {
  schema_version: "1.0";
  occurred_at: string;
  source: "collector";
  agent?: AgentName;
  message: string;
  details: Record<string, string>;
};

export type CollectAdapterEventOptions = {
  paths?: TrackerPaths;
  config?: UserConfig;
  now?: () => Date;
};

export type CollectAdapterEventResult =
  | {
      ok: true;
      accepted: true;
      event: NormalizedEvent;
    }
  | {
      ok: true;
      accepted: false;
      error: CollectorErrorRecord;
      error_logged: boolean;
    };

export async function collectAdapterEvent(
  event: AdapterEvent,
  options: CollectAdapterEventOptions = {},
): Promise<CollectAdapterEventResult> {
  const paths = options.paths ?? resolveTrackerPaths();
  const now = options.now ?? (() => new Date());

  try {
    const config = options.config ?? (await readOrCreateUserConfig(paths));
    const normalizedEvent = normalizeEvent(event, config);
    await appendJsonlRecord(paths.eventsPath, normalizedEvent);

    return {
      ok: true,
      accepted: true,
      event: normalizedEvent,
    };
  } catch (error) {
    const errorRecord = createCollectorErrorRecord(event, error, now());
    const errorLogged = await appendCollectorError(paths.errorsPath, errorRecord);

    return {
      ok: true,
      accepted: false,
      error: errorRecord,
      error_logged: errorLogged,
    };
  }
}

export async function appendCollectorError(
  errorsPath: string,
  errorRecord: CollectorErrorRecord,
): Promise<boolean> {
  try {
    await appendJsonlRecord(errorsPath, errorRecord);
    return true;
  } catch {
    return false;
  }
}

function createCollectorErrorRecord(
  event: AdapterEvent,
  error: unknown,
  occurredAt: Date,
): CollectorErrorRecord {
  const details: Record<string, string> = {
    reason: sanitizeErrorMessage(error),
  };
  const eventType = getSafeString((event as { event_type?: unknown }).event_type);
  if (eventType) {
    details.event_type = eventType;
  }

  return {
    schema_version: "1.0",
    occurred_at: occurredAt.toISOString(),
    source: "collector",
    ...(isAgentName((event as { agent?: unknown }).agent) ? { agent: event.agent } : {}),
    message: "collector failed",
    details,
  };
}

function sanitizeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").slice(0, 500);
}

function getSafeString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isAgentName(value: unknown): value is AgentName {
  return value === "codex" || value === "claude-code";
}
