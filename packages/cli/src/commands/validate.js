// Copyright (c) 2026 Claudius Tiberiu Iacob — Licensed under BSL 1.1. See LICENSE for details.
/**
 * @int3gra/cli - commands/validate.js
 * Validates integra.json, all component JSON files, and structural correctness
 * for a branch already pushed into an integration's live/ repository.
 * No execution — safe to run at any time.
 *
 * Usage:
 *   integra validate --id <integration-id> --branch <name>
 *
 * --id and --branch are both mandatory — see branchTarget.js. --branch
 * does NOT require --env here. validate only inspects JSON shape
 * (integra.json, connections, maps, processes) and lints process
 * structure — it never reads process.env, and {{env.X}} placeholders are
 * resolved later, at execution time inside the executor, not during load
 * or validation. There is nothing here for an env file to inform.
 */

import { load, validateManifest } from "@int3gra/engine/loader";
import { lint }                   from "@int3gra/engine/linter";
import { readManifest }           from "@int3gra/engine";
import { parseArgs }              from "../args.js";
import { resolveBranchTarget }    from "../branchTarget.js";

export async function validate(argv) {
  const { flags } = parseArgs(argv);

  const { targetDir, banner } = await resolveBranchTarget(flags, { envRequired: false });

  console.log(`\nValidating integration at: ${targetDir}`);
  banner.forEach(line => console.log(line));
  console.log();

  // 1. integra.json
  const manifest = await readManifest(targetDir);
  await validateManifest(manifest, targetDir);
  console.log(`  ✓ integra.json`);

  // 2. Component JSON files (connections, maps, processes) + cross-references
  const registry = await load(targetDir);
  console.log(`  ✓ connections  (${Object.keys(registry.connections).length})`);
  console.log(`  ✓ maps         (${Object.keys(registry.maps).length})`);
  console.log(`  ✓ processes    (${Object.keys(registry.processes).length})`);

  // 3. Structural linting (loose else, break outside while, etc.)
  lint(registry.processes);
  console.log(`  ✓ process structure`);

  console.log(`\n✓ All checks passed.\n`);
}
