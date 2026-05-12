#!/usr/bin/env node
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliArgs = process.argv.slice(2);
const forwardedArgs = cliArgs[0] === "--" ? cliArgs.slice(1) : cliArgs;

const buildCode = await runPackageManager(["run", "build"]);
if (buildCode !== 0) {
  process.exitCode = buildCode;
} else {
  process.exitCode = await run(process.execPath, [
    path.join(repoRoot, "dist", "cli", "index.js"),
    ...forwardedArgs,
  ]);
}

function runPackageManager(args) {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath) {
    return run(process.execPath, [npmExecPath, ...args]);
  }

  return run("pnpm", args);
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      env: process.env,
      stdio: "inherit",
    });

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`${command} exited with signal ${signal}`));
        return;
      }

      resolve(code ?? 0);
    });
  });
}
