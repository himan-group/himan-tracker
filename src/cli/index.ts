#!/usr/bin/env node
import { Command, Option } from "commander";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { runAgents } from "./commands/agents.js";
import { runArchiveMonthly } from "./commands/archive.js";
import { runBackfill } from "./commands/backfill.js";
import { runCleanup } from "./commands/cleanup.js";
import { runCapabilityEvents } from "./commands/capabilityEvents.js";
import { runCapabilities } from "./commands/capabilities.js";
import { runCollect } from "./commands/collect.js";
import { runDoctor } from "./commands/doctor.js";
import { runIngest } from "./commands/ingest.js";
import {
  runServerServe,
  runServerStart,
  runServerStatus,
  runServerStop,
} from "./commands/server.js";
import { runSetup } from "./commands/setup.js";
import { runSummary } from "./commands/summary.js";
import { runTokens } from "./commands/tokens.js";
import { runTurns } from "./commands/turns.js";
import { runUnused } from "./commands/unused.js";

const VERSION = getCliVersion();

function getCliVersion(): string {
  try {
    const packagePath = fileURLToPath(new URL("../../package.json", import.meta.url));
    const rawPackage = readFileSync(packagePath, "utf8");
    const parsedPackage = JSON.parse(rawPackage);

    return typeof parsedPackage.version === "string" && parsedPackage.version.length > 0
      ? parsedPackage.version
      : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const program = new Command();

program
  .name("himan-tracker")
  .description("Local-first observability and analytics for AI coding agents.")
  .version(VERSION, "-v, --version", "Show the CLI version")
  .helpOption("-h, --help", "Show this help message");

program
  .command("collect")
  .description("Collect raw agent hook payloads without blocking the agent workflow")
  .option("--agent <agent>", "Agent adapter to use; currently codex and copilot are supported", "codex")
  .option("--from <path>", "Read the agent payload from a JSON file")
  .option("--quiet", "Suppress collect output for hook usage")
  .option("--sync", "Drain the local collect queue in the foreground after enqueueing")
  .option("--strict", "Return a non-zero exit code when collection reports a failure")
  .addOption(new Option("--drain", "Drain queued collect payloads").hideHelp())
  .action(async (options: CollectCommandOptions) => {
    const result = await runCollect(options);
    if (!options.quiet) {
      console.log(result.lines.join("\n"));
    }
    process.exitCode = result.exitCode;
  });

type CollectCommandOptions = {
  agent?: string;
  from?: string;
  quiet?: boolean;
  sync?: boolean;
  strict?: boolean;
  drain?: boolean;
};

program
  .command("setup")
  .description("Configure agent integrations")
  .option("--agent <agent>", "Agent integration to configure; currently codex and copilot are supported", "codex")
  .option("-g, --global", "Install hooks into ~/.codex instead of the current project")
  .option("--dry-run", "Preview files without writing them")
  .action(async (options: SetupCommandOptions) => {
    const result = await runSetup(options);
    console.log(result.lines.join("\n"));
    process.exitCode = result.exitCode;
  });

type SetupCommandOptions = {
  agent?: string;
  global?: boolean;
  dryRun?: boolean;
};

program
  .command("doctor")
  .description("Check local configuration and storage readiness")
  .action(async () => {
    const result = await runDoctor();
    console.log(result.lines.join("\n"));
    process.exitCode = result.ok ? 0 : 1;
  });

program
  .command("ingest")
  .description("Import normalized JSONL events into the local SQLite projection")
  .option("--from <path>", "Read events from a specific JSONL file")
  .option("--rebuild", "Delete and rebuild the SQLite projection before ingesting")
  .action(async (options: IngestCommandOptions) => {
    const result = await runIngest(options);
    console.log(result.lines.join("\n"));
    process.exitCode = result.ok ? 0 : 1;
  });

type IngestCommandOptions = {
  from?: string;
  rebuild?: boolean;
};

const backfillCommand = program
  .command("backfill")
  .description("Backfill tracker events from local agent transcripts");

backfillCommand
  .command("codex")
  .description("Backfill Codex events from local Codex transcript JSONL files")
  .option("--date <date>", "Transcript date to backfill in YYYY-MM-DD; defaults to today")
  .option("--since <date>", "Backfill from this date through today in YYYY-MM-DD")
  .option("--from <dir>", "Read transcript JSONL files from a specific directory")
  .action(async (options: BackfillCommandOptions) => {
    const result = await runBackfill({ ...options, agent: "codex" });
    console.log(result.lines.join("\n"));
    process.exitCode = result.ok ? 0 : 1;
  });

backfillCommand
  .command("copilot")
  .description("Backfill Copilot events from local Copilot transcript JSONL files")
  .option("--date <date>", "Transcript date to backfill in YYYY-MM-DD; defaults to today")
  .option("--since <date>", "Backfill from this date through today in YYYY-MM-DD")
  .option("--from <dir>", "Read transcript JSONL files from a specific directory")
  .action(async (options: BackfillCommandOptions) => {
    const result = await runBackfill({ ...options, agent: "copilot" });
    console.log(result.lines.join("\n"));
    process.exitCode = result.ok ? 0 : 1;
  });

type BackfillCommandOptions = {
  date?: string;
  since?: string;
  from?: string;
};

const archiveCommand = program
  .command("archive")
  .description("Archive old local statistics into compact summary tables");

archiveCommand
  .command("monthly")
  .description("Archive complete months older than the recent six-month retention window")
  .option("--dry-run", "Preview archive work without writing or deleting data")
  .action(async (options: ArchiveMonthlyCommandOptions) => {
    const result = await runArchiveMonthly(options);
    console.log(result.lines.join("\n"));
    process.exitCode = result.ok ? 0 : 1;
  });

type ArchiveMonthlyCommandOptions = {
  dryRun?: boolean;
};

const serverCommand = program
  .command("server")
  .description("Start and stop the local report web server");

serverCommand
  .command("start")
  .description("Start the local report web server in the background")
  .option("--host <host>", "Host to bind", "127.0.0.1")
  .option("--port <port>", "Port to bind; use 0 for a random free port", "5127")
  .option("--interval <seconds>", "Seconds between background ingest runs", "300")
  .option("--since <period>", "Report date range such as 7d, 4w, or 1m", "7d")
  .addOption(
    new Option("--display <mode>", "Dashboard report display mode")
      .choices(["table", "text"])
      .default("table"),
  )
  .option("--open", "Open the dashboard in the default browser after start")
  .action(async (options: ServerStartCommandOptions) => {
    const result = await runServerStart(options);
    console.log(result.lines.join("\n"));
    process.exitCode = result.ok ? 0 : 1;
  });

serverCommand
  .command("stop")
  .description("Stop the local report web server")
  .action(async () => {
    const result = await runServerStop();
    console.log(result.lines.join("\n"));
    process.exitCode = result.ok ? 0 : 1;
  });

serverCommand
  .command("status")
  .description("Show local report web server status")
  .action(async () => {
    const result = await runServerStatus();
    console.log(result.lines.join("\n"));
    process.exitCode = result.ok ? 0 : 1;
  });

serverCommand
  .command("serve", { hidden: true })
  .description("Run the local report web server in the foreground")
  .option("--host <host>", "Host to bind", "127.0.0.1")
  .option("--port <port>", "Port to bind", "5127")
  .option("--interval <seconds>", "Seconds between background ingest runs", "300")
  .option("--since <period>", "Report date range such as 7d, 4w, or 1m", "7d")
  .addOption(
    new Option("--display <mode>", "Dashboard report display mode")
      .choices(["table", "text"])
      .default("table"),
  )
  .action(async (options: ServerServeCommandOptions) => {
    const result = await runServerServe(options);
    if (!result.ok) {
      console.error(result.lines.join("\n"));
    }
    process.exit(result.ok ? 0 : 1);
  });

type ServerStartCommandOptions = {
  host?: string;
  port?: string;
  interval?: string;
  since?: string;
  display?: string;
  open?: boolean;
};

type ServerServeCommandOptions = ServerStartCommandOptions;

program
  .command("cleanup")
  .description("Delete raw JSONL logs while keeping SQLite statistics")
  .option("--all", "Delete all raw event and error JSONL logs")
  .option("--before <date>", "Delete raw logs before YYYY-MM-DD")
  .option("--from <date>", "Delete raw logs on or after YYYY-MM-DD")
  .option("--to <date>", "Delete raw logs on or before YYYY-MM-DD")
  .option("--older-than <period>", "Delete raw logs older than a period such as 30d, 12w, or 6m")
  .option("--dry-run", "Preview files without deleting them")
  .action(async (options: CleanupCommandOptions) => {
    const result = await runCleanup(options);
    console.log(result.lines.join("\n"));
    process.exitCode = result.ok ? 0 : 1;
  });

type CleanupCommandOptions = {
  all?: boolean;
  before?: string;
  from?: string;
  to?: string;
  olderThan?: string;
  dryRun?: boolean;
};

program
  .command("summary")
  .description("Show usage summary for a date range")
  .option("--since <period>", "Date range such as 7d, 4w, or 1m", "7d")
  .option("--limit <count>", "Maximum top capabilities to show, between 1 and 200", "10")
  .option("--exclude-system", "Exclude built-in system capabilities from Top capabilities")
  .action(async (options: SummaryCommandOptions) => {
    const result = await runSummary(options);
    console.log(result.lines.join("\n"));
    process.exitCode = result.ok ? 0 : 1;
  });

type SummaryCommandOptions = {
  since?: string;
  limit?: string;
  excludeSystem?: boolean;
};

program
  .command("tokens")
  .description("Show runtime token usage grouped by day, week, or month")
  .option("--since <period>", "Date range such as 30d, 12w, or 12m", "30d")
  .option("--period <period>", "Group by day, week, month, daily, weekly, or monthly", "day")
  .action(async (options: TokensCommandOptions) => {
    const result = await runTokens(options);
    console.log(result.lines.join("\n"));
    process.exitCode = result.ok ? 0 : 1;
  });

type TokensCommandOptions = {
  since?: string;
  period?: string;
};

program
  .command("agents")
  .description("Show agent and model usage for a date")
  .option("--date <date>", "Report date in YYYY-MM-DD")
  .action(async (options: AgentsCommandOptions) => {
    const result = await runAgents(options);
    console.log(result.lines.join("\n"));
    process.exitCode = result.ok ? 0 : 1;
  });

type AgentsCommandOptions = {
  date?: string;
};

program
  .command("turns")
  .description("Show per-turn usage and latency for a date range")
  .option("--since <period>", "Date range such as 7d, 4w, or 1m", "7d")
  .option("--agent <agent>", "Filter by agent")
  .option("--limit <count>", "Maximum turns to show, between 1 and 200", "20")
  .action(async (options: TurnsCommandOptions) => {
    const result = await runTurns(options);
    console.log(result.lines.join("\n"));
    process.exitCode = result.ok ? 0 : 1;
  });

type TurnsCommandOptions = {
  since?: string;
  agent?: string;
  limit?: string;
};

program
  .command("capabilities")
  .description("Show capability usage for a date range")
  .option("--since <period>", "Date range such as 7d, 4w, or 1m", "30d")
  .option("--sort <field>", "Sort by invocations, tokens, duration, or failures", "tokens")
  .option("--type <type>", "Filter by capability type")
  .option("--agent <agent>", "Filter by agent")
  .option("--exclude-system", "Exclude built-in system capabilities")
  .action(async (options: CapabilitiesCommandOptions) => {
    const result = await runCapabilities(options);
    console.log(result.lines.join("\n"));
    process.exitCode = result.ok ? 0 : 1;
  });

type CapabilitiesCommandOptions = {
  since?: string;
  sort?: string;
  type?: string;
  agent?: string;
  excludeSystem?: boolean;
};

program
  .command("capability-events")
  .description("Show individual capability usage records for a date range")
  .option("--since <period>", "Date range such as 7d, 4w, or 1m", "30d")
  .requiredOption("--type <type>", "Capability type to inspect")
  .requiredOption("--name <name>", "Capability name to inspect")
  .option("--agent <agent>", "Filter by agent")
  .option("--limit <count>", "Maximum events to show, between 1 and 200", "50")
  .action(async (options: CapabilityEventsCommandOptions) => {
    const result = await runCapabilityEvents(options);
    console.log(result.lines.join("\n"));
    process.exitCode = result.ok ? 0 : 1;
  });

type CapabilityEventsCommandOptions = {
  since?: string;
  type?: string;
  name?: string;
  agent?: string;
  limit?: string;
};

program
  .command("unused")
  .description("Show capability candidates unused in a date range")
  .option("--since <period>", "Date range such as 7d, 4w, or 1m", "30d")
  .action(async (options: UnusedCommandOptions) => {
    const result = await runUnused(options);
    console.log(result.lines.join("\n"));
    process.exitCode = result.ok ? 0 : 1;
  });

type UnusedCommandOptions = {
  since?: string;
};

program
  .parseAsync(normalizeArgv(process.argv))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });

function normalizeArgv(argv: string[]): string[] {
  if (argv[2] === "--") {
    return [argv[0], argv[1], ...argv.slice(3)];
  }

  return argv;
}
