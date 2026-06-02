#!/usr/bin/env node
/**
 * @integra/engine - index.js
 * Entry point for the engine, both as a CLI binary (spawned by PM2)
 * and as an importable module for the CLI and manager.
 */

import { resolve as resolvePath } from "path";
import { readFile }               from "fs/promises";
import { load, collectResolverPaths } from "./loader.js";
import { loadResolvers }          from "./resolver.js";
import { lint }                   from "./linter.js";
import { createSharedSpace }      from "./shared.js";
import { createStorage }          from "./storage.js";
import { executeProcess }         from "./executor.js";
import { logger }                 from "./logger.js";
import { EngineError }            from "./error.js";

/**
 * Boots and runs the engine from a given integration directory.
 * Used both by the CLI (integra run) and when spawned directly by PM2.
 */
export async function boot(cwd, options = {}) {
  logger.info("engine.booting", { cwd });

  // Load and validate all component JSON files
  const registry = await load(cwd);

  // Lint structural correctness
  lint(registry.processes);

  // Load all resolver modules
  const resolverPaths = collectResolverPaths(registry);
  const resolvers     = await loadResolvers(resolverPaths, cwd);

  // Initialize shared space and persistent storage
  const shared  = createSharedSpace();
  const storage = createStorage(cwd);

  // Determine entry process
  const entryProcessId = options.processId ?? await resolveEntryProcess(cwd, registry);

  if (!entryProcessId) {
    throw new EngineError("No entry process specified. Set 'entry' in integra.json or pass --process.");
  }

  const process = registry.processes[entryProcessId];
  if (!process) {
    throw new EngineError(`Entry process not found: ${entryProcessId}`);
  }

  logger.info("engine.running", { processId: entryProcessId });

  const result = await executeProcess(process, registry, shared, resolvers, undefined, storage);

  logger.info("engine.done", { processId: entryProcessId });
  return result;
}

async function resolveEntryProcess(cwd, registry) {
  try {
    const manifestPath = resolvePath(cwd, "integra.json");
    const raw          = await readFile(manifestPath, "utf-8");
    const manifest     = JSON.parse(raw);
    return manifest.entry ?? null;
  } catch {
    // No manifest or no entry key — caller must provide processId
    return null;
  }
}

// When run directly as a binary (by PM2 or integra-engine CLI)
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
  const cwd = process.cwd();
  boot(cwd).catch(err => {
    logger.error("engine.fatal", { message: err.message, stack: err.stack });
    process.exit(1);
  });
}
