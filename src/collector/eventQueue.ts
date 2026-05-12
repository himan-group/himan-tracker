import { randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  ensureTrackerDirectories,
  resolveDailyErrorsPath,
  resolveDailyEventsPath,
  type TrackerPaths,
} from "../config/paths.js";
import { validateNormalizedEvent } from "../normalizer/eventSchema.js";
import type { AgentName, NormalizedEvent } from "../types/events.js";
import { appendCollectorError, type CollectorErrorRecord } from "./hookCollector.js";
import { appendJsonlRecord } from "./jsonlWriter.js";

const QUEUE_SCHEMA_VERSION = "1.0";
const LOCK_STALE_MS = 5 * 60 * 1000;

export type EnqueueNormalizedEventsOptions = {
  paths: TrackerPaths;
  agent: AgentName;
  source: string;
  events: NormalizedEvent[];
  now?: () => Date;
};

export type EnqueueNormalizedEventsResult =
  | {
      queued: true;
      queuePath: string;
      eventCount: number;
    }
  | {
      queued: false;
      eventCount: 0;
    };

export type DrainQueuedEventsOptions = {
  paths: TrackerPaths;
  agent: AgentName;
  now?: () => Date;
};

export type DrainQueuedEventsResult = {
  lockAcquired: boolean;
  processedBatches: number;
  queuedEvents: number;
  writtenEvents: number;
  failedBatches: number;
  errorsLogged: number;
};

type QueuedEventBatch = {
  schema_version: typeof QUEUE_SCHEMA_VERSION;
  queued_at: string;
  agent: AgentName;
  source: string;
  events: NormalizedEvent[];
};

export async function enqueueNormalizedEvents(
  options: EnqueueNormalizedEventsOptions,
): Promise<EnqueueNormalizedEventsResult> {
  if (options.events.length === 0) {
    return {
      queued: false,
      eventCount: 0,
    };
  }

  const now = options.now ?? (() => new Date());
  const queueDir = resolveAgentQueueDir(options.paths, options.agent);
  await mkdir(queueDir, { recursive: true, mode: 0o700 });

  const queuedAt = now().toISOString();
  const queuePath = path.join(queueDir, `${formatQueueTimestamp(queuedAt)}-${randomUUID()}.json`);
  const batch: QueuedEventBatch = {
    schema_version: QUEUE_SCHEMA_VERSION,
    queued_at: queuedAt,
    agent: options.agent,
    source: options.source,
    events: options.events,
  };

  await writeFile(queuePath, `${JSON.stringify(batch)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });

  return {
    queued: true,
    queuePath,
    eventCount: options.events.length,
  };
}

export async function drainQueuedEvents(
  options: DrainQueuedEventsOptions,
): Promise<DrainQueuedEventsResult> {
  const now = options.now ?? (() => new Date());
  await ensureTrackerDirectories(options.paths);

  const releaseLock = await acquireDrainLock(options.paths, options.agent, now);
  if (!releaseLock) {
    return createDrainResult({ lockAcquired: false });
  }

  const result = createDrainResult({ lockAcquired: true });

  try {
    const queuePaths = await listQueuedBatchPaths(options.paths, options.agent);

    for (const queuePath of queuePaths) {
      let batch: QueuedEventBatch;
      try {
        batch = parseQueuedBatch(await readFile(queuePath, "utf8"));
      } catch (error) {
        result.failedBatches += 1;
        if (
          await logCollectorError(options.paths, options.agent, {
            phase: "drain",
            reason: getErrorMessage(error),
            queue_file: path.basename(queuePath),
          }, now)
        ) {
          result.errorsLogged += 1;
        }
        await removeQueuedBatch(queuePath);
        continue;
      }

      try {
        for (const event of batch.events) {
          await appendJsonlRecord(resolveDailyEventsPath(options.paths, event.occurred_at), event);
          result.writtenEvents += 1;
        }

        result.processedBatches += 1;
        result.queuedEvents += batch.events.length;
        await removeQueuedBatch(queuePath);
      } catch (error) {
        result.failedBatches += 1;
        if (
          await logCollectorError(options.paths, options.agent, {
            phase: "write_events",
            reason: getErrorMessage(error),
            queue_file: path.basename(queuePath),
          }, now)
        ) {
          result.errorsLogged += 1;
        }
      }
    }

    return result;
  } finally {
    await releaseLock();
  }
}

export async function logCollectorError(
  paths: TrackerPaths,
  agent: AgentName,
  details: Record<string, string>,
  now: () => Date = () => new Date(),
): Promise<boolean> {
  const occurredAt = now().toISOString();
  const errorRecord: CollectorErrorRecord = {
    schema_version: "1.0",
    occurred_at: occurredAt,
    source: "collector",
    agent,
    message: "collector failed",
    details: sanitizeDetails(details),
  };

  return appendCollectorError(resolveDailyErrorsPath(paths, occurredAt), errorRecord);
}

function parseQueuedBatch(rawPayload: string): QueuedEventBatch {
  const parsedPayload = JSON.parse(rawPayload) as unknown;

  if (!isRecord(parsedPayload)) {
    throw new Error("Queued payload must be a JSON object");
  }

  if (parsedPayload.schema_version !== QUEUE_SCHEMA_VERSION) {
    throw new Error("Unsupported queue payload schema version");
  }

  if (!isAgentName(parsedPayload.agent)) {
    throw new Error("Queued payload has unsupported agent");
  }

  if (!Array.isArray(parsedPayload.events)) {
    throw new Error("Queued payload must contain an events array");
  }

  return {
    schema_version: QUEUE_SCHEMA_VERSION,
    queued_at: getRequiredString(parsedPayload.queued_at, "queued_at"),
    agent: parsedPayload.agent,
    source: getRequiredString(parsedPayload.source, "source"),
    events: parsedPayload.events.map(validateNormalizedEvent),
  };
}

async function listQueuedBatchPaths(paths: TrackerPaths, agent: AgentName): Promise<string[]> {
  const queueDir = resolveAgentQueueDir(paths, agent);

  try {
    const entries = await readdir(queueDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => path.join(queueDir, entry.name))
      .sort();
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") {
      return [];
    }

    throw error;
  }
}

async function acquireDrainLock(
  paths: TrackerPaths,
  agent: AgentName,
  now: () => Date,
): Promise<(() => Promise<void>) | null> {
  await mkdir(paths.locksDir, { recursive: true, mode: 0o700 });

  const lockPath = path.join(paths.locksDir, `collect-${agent}.lock`);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const lockHandle = await open(lockPath, "wx", 0o600);
      await lockHandle.writeFile(
        `${JSON.stringify({ schema_version: QUEUE_SCHEMA_VERSION, agent, locked_at: now().toISOString() })}\n`,
      );

      return async () => {
        await lockHandle.close().catch(() => undefined);
        await rm(lockPath, { force: true }).catch(() => undefined);
      };
    } catch (error) {
      if (getErrorCode(error) !== "EEXIST") {
        throw error;
      }

      if (!(await isStaleLock(lockPath, now))) {
        return null;
      }

      await rm(lockPath, { force: true }).catch(() => undefined);
    }
  }

  return null;
}

async function isStaleLock(lockPath: string, now: () => Date): Promise<boolean> {
  try {
    const lockStat = await stat(lockPath);
    return now().getTime() - lockStat.mtimeMs > LOCK_STALE_MS;
  } catch {
    return true;
  }
}

async function removeQueuedBatch(queuePath: string): Promise<void> {
  await rm(queuePath, { force: true }).catch(() => undefined);
}

function createDrainResult(
  values: Partial<DrainQueuedEventsResult> = {},
): DrainQueuedEventsResult {
  return {
    lockAcquired: true,
    processedBatches: 0,
    queuedEvents: 0,
    writtenEvents: 0,
    failedBatches: 0,
    errorsLogged: 0,
    ...values,
  };
}

function resolveAgentQueueDir(paths: TrackerPaths, agent: AgentName): string {
  return path.join(paths.queueDir, "events", agent);
}

function formatQueueTimestamp(timestamp: string): string {
  return timestamp.replaceAll(":", "-").replaceAll(".", "-");
}

function sanitizeDetails(details: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(details).map(([key, value]) => [key, value.replace(/\s+/g, " ").slice(0, 500)]),
  );
}

function getRequiredString(value: unknown, fieldName: string): string {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }

  throw new Error(`Queued payload field ${fieldName} must be a non-empty string`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAgentName(value: unknown): value is AgentName {
  return value === "codex" || value === "claude-code";
}

function getErrorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === "string" ? error.code : undefined;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
