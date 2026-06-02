#!/usr/bin/env node
/**
 * @integra/manager - trafficController.js
 *
 * A short-lived process spawned by PM2 on a cron schedule.
 * Its sole job: decide whether the integration it watches is safe to run,
 * then either start it or stand down — and always log the decision.
 *
 * One TrafficController instance exists per scheduled integration.
 * PM2 restarts the TrafficController on the cron schedule.
 * The integration itself is started by the TrafficController, never by PM2 directly.
 *
 * Decision logic:
 *   integration not registered in PM2 → start it
 *   integration stopped / errored     → start it
 *   integration online                →
 *     max_ttl defined AND exceeded    → kill it, start a fresh run
 *     max_ttl not defined or not hit  → stand down (respect the running instance)
 *
 * Usage (via PM2 descriptor, not called directly):
 *   node trafficController.js --integration <id> --registry <path>
 *
 * Arguments:
 *   --integration  <id>    The integration id as it appears in registry.json
 *   --registry     <path>  Absolute path to the directory containing registry.json
 *                          Defaults to process.cwd()
 */

import pm2            from "pm2";
import { resolve }    from "path";
import { logger }     from "./logger.js";
import { loadRegistry } from "./registry.js";
import { buildIntegrationDescriptor } from "./descriptor.js";

// ── Argument parsing ──────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      args[argv[i].slice(2)] = argv[i + 1] ?? true;
      i++;
    }
  }
  return args;
}

// Args are parsed lazily in boot() so the module can be safely imported for testing
let integrationId = null;
let registryDir   = null;

// ── PM2 helpers ───────────────────────────────────────────────────────────────

function pm2Connect() {
  return new Promise((res, rej) =>
    pm2.connect(err => err ? rej(err) : res())
  );
}

function pm2Disconnect() {
  try { pm2.disconnect(); } catch { /* already disconnected */ }
}

function pm2List() {
  return new Promise((res, rej) =>
    pm2.list((err, list) => err ? rej(err) : res(list))
  );
}

function pm2Start(descriptor) {
  return new Promise((res, rej) =>
    pm2.start(descriptor, err => err ? rej(err) : res())
  );
}

function pm2Delete(id) {
  return new Promise((res, rej) =>
    pm2.delete(id, err => err ? rej(err) : res())
  );
}

function pm2Save() {
  return new Promise(res =>
    pm2.dump(err => {
      if (err) logger.warn("tc.pm2_save_failed", { message: err.message });
      res();
    })
  );
}


// ── Pure decision function (exported for testing) ────────────────────────────

/**
 * Given a registry entry and the current PM2 process record (or null),
 * returns one of: "start" | "kill_and_restart" | "stand_down"
 *
 * Pure function — no side effects, no PM2 calls, no logging.
 * All inputs are passed explicitly; nowMs defaults to Date.now().
 *
 * @param {object}      entry       Registry entry for the integration
 * @param {object|null} pm2Process  The PM2 process record, or null if not registered
 * @param {number}      [nowMs]     Current timestamp in ms (injectable for testing)
 * @returns {{ decision: string, reason: string, age_seconds?: number }}
 */
export function decide(entry, pm2Process, nowMs = Date.now()) {
  if (!pm2Process) {
    return { decision: "start", reason: "not registered in PM2" };
  }

  const status = pm2Process.pm2_env?.status;

  if (status !== "online") {
    return { decision: "start", reason: `status is "${status}"` };
  }

  const maxTtl    = entry.max_ttl ?? null;
  const startedAt = pm2Process.pm2_env?.pm_uptime ?? null;

  if (maxTtl !== null && startedAt !== null) {
    const ageSeconds = Math.floor((nowMs - startedAt) / 1000);

    if (ageSeconds > maxTtl) {
      return {
        decision:    "kill_and_restart",
        reason:      `running for ${ageSeconds}s, exceeds max_ttl of ${maxTtl}s`,
        age_seconds: ageSeconds,
      };
    }

    return {
      decision:    "stand_down",
      reason:      `running for ${ageSeconds}s, within max_ttl of ${maxTtl}s`,
      age_seconds: ageSeconds,
    };
  }

  return {
    decision: "stand_down",
    reason:   "integration is online and no max_ttl is defined",
  };
}

// ── Core logic ────────────────────────────────────────────────────────────────

async function run(integrationId, registryDir) {
  const meta = { integration: integrationId, registryDir };

  logger.info("tc.woke", meta);

  // Load registry entry for this integration
  const integrations = await loadRegistry(registryDir);
  const entry        = integrations.find(i => i.id === integrationId);

  if (!entry) {
    logger.error("tc.not_in_registry", { ...meta, message: "Integration not found in registry. Nothing to do." });
    process.exit(1);
  }

  if (entry.enabled === false) {
    logger.info("tc.disabled", { ...meta, message: "Integration is disabled. Standing down." });
    process.exit(0);
  }

  await pm2Connect();

  try {
    const list    = await pm2List();
    const current = list.find(p => p.name === integrationId);

    const result = decide(entry, current ?? null);
    const logFn  = result.decision === "kill_and_restart" ? logger.warn : logger.info;

    logFn("tc.decision", {
      ...meta,
      ...result,
      max_ttl: entry.max_ttl ?? null,
    });

    if (result.decision === "start") {
      await startIntegration(entry, registryDir);
    } else if (result.decision === "kill_and_restart") {
      await pm2Delete(integrationId);
      await startIntegration(entry, registryDir);
    }
    // stand_down: do nothing

  } finally {
    await pm2Save();
    pm2Disconnect();
    logger.info("tc.done", meta);
  }
}

async function startIntegration(entry, registryDir) {
  const descriptor = buildIntegrationDescriptor(entry, registryDir);
  await pm2Start(descriptor);
  logger.info("tc.started", { integration: entry.id });
}

// ── Boot (only executes when run as a script, not when imported) ─────────────

function boot() {
  const parsed       = parseArgs(process.argv.slice(2));
  const id           = parsed.integration;
  const regDir       = parsed.registry ? resolve(parsed.registry) : process.cwd();

  if (!id) {
    logger.error("tc.bad_args", { message: "--integration <id> is required" });
    process.exit(1);
  }

  run(id, regDir).catch(err => {
    logger.error("tc.fatal", { integration: id, message: err.message, stack: err.stack });
    pm2Disconnect();
    process.exit(1);
  });
}

// ESM-compatible main guard
const isMain = process.argv[1] &&
  (process.argv[1].endsWith("trafficController.js") ||
   import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/")));

if (isMain) boot();
