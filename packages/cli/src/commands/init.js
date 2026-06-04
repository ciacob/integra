/**
 * @integra/cli - commands/init.js
 * Scaffolds a new integration environment directory.
 */

import { cpSync, mkdirSync, writeFileSync, existsSync } from "fs";
import { resolve, dirname }                              from "path";
import { fileURLToPath }                                 from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE  = resolve(__dirname, "../../templates/integration");

export async function init([name]) {
  if (!name) {
    throw new Error("Usage: integra init <name>");
  }

  const target = resolve(process.cwd(), name);

  if (existsSync(target)) {
    throw new Error(`Directory already exists: ${target}`);
  }

  // Copy template
  cpSync(TEMPLATE, target, { recursive: true });

  // Write integra.json manifest
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

  // Write .env.example
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

  console.log(`\n✓ Integration environment created: ${target}`);
  console.log(`\nNext steps:`);
  console.log(`  cd ${name}`);
  console.log(`  cp .env.example .env`);
  console.log(`  # Author your connections/, maps/, processes/, resolvers/`);
  console.log(`  integra validate`);
  console.log(`  integra run <your-process-id>`);
  console.log(`  # Add fixture files to test/fixtures/ then:`);
  console.log(`  integra test\n`);
}
