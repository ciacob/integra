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

const args           = parseArgs(process.argv.slice(2));
const integrationId  = args.integration;
const registryDir    = args.registry ? resolve(args.registry) : process.cwd();

if (!integrationId) {
  logger.error("tc.bad_args", { message: "--integration <id> is required" });
  process.exit(1);
}

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

// ── Core logic ────────────────────────────────────────────────────────────────

async function run() {
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

    if (!current) {
      // Not registered in PM2 at all — start fresh
      logger.info("tc.decision", { ...meta, decision: "start", reason: "not registered in PM2" });
      await startIntegration(entry);
      return;
    }

    const status = current.pm2_env?.status;

    if (status !== "online") {
      // Stopped, errored, or otherwise not running — start fresh
      logger.info("tc.decision", { ...meta, decision: "start", reason: `status is "${status}"` });
      await pm2Delete(integrationId);
      await startIntegration(entry);
      return;
    }

    // Currently online — check max_ttl
    const maxTtl   = entry.max_ttl ?? null;
    const startedAt = current.pm2_env?.pm_uptime ?? null;

    if (maxTtl !== null && startedAt !== null) {
      const ageSeconds = Math.floor((Date.now() - startedAt) / 1000);

      if (ageSeconds > maxTtl) {
        logger.warn("tc.decision", {
          ...meta,
          decision:   "kill_and_restart",
          reason:     `running for ${ageSeconds}s, exceeds max_ttl of ${maxTtl}s`,
          age_seconds: ageSeconds,
          max_ttl:    maxTtl,
        });
        await pm2Delete(integrationId);
        await startIntegration(entry);
        return;
      }

      logger.info("tc.decision", {
        ...meta,
        decision:   "stand_down",
        reason:     `running for ${ageSeconds}s, within max_ttl of ${maxTtl}s`,
        age_seconds: ageSeconds,
        max_ttl:    maxTtl,
      });
      return;
    }

    // Online, no max_ttl defined — always respect it
    logger.info("tc.decision", {
      ...meta,
      decision: "stand_down",
      reason:   "integration is online and no max_ttl is defined",
    });

  } finally {
    await pm2Save();
    pm2Disconnect();
    logger.info("tc.done", meta);
  }
}

async function startIntegration(entry) {
  const descriptor = buildIntegrationDescriptor(entry, registryDir);
  await pm2Start(descriptor);
  logger.info("tc.started", { integration: entry.id });
}

// ── Boot ──────────────────────────────────────────────────────────────────────

run().catch(err => {
  logger.error("tc.fatal", { integration: integrationId, message: err.message, stack: err.stack });
  pm2Disconnect();
  process.exit(1);
});
