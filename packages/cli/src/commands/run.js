// Copyright (c) 2026 Claudius Tiberiu Iacob — Licensed under BSL 1.1. See LICENSE for details.
/**
 * @int3gra/cli - commands/run.js
 * Executes a process in the current integration directory.
 *
 * Usage:
 *   integra run <process-id>
 *   integra run <process-id> --env .env.dev
 */

import { boot }       from "@int3gra/engine";
import { parseArgs }  from "../args.js";
import { resolve }    from "path";
import { existsSync } from "fs";

export async function run(argv) {
  const { flags, positional } = parseArgs(argv);
  const processId = positional[0];
  const cwd       = process.cwd();

  if (!processId) {
    throw new Error("Usage: integra run <process-id> [--env <file>]");
  }

  // Resolve env file — default .env, override with --env
  const envFileName = flags.env ?? ".env";
  const envFile     = resolve(cwd, envFileName);

  if (!existsSync(envFile)) {
    throw new Error(`Env file not found: ${envFile}`);
  }

  console.log(`\nRunning process "${processId}" in: ${cwd}`);
  if (flags.env) console.log(`Using env: ${envFileName}`);
  console.log();

  const result = await boot(cwd, { processId, envFile });

  console.log(`\n✓ Process completed.`);

  if (process.env.LOG_LEVEL === "debug") {
    console.log("\nShared space at completion:");
    console.log(JSON.stringify(result.shared, null, 2));
  }
}
