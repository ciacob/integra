// Copyright (c) 2026 Claudius Tiberiu Iacob — Licensed under BSL 1.1. See LICENSE for details.
/**
 * @int3gra/cli - commands/run.js
 * Executes a process in the current integration directory.
 *
 * Usage:
 *   integra run <process-id>
 *   integra run <process-id> --env .env.dev
 *   integra run <process-id> --branch patch-x --env .env.dev
 *
 * --branch requires --env (see branchTarget.js for why), and must be run
 * from the server where this integration is registered (see branchTarget.js).
 *
 * If the targeted integration's lifecycle is "listener", a --branch run
 * starts a real, resident Fastify server that PM2 does not manage and will
 * not clean up. It must be stopped by hand.
 */

import { boot }                  from "@int3gra/engine";
import { parseArgs }             from "../args.js";
import { resolveBranchTarget }   from "../branchTarget.js";
import { resolve }               from "path";
import { existsSync }            from "fs";

export async function run(argv) {
  const { flags, positional } = parseArgs(argv);
  const processId = positional[0];
  const cwd       = process.cwd();

  if (!processId) {
    throw new Error("Usage: integra run <process-id> [--env <file>] [--branch <name>]");
  }

  const { targetDir, banner, envFile: branchEnvFile } = await resolveBranchTarget(flags, cwd);

  // Resolve env file — default .env, override with --env. When --branch was
  // given, resolveBranchTarget already validated and resolved it.
  let envFile;
  if (flags.branch) {
    envFile = branchEnvFile;
  } else {
    const envFileName = flags.env ?? ".env";
    envFile = resolve(cwd, envFileName);
    if (!existsSync(envFile)) {
      throw new Error(`Env file not found: ${envFile}`);
    }
  }

  console.log(`\nRunning process "${processId}" in: ${targetDir}`);
  banner.forEach(line => console.log(line));
  if (!flags.branch && flags.env) console.log(`Using env: ${flags.env}`);
  console.log();

  // Check the target's own lifecycle for the listener resident-process warning
  if (flags.branch) {
    const { readManifest } = await import("@int3gra/engine");
    const manifest = await readManifest(targetDir);
    if (manifest.lifecycle === "listener") {
      console.log(
        `⚠  This is a LISTENER integration. This run will start a real, resident\n` +
        `   Fastify server that PM2 does not manage. It will keep running until\n` +
        `   you stop it yourself — it will not be cleaned up automatically.\n`
      );
    }
  }

  const result = await boot(targetDir, { processId, envFile });

  console.log(`\n✓ Process completed.`);

  if (process.env.LOG_LEVEL === "debug") {
    console.log("\nShared space at completion:");
    console.log(JSON.stringify(result.shared, null, 2));
  }
}
