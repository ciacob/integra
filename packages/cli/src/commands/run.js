/**
 * @integra/cli - commands/run.js
 * Executes a process in the current integration directory.
 */

import { boot } from "@integra/engine";

export async function run([processId, ...flags]) {
  const cwd = process.cwd();

  if (!processId) {
    throw new Error("Usage: integra run <process-id>");
  }

  console.log(`\nRunning process "${processId}" in: ${cwd}\n`);

  const result = await boot(cwd, { processId });

  console.log(`\n✓ Process completed.`);

  if (process.env.LOG_LEVEL === "debug") {
    console.log("\nShared space at completion:");
    console.log(JSON.stringify(result.shared, null, 2));
  }
}
