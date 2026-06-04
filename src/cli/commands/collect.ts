import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { collectCodexEnrichmentTasks } from "../../adapters/codex/enrichment.js";
import { parseCodexHookPayload } from "../../adapters/codex/index.js";
import { parseCopilotHookPayload } from "../../adapters/copilot/index.js";
import {
  getSessionStartTime,
  recordPromptSubmitted,
  recordSessionStart,
  recordTurnEndAndGetDuration,
} from "../../adapters/copilot/sessionState.js";
import {
  drainQueuedEvents,
  enqueueNormalizedEvents,
  logCollectorError,
  type DrainQueuedEventsResult,
} from "../../collector/eventQueue.js";
import { learnKnownProjectsFromAdapterEvents } from "../../config/knownProjects.js";
import { ensureTrackerDirectories, resolveTrackerPaths, type TrackerPaths } from "../../config/paths.js";
import { readOrCreateUserConfig } from "../../config/userConfig.js";
import { normalizeEvent } from "../../normalizer/normalizeEvent.js";
import type { UserConfig } from "../../types/config.js";
import type { AdapterEvent, AgentName, NormalizedEvent } from "../../types/events.js";

export type CollectCommandOptions = {
  agent?: string;
  from?: string;
  input?: string;
  sync?: boolean;
  strict?: boolean;
  drain?: boolean;
  startWorker?: boolean;
  paths?: TrackerPaths;
  config?: UserConfig;
  now?: () => Date;
};

export type CollectCommandResult = {
  ok: boolean;
  exitCode: number;
  lines: string[];
};

export async function runCollect(
  options: CollectCommandOptions = {},
): Promise<CollectCommandResult> {
  const paths = options.paths ?? resolveTrackerPaths();
  const now = options.now ?? (() => new Date());
  const strict = options.strict ?? false;

  let agent: AgentName;
  try {
    agent = resolveSupportedAgent(options.agent);
  } catch (error) {
    return createFailureResult("unknown", error, strict, false);
  }

  if (options.drain) {
    return runDrainMode(paths, agent, strict, now);
  }

  try {
    await ensureTrackerDirectories(paths);

    const source = options.from ? path.resolve(options.from) : "stdin";
    const rawPayload = options.input ?? (options.from ? await readFile(source, "utf8") : await readStdin());
    const payload = parsePayload(rawPayload, source);
    const config = options.config ?? (await readOrCreateUserConfig(paths));
    const observedAt = now().toISOString();
    const adapterEvents = await parseAgentPayload(agent, payload, observedAt, paths);
    const enrichments = collectAgentEnrichments(agent, payload, observedAt);

    try {
      await learnKnownProjectsFromAdapterEvents({
        paths,
        config,
        events: adapterEvents,
        persist: options.config === undefined,
      });
    } catch {
      // Keep collect hook-safe even when project label metadata cannot be updated.
    }

    let rejectedEvents = 0;
    let errorsLogged = 0;
    const normalizedEvents: NormalizedEvent[] = [];

    for (const event of adapterEvents) {
      try {
        normalizedEvents.push(normalizeEvent(event, config));
      } catch (error) {
        rejectedEvents += 1;
        if (
          await logCollectorError(paths, agent, {
            phase: "normalize",
            reason: getErrorMessage(error),
          }, now)
        ) {
          errorsLogged += 1;
        }
      }
    }

    const enqueueResult = await enqueueNormalizedEvents({
      paths,
      agent,
      source,
      events: normalizedEvents,
      enrichments,
      now,
    });

    let drainResult: DrainQueuedEventsResult | undefined;
    let workerStatus = "not needed";
    if (options.sync) {
      drainResult = await drainQueuedEvents({ paths, agent, now });
      workerStatus = "sync";
    } else if (enqueueResult.queued && options.startWorker !== false) {
      workerStatus = startBackgroundDrain(paths, agent) ? "started" : "not started";
    }

    const hasErrors =
      rejectedEvents > 0 ||
      errorsLogged > 0 ||
      workerStatus === "not started" ||
      Boolean(drainResult && (drainResult.failedBatches > 0 || drainResult.errorsLogged > 0));

    return {
      ok: !hasErrors,
      exitCode: hasErrors && strict ? 1 : 0,
      lines: [
        "himan-tracker collect",
        "",
        `Agent: ${agent}`,
        `Mode: ${options.sync ? "sync" : "queued"}`,
        `Source: ${source}`,
        `Parsed events: ${adapterEvents.length}`,
        `Queued events: ${enqueueResult.eventCount}`,
        `Queued enrichments: ${enqueueResult.enrichmentCount}`,
        `Queue file: ${enqueueResult.queued ? enqueueResult.queuePath : "n/a"}`,
        `Worker: ${workerStatus}`,
        `Rejected events: ${rejectedEvents}`,
        `Errors logged: ${errorsLogged}`,
        ...(drainResult ? formatDrainSummary(drainResult) : []),
      ],
    };
  } catch (error) {
    let errorLogged = false;

    try {
      await ensureTrackerDirectories(paths);
      errorLogged = await logCollectorError(paths, agent, {
        phase: "collect",
        reason: getErrorMessage(error),
      }, now);
    } catch {
      errorLogged = false;
    }

    return createFailureResult(agent, error, strict, errorLogged);
  }
}

async function runDrainMode(
  paths: TrackerPaths,
  agent: AgentName,
  strict: boolean,
  now: () => Date,
): Promise<CollectCommandResult> {
  try {
    const drainResult = await drainQueuedEvents({ paths, agent, now });
    const hasErrors = drainResult.failedBatches > 0 || drainResult.errorsLogged > 0;

    return {
      ok: !hasErrors,
      exitCode: hasErrors && strict ? 1 : 0,
      lines: [
        "himan-tracker collect",
        "",
        `Agent: ${agent}`,
        "Mode: drain",
        ...formatDrainSummary(drainResult),
      ],
    };
  } catch (error) {
    return createFailureResult(agent, error, strict, false);
  }
}

async function parseAgentPayload(
  agent: AgentName,
  payload: unknown,
  observedAt: string,
  paths: TrackerPaths,
): Promise<AdapterEvent[]> {
  switch (agent) {
    case "codex":
      return parseCodexHookPayload(payload, { observedAt });
    case "claude-code":
      throw new Error('Agent "claude-code" is not supported by collect yet');
    case "copilot":
      return parseCopilotHookPayload(payload, {
        observedAt,
        recordSessionStart: (sessionId, startedAt) =>
          recordSessionStart(paths, sessionId, startedAt),
        getSessionStartTime: (sessionId) =>
          getSessionStartTime(paths, sessionId),
        recordPromptSubmitted: (sessionId, submittedAt) =>
          recordPromptSubmitted(paths, sessionId, submittedAt),
        recordTurnEndAndGetDuration: (sessionId, endedAt) =>
          recordTurnEndAndGetDuration(paths, sessionId, endedAt),
      });
  }
}

function collectAgentEnrichments(
  agent: AgentName,
  payload: unknown,
  observedAt: string,
) {
  switch (agent) {
    case "codex":
      return collectCodexEnrichmentTasks(payload, observedAt);
    case "claude-code":
    case "copilot":
      return [];
  }
}

function parsePayload(rawPayload: string, source: string): unknown {
  const trimmedPayload = rawPayload.trim();
  if (trimmedPayload.length === 0) {
    throw new Error(`No JSON payload received from ${source}`);
  }

  try {
    return JSON.parse(trimmedPayload);
  } catch (error) {
    throw new Error(`Invalid JSON payload from ${source}: ${getErrorMessage(error)}`);
  }
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    return "";
  }

  let input = "";
  process.stdin.setEncoding("utf8");

  for await (const chunk of process.stdin) {
    input += chunk;
  }

  return input;
}

function startBackgroundDrain(paths: TrackerPaths, agent: AgentName): boolean {
  const entrypoint = process.argv[1];
  if (!entrypoint) {
    return false;
  }

  try {
    const child = spawn(
      process.execPath,
      [...process.execArgv, entrypoint, "collect", "--agent", agent, "--drain"],
      {
        detached: true,
        env: {
          ...process.env,
          HIMAN_TRACKER_HOME: paths.homeDir,
        },
        stdio: "ignore",
      },
    );
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function resolveSupportedAgent(agent: string | undefined): AgentName {
  const resolvedAgent = agent ?? "codex";

  if (resolvedAgent === "codex") {
    return resolvedAgent;
  }

  if (resolvedAgent === "copilot") {
    return resolvedAgent;
  }

  throw new Error(`Unsupported agent "${resolvedAgent}". Currently "codex" and "copilot" are supported for hook collect.`);
}

function formatDrainSummary(result: DrainQueuedEventsResult): string[] {
  return [
    `Drain lock: ${result.lockAcquired ? "acquired" : "already running"}`,
    `Processed batches: ${result.processedBatches}`,
    `Queued events drained: ${result.queuedEvents}`,
    `Written events: ${result.writtenEvents}`,
    `Failed batches: ${result.failedBatches}`,
    `Enrichment errors: ${result.enrichmentErrors}`,
    `Drain errors logged: ${result.errorsLogged}`,
  ];
}

function createFailureResult(
  agent: AgentName | "unknown",
  error: unknown,
  strict: boolean,
  errorLogged: boolean,
): CollectCommandResult {
  return {
    ok: false,
    exitCode: strict ? 1 : 0,
    lines: [
      "himan-tracker collect",
      "",
      `Agent: ${agent}`,
      `[warn] ${getErrorMessage(error)}`,
      `Errors logged: ${errorLogged ? 1 : 0}`,
      "Exit behavior: non-blocking; use --strict for manual validation failures.",
    ],
  };
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
