// Copyright (c) 2026 Claudius Tiberiu Iacob — Licensed under BSL 1.1. See LICENSE for details.
/**
 * @int3gra/cli - commands/init.js
 *
 * Scaffolds a new integration directory AND registers it in registry.d/
 * in one step. Every integration's life begins here — there is no separate
 * "create" registry command, and `integra-manager checkout` will refuse to
 * operate on ids that don't yet exist. The registration is silent and
 * automatic: the developer just gets a working directory and a live entry.
 *
 * If no registry.d/ exists in the current directory, the registration step
 * is skipped with a soft warning — `init` is also used in standalone
 * development environments where a manager isn't running.
 */

import { cpSync, mkdirSync, writeFileSync, existsSync } from "fs";
import { resolve, dirname }                              from "path";
import { fileURLToPath }                                 from "url";
import { mkdir, writeFile }                              from "fs/promises";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE  = resolve(__dirname, "../../templates/integration");

export async function init([name]) {
  if (!name) {
    throw new Error("Usage: integra init <name>");
  }

  const cwd    = process.cwd();
  const target = resolve(cwd, name);

  if (existsSync(target)) {
    throw new Error(`Directory already exists: ${target}`);
  }

  // ── Scaffold the integration directory ──────────────────────────────────

  cpSync(TEMPLATE, target, { recursive: true });

  const manifest = {
    id:      name,
    entry:   null,
    engine:  "1.0.0",
    created: new Date().toISOString(),
  };

  writeFileSync(
    resolve(target, "integra.json"),
    JSON.stringify(manifest, null, 2) + "\n"
  );

  writeFileSync(
    resolve(target, ".env.example"),
    [
      "# Environment variables for this integration",
      "# Copy to .env and fill in your values",
      "",
      "# LOG_LEVEL=debug",
      "",
    ].join("\n")
  );

  // ── Register in registry.d/ ────────────────────────────────────────────────
  // Always ensure registry.d/ exists — init is how integrations begin, and
  // the manager needs this directory. Creating it here costs nothing and
  // saves the developer a separate setup step.

  const registryDir = resolve(cwd, "registry.d");
  const entryPath   = resolve(registryDir, `${name}.registry.json`);
  let   registered  = false;

  await mkdir(registryDir, { recursive: true });

  if (existsSync(entryPath)) {
    console.warn(
      `  ⚠  registry.d/${name}.registry.json already exists — skipping registration.\n` +
      `     If you meant to replace it, use 'integra-manager checkout ${name}' instead.`
    );
  } else {
    const entry = {
      id:      name,
      path:    `./${name}`,
      enabled: true,
    };
    await writeFile(entryPath, JSON.stringify(entry, null, 2) + "\n");
    registered = true;
  }

  // ── Report ───────────────────────────────────────────────────────────────

  console.log(`\n✓ Integration environment created: ${target}`);
  if (registered)  console.log(`✓ Registered in registry.d/${name}.registry.json`);

  console.log(`\nNext steps:`);
  console.log(`  cd ${name}`);
  console.log(`  cp .env.example .env`);
  console.log(`  # Author your connections/, maps/, processes/, resolvers/`);
  console.log(`  integra validate`);
  console.log(`  integra run <your-process-id>`);
  console.log(`  # Add fixture files to test/fixtures/ then:`);
  console.log(`  integra test\n`);
}
