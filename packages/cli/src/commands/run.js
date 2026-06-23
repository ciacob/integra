// Copyright (c) 2026 Claudius Tiberiu Iacob — Licensed under BSL 1.1. See LICENSE for details.
/**
 * @int3gra/cli - commands/run.js
 * Executes a process from a branch already pushed into an integration's
 * live/ repository.
 *
 * Usage:
 *   integra run <process-id> --id <integration-id> --branch <name>
 *   integra run <process-id> --id <integration-id> --branch <name> --env .env.dev
 *
 * --id and --branch are both mandatory — see branchTarget.js. There is no
 * mode that runs live/ directly, or an arbitrary local checkout.
 *
 * If the targeted integration's lifecycle is "listener", this starts a
 * real, resident Fastify server that PM2 does not manage and will not
 * clean up. It must be stopped by hand.
 */

import { boot }                  from "@int3gra/engine";
import { parseArgs }             from "../args.js";
import { resolveBranchTarget }   from "../branchTarget.js";

export async function run(argv) {
  const { flags, positional } = parseArgs(argv);
  const processId = positional[0];

  if (!processId) {
    throw new Error("Usage: integra run <process-id> --id <integration-id> --branch <name> [--env <file>]");
  }

  const { targetDir, banner, envFile } = await resolveBranchTarget(flags);

  console.log(`\nRunning process "${processId}" in: ${targetDir}`);
  banner.forEach(line => console.log(line));
  console.log();

  // Check the target's own lifecycle for the listener resident-process warning
  const { readManifest } = await import("@int3gra/engine");
  const manifest = await readManifest(targetDir);
  if (manifest.lifecycle === "listener") {
    console.log(
      `⚠  This is a LISTENER integration. This run will start a real, resident\n` +
      `   Fastify server that PM2 does not manage. It will keep running until\n` +
      `   you stop it yourself — it will not be cleaned up automatically.\n`
    );
  }

  const result = await boot(targetDir, { processId, envFile });

  console.log(`\n✓ Process completed.`);

  if (process.env.LOG_LEVEL === "debug") {
    console.log("\nShared space at completion:");
    console.log(JSON.stringify(result.shared, null, 2));
  }
}
