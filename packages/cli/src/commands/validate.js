/**
 * @integra/cli - commands/validate.js
 * Runs schema validation and the structural linter without executing anything.
 */

import { load }   from "@integra/engine/loader";
import { lint }   from "@integra/engine/linter";
import { logger } from "@integra/engine/logger";

export async function validate([]) {
  const cwd = process.cwd();
  console.log(`\nValidating integration at: ${cwd}\n`);

  const registry = await load(cwd);
  lint(registry.processes);

  console.log(`\n✓ Validation passed.\n`);
  console.log(`  Connections : ${Object.keys(registry.connections).length}`);
  console.log(`  Maps        : ${Object.keys(registry.maps).length}`);
  console.log(`  Processes   : ${Object.keys(registry.processes).length}\n`);
}
