#!/usr/bin/env node
/**
 * @integra/engine - index.js
 * Entry point for the engine, both as a CLI binary (spawned by PM2)
 * and as an importable module for the CLI and manager.
 */

import { resolve as resolvePath } from "path";
import { readFile }               from "fs/promises";
import { load, collectResolverPaths,
                validateManifest }        from "./loader.js";
import { loadResolvers }          from "./resolver.js";
import { lint }                   from "./linter.js";
import { createSharedSpace }      from "./shared.js";
import { createStorage }          from "./storage.js";
import { executeProcess }         from "./executor.js";
import { startListener }          from "./listener.js";
import { logger }                 from "./logger.js";
import { EngineError }            from "./error.js";

/**
 * Loads a .env file into process.env.
 * Each non-comment, non-empty line of the form KEY=VALUE is parsed.
 * Existing process.env values are overwritten.
 * Throws if the file does not exist (so mis-spelled --env paths fail loudly).
 *
 * @param {string} envPath  absolute path to the .env file
 */
export async function loadEnvFile(envPath) {
  const raw = await readFile(envPath, "utf-8");   // throws ENOENT if absent
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 0) continue;
    const key   = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
    process.env[key] = value;
  }
  logger.debug("engine.env_loaded", { path: envPath });
}

/**
 * Reads and parses integra.json from the integration directory.
 * Returns {} if the file is absent or unparseable.
 */
export async function readManifest(cwd) {
  try {
    const raw = await readFile(resolvePath(cwd, "integra.json"), "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/**
 * Boots and runs the engine from a given integration directory.
 * Behaviour depends on the lifecycle declared in integra.json:
 *
 *   (absent) / "scheduled"  — run entry process once and exit
 *   "listener"              — start Fastify server and stay alive
 */
export async function boot(cwd, options = {}) {
  logger.info("engine.booting", { cwd });

  // Load a custom .env file if specified — must happen before reading any env vars
  if (options.envFile) {
    await loadEnvFile(options.envFile);
    logger.info("engine.env_file", { path: options.envFile });
  }

  const manifest = await readManifest(cwd);

  // Validate integra.json against its schema before doing anything else
  await validateManifest(manifest, cwd);

  const lifecycle = manifest.lifecycle ?? null;

  // Load and validate all component JSON files
  const registry = await load(cwd);

  // Lint structural correctness
  lint(registry.processes);

  // Load all resolver modules
  const resolverPaths = collectResolverPaths(registry);
  const resolvers     = await loadResolvers(resolverPaths, cwd);

  // Persistent storage (tokens etc.)
  const storage = createStorage(cwd);

  if (lifecycle === "listener" && !options.processId) {
    // Long-lived: start the HTTP server and stay alive.
    // When processId is explicitly provided (e.g. in tests), skip the listener
    // and run the process directly in run-once mode instead.
    logger.info("engine.lifecycle", { lifecycle: "listener" });

    // Allow tests to override the listener port without editing integra.json
    const effectiveManifest = options.listenerPort
      ? { ...manifest, httpServer: { ...manifest.httpServer, port: options.listenerPort } }
      : manifest;

    const fastify = await startListener(effectiveManifest, {
      registry,
      resolvers,
      storage,
      executeProcess,
      createSharedSpace,
    }, cwd);

    // Process stays alive — Fastify keeps the event loop open.
    // Returns the Fastify instance so callers (e.g. tests) can close it.
    logger.info("engine.listening", { integration: manifest.id });
    return fastify;
  }

  // Run-once (absent lifecycle, "scheduled", or listener with explicit processId)
  const shared = createSharedSpace();
  const entryProcessId = options.processId ?? manifest.entry ?? null;

  if (!entryProcessId) {
    throw new EngineError("No entry process specified. Set 'entry' in integra.json or pass --process.");
  }

  const proc = registry.processes[entryProcessId];
  if (!proc) {
    throw new EngineError(`Entry process not found: ${entryProcessId}`);
  }

  logger.info("engine.running", { processId: entryProcessId, lifecycle: lifecycle ?? "run-once" });

  const result = await executeProcess(proc, registry, shared, resolvers, undefined, storage, options.inputOverride);

  logger.info("engine.done", { processId: entryProcessId });
  return result;
}

// When run directly as a binary (by PM2 or integra-engine CLI)
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
  const cwd = process.cwd();
  boot(cwd).catch(err => {
    logger.error("engine.fatal", { message: err.message, stack: err.stack });
    process.exit(1);
  });
}
