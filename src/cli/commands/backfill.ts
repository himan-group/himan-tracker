import {
  runBackfill as runBackfillCore,
  type BackfillCommandOptions,
  type BackfillCommandResult,
} from "../../backfill/runBackfill.js";

export type { BackfillCommandOptions, BackfillCommandResult };

export async function runBackfill(
  options: BackfillCommandOptions = {},
): Promise<BackfillCommandResult> {
  return runBackfillCore(options);
}
