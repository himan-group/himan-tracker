import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { parseCodexTranscriptBackfill } from "../../adapters/codex/transcriptBackfill.js";
import { parseCopilotTranscriptBackfill } from "../../adapters/copilot/index.js";
import {
  ensureTrackerDirectories,
  resolveDailyEventsPath,
  resolveTrackerPaths,
  type TrackerPaths,
} from "../../config/paths.js";
import { learnKnownProjectsFromAdapterEvents } from "../../config/knownProjects.js";
import { readOrCreateUserConfig } from "../../config/userConfig.js";
import { appendJsonlRecord } from "../../collector/jsonlWriter.js";
import { normalizeEvent } from "../../normalizer/normalizeEvent.js";
import { parseDate, todayLocalDate } from "../../reports/dateRange.js";
import type { UserConfig } from "../../types/config.js";
import type { AgentName, NormalizedEvent } from "../../types/events.js";

export type BackfillCommandOptions = {
  agent?: string;
  date?: string;
  from?: string;
  paths?: TrackerPaths;
  config?: UserConfig;
  now?: () => Date;
};

export type BackfillCommandResult = {
  ok: boolean;
  lines: string[];
};

type WriteUniqueEventsResult = {
  written: number;
  skipped: number;
  eventFiles: string[];
};

type ExistingEvents = {
  eventIds: Set<string>;
  records: NormalizedEvent[];
};

const DUPLICATE_TIMESTAMP_TOLERANCE_MS = 5_000;

export async function runBackfill(
  options: BackfillCommandOptions = {},
): Promise<BackfillCommandResult> {
  const paths = options.paths ?? resolveTrackerPaths();
  const now = options.now ?? (() => new Date());

  try {
    const agent = resolveBackfillAgent(options.agent);
    const date = options.date ? parseDate(options.date) : todayLocalDate(now());
    const transcriptDir = options.from
      ? path.resolve(options.from)
      : agent === "copilot"
        ? resolveCopilotTranscriptDir()
        : resolveCodexTranscriptDir(date);

    await ensureTrackerDirectories(paths);
    const config = options.config ?? (await readOrCreateUserConfig(paths));
    const parsed = await parseAgentTranscripts(agent, transcriptDir);
    await learnKnownProjectsFromAdapterEvents({
      paths,
      config,
      events: parsed.events,
      persist: options.config === undefined,
    });
    const normalizedEvents = parsed.events.map((event) => normalizeEvent(event, config));
    const writeResult = await appendUniqueEvents(paths, normalizedEvents);

    return {
      ok: true,
      lines: [
        "himan-tracker backfill",
        "",
        `Agent: ${agent}`,
        `Date: ${date}`,
        `Transcript dir: ${transcriptDir}`,
        `Transcript files: ${parsed.transcriptFiles.length}`,
        `Parsed events: ${parsed.events.length}`,
        `Written events: ${writeResult.written}`,
        `Skipped duplicates: ${writeResult.skipped}`,
        `Event files: ${writeResult.eventFiles.length > 0 ? writeResult.eventFiles.join(", ") : "none"
        }`,
      ],
    };
  } catch (error) {
    return {
      ok: false,
      lines: ["himan-tracker backfill", "", `[fail] backfill: ${getErrorMessage(error)}`],
    };
  }
}

function resolveBackfillAgent(agent: string | undefined): AgentName {
  const resolvedAgent = agent ?? "codex";

  if (resolvedAgent === "codex" || resolvedAgent === "copilot") {
    return resolvedAgent;
  }

  throw new Error(`Unsupported backfill agent "${resolvedAgent}". Currently "codex" and "copilot" are supported.`);
}

function resolveCodexTranscriptDir(date: string): string {
  const [year, month, day] = date.split("-");
  if (!year || !month || !day) {
    throw new Error("Expected --date to use YYYY-MM-DD");
  }

  return path.join(homedir(), ".codex", "sessions", year, month, day);
}

function resolveCopilotTranscriptDir(): string {
  const codeUserDir = path.join(homedir(), "Library", "Application Support", "Code", "User");
  const workspaceStorageDir = path.join(codeUserDir, "workspaceStorage");
  const transcriptDir = path.join("GitHub.copilot-chat", "transcripts");

  // Try common workspace storage paths; the first one with transcript files wins.
  try {
    return path.join(workspaceStorageDir, transcriptDir);
  } catch {
    throw new Error(
      "Could not auto-detect Copilot transcript directory. Use --from to specify the path.",
    );
  }
}

async function parseAgentTranscripts(agent: AgentName, transcriptDir: string) {
  switch (agent) {
    case "codex":
      return parseCodexTranscriptBackfill({ transcriptDir });
    case "copilot":
      return parseCopilotTranscriptBackfill({ transcriptDir });
    case "claude-code":
      throw new Error('Agent "claude-code" is not supported by backfill yet');
  }
}

async function appendUniqueEvents(
  paths: TrackerPaths,
  events: NormalizedEvent[],
): Promise<WriteUniqueEventsResult> {
  const eventsByPath = new Map<string, NormalizedEvent[]>();
  for (const event of events) {
    const eventPath = resolveDailyEventsPath(paths, event.occurred_at);
    const fileEvents = eventsByPath.get(eventPath) ?? [];
    fileEvents.push(event);
    eventsByPath.set(eventPath, fileEvents);
  }

  let written = 0;
  let skipped = 0;
  const eventFiles: string[] = [];

  for (const [eventPath, fileEvents] of [...eventsByPath].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    await mkdir(path.dirname(eventPath), { recursive: true, mode: 0o700 });
    const existingEvents = await readExistingEvents(eventPath);

    for (const event of fileEvents) {
      if (
        existingEvents.eventIds.has(event.event_id) ||
        isSimilarExistingEvent(event, existingEvents.records)
      ) {
        skipped += 1;
        continue;
      }

      await appendJsonlRecord(eventPath, event);
      existingEvents.eventIds.add(event.event_id);
      existingEvents.records.push(event);
      written += 1;
    }

    if (fileEvents.length > 0) {
      eventFiles.push(eventPath);
    }
  }

  return {
    written,
    skipped,
    eventFiles,
  };
}

async function readExistingEvents(eventPath: string): Promise<ExistingEvents> {
  const eventIds = new Set<string>();
  const records: NormalizedEvent[] = [];

  try {
    const rawEvents = await readFile(eventPath, "utf8");
    for (const line of rawEvents.split(/\r?\n/)) {
      if (line.trim().length === 0) {
        continue;
      }

      const parsed = JSON.parse(line) as unknown;
      if (isRecord(parsed) && typeof parsed.event_id === "string") {
        eventIds.add(parsed.event_id);
        records.push(parsed as NormalizedEvent);
      }
    }
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
  }

  return {
    eventIds,
    records,
  };
}

function isSimilarExistingEvent(event: NormalizedEvent, existingEvents: NormalizedEvent[]): boolean {
  return existingEvents.some((existingEvent) => {
    if (
      existingEvent.agent !== event.agent ||
      existingEvent.event_type !== event.event_type ||
      existingEvent.session_id !== event.session_id
    ) {
      return false;
    }

    if (event.event_type === "session_summary") {
      return true;
    }

    if (event.event_type === "turn_summary") {
      return existingEvent.turn_id === event.turn_id;
    }

    if (
      existingEvent.event_type !== "capability_usage" ||
      existingEvent.turn_id !== event.turn_id ||
      existingEvent.capability_type !== event.capability_type ||
      existingEvent.capability_name !== event.capability_name
    ) {
      return false;
    }

    if (event.capability_type === "skill") {
      return true;
    }

    const existingMs = Date.parse(existingEvent.occurred_at);
    const eventMs = Date.parse(event.occurred_at);
    return (
      !Number.isNaN(existingMs) &&
      !Number.isNaN(eventMs) &&
      Math.abs(existingMs - eventMs) <= DUPLICATE_TIMESTAMP_TOLERANCE_MS
    );
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
