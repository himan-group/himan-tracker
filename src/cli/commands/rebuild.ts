import { runBackfill, type BackfillCommandOptions, type BackfillCommandResult } from "./backfill.js";
import { runCleanup, type CleanupCommandOptions, type CleanupCommandResult } from "./cleanup.js";
import { runIngest, type IngestCommandOptions, type IngestCommandResult } from "./ingest.js";
import { resolveTrackerPaths, type TrackerPaths } from "../../config/paths.js";
import { parseDate } from "../../reports/dateRange.js";

type RebuildSupportedAgent = "codex" | "copilot";

export type RebuildCommandOptions = {
  agent?: string;
  date?: string;
  from?: string;
  paths?: TrackerPaths;
  now?: () => Date;
  progress?: (line: string) => void;
  runners?: {
    cleanup?: (options: CleanupCommandOptions) => Promise<CleanupCommandResult>;
    backfill?: (options: BackfillCommandOptions) => Promise<BackfillCommandResult>;
    ingest?: (options: IngestCommandOptions) => Promise<IngestCommandResult>;
  };
};

export type RebuildCommandResult = {
  ok: boolean;
  lines: string[];
};

export async function runRebuild(
  options: RebuildCommandOptions = {},
): Promise<RebuildCommandResult> {
  const progress = options.progress ?? (() => {});
  const paths = options.paths ?? resolveTrackerPaths();

  try {
    const agent = resolveRebuildAgent(options.agent);
    const date = parseDate(options.date ?? "");
    const cleanupRunner = options.runners?.cleanup ?? runCleanup;
    const backfillRunner = options.runners?.backfill ?? runBackfill;
    const ingestRunner = options.runners?.ingest ?? runIngest;

    progress(`[1/3] Cleanup raw events for ${agent} on ${date}`);
    const cleanupResult = await cleanupRunner({
      agent,
      from: date,
      to: date,
      paths,
      now: options.now,
    });
    if (!cleanupResult.ok) {
      return formatFailedResult("cleanup", cleanupResult.lines);
    }
    progress(`[1/3] Cleanup finished`);

    progress(`[2/3] Backfill raw events for ${agent} on ${date}`);
    const backfillResult = await backfillRunner({
      agent,
      date,
      from: options.from,
      force: true,
      ignoreCursor: true,
      paths,
      now: options.now,
    });
    if (!backfillResult.ok) {
      return formatFailedResult("backfill", backfillResult.lines);
    }
    progress(`[2/3] Backfill finished`);

    progress(`[3/3] Rebuild SQLite projection for ${agent} on ${date}`);
    const ingestResult = await ingestRunner({
      date,
      agent,
      paths,
    });
    if (!ingestResult.ok) {
      return formatFailedResult("ingest", ingestResult.lines);
    }
    progress(`[3/3] Ingest finished`);

    return {
      ok: true,
      lines: [
        "himan-tracker rebuild",
        "",
        `Agent: ${agent}`,
        `Date: ${date}`,
        "Steps:",
        "1. cleanup: ok",
        "2. backfill: ok",
        "3. ingest: ok",
        "",
        ...indentSection("cleanup", cleanupResult.lines),
        ...indentSection("backfill", backfillResult.lines),
        ...indentSection("ingest", ingestResult.lines),
      ],
    };
  } catch (error) {
    return {
      ok: false,
      lines: ["himan-tracker rebuild", "", `[fail] rebuild: ${getErrorMessage(error)}`],
    };
  }
}

function resolveRebuildAgent(agent: string | undefined): RebuildSupportedAgent {
  if (agent === "codex" || agent === "copilot") {
    return agent;
  }

  if (!agent) {
    throw new Error('Expected rebuild agent "codex" or "copilot"');
  }

  throw new Error(
    `Unsupported rebuild agent "${agent}". Currently "codex" and "copilot" are supported.`,
  );
}

function formatFailedResult(step: "cleanup" | "backfill" | "ingest", lines: string[]): RebuildCommandResult {
  return {
    ok: false,
    lines: [
      "himan-tracker rebuild",
      "",
      `[fail] rebuild stopped at ${step}`,
      "",
      ...indentSection(step, lines),
    ],
  };
}

function indentSection(title: string, lines: string[]): string[] {
  return [`${title}:`, ...lines.map((line) => (line.length === 0 ? "  " : `  ${line}`))];
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
