#!/usr/bin/env node
import { Command } from "commander";

import { runAgents } from "./commands/agents.js";
import { runCapabilities } from "./commands/capabilities.js";
import { runDoctor } from "./commands/doctor.js";
import { runIngest } from "./commands/ingest.js";
import { runSummary } from "./commands/summary.js";
import { runUnused } from "./commands/unused.js";

const VERSION = "0.0.1";

const program = new Command();

program
  .name("himan-tracker")
  .description("Local-first observability and analytics for AI coding agents.")
  .version(VERSION, "-v, --version", "Show the CLI version")
  .helpOption("-h, --help", "Show this help message");

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

program
  .command("summary")
  .description("Show usage summary for a date range")
  .option("--since <period>", "Date range such as 7d, 4w, or 1m", "7d")
  .action(async (options: SummaryCommandOptions) => {
    const result = await runSummary(options);
    console.log(result.lines.join("\n"));
    process.exitCode = result.ok ? 0 : 1;
  });

type SummaryCommandOptions = {
  since?: string;
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
  .command("capabilities")
  .description("Show capability usage for a date range")
  .option("--since <period>", "Date range such as 7d, 4w, or 1m", "30d")
  .option("--sort <field>", "Sort by invocations, tokens, duration, or failures", "tokens")
  .option("--type <type>", "Filter by capability type")
  .option("--agent <agent>", "Filter by agent")
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
