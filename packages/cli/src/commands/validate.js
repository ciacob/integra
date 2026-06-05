/**
 * @int3gra/cli - commands/validate.js
 * Validates integra.json, all component JSON files, and structural correctness.
 * No execution — safe to run at any time.
 */

import { load, validateManifest } from "@int3gra/engine/loader";
import { lint }                   from "@int3gra/engine/linter";
import { readManifest }           from "@int3gra/engine";

export async function validate([]) {
  const cwd = process.cwd();
  console.log(`\nValidating integration at: ${cwd}\n`);

  // 1. integra.json
  const manifest = await readManifest(cwd);
  await validateManifest(manifest, cwd);
  console.log(`  ✓ integra.json`);

  // 2. Component JSON files (connections, maps, processes) + cross-references
  const registry = await load(cwd);
  console.log(`  ✓ connections  (${Object.keys(registry.connections).length})`);
  console.log(`  ✓ maps         (${Object.keys(registry.maps).length})`);
  console.log(`  ✓ processes    (${Object.keys(registry.processes).length})`);

  // 3. Structural linting (loose else, break outside while, etc.)
  lint(registry.processes);
  console.log(`  ✓ process structure`);

  console.log(`\n✓ All checks passed.\n`);
}
