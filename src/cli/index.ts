#!/usr/bin/env node
import { Command } from "commander";

import { runDoctor } from "./commands/doctor.js";
import { runIngest } from "./commands/ingest.js";

const VERSION = "0.0.0";

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

for (const commandName of ["summary", "agents", "capabilities", "unused"]) {
  program
    .command(commandName)
    .description(`${commandName} is planned for the MVP but is not implemented yet`)
    .allowUnknownOption()
    .allowExcessArguments()
    .action(() => {
      console.error(`Command '${commandName}' is planned for the MVP but is not implemented yet.`);
      process.exitCode = 1;
    });
}

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
