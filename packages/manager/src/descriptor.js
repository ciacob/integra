/**
 * @int3gra/manager - descriptor.js
 * Builds PM2 process descriptors from integration registry entries.
 *
 * Per-lifecycle PM2 strategy:
 *
 *   run-once (no lifecycle field)
 *     → single process, autorestart: false (exits cleanly after each run)
 *       Note: for a truly unattended one-shot, the operator starts it manually.
 *
 *   scheduled (schedule field in registry.json)
 *     → integration process: autorestart: false (TC owns start)
 *     → TrafficController:   autorestart: false, cron_restart driven
 *
 *   listener (lifecycle: "listener" in integra.json)
 *     → single process, autorestart: true (long-lived HTTP server, must stay up)
 *     → no TrafficController
 */

import { resolve, join } from "path";
import { createRequire } from "module";
import { readFile }      from "fs/promises";

const require = createRequire(import.meta.url);

function resolveEngineBin() {
  try {
    return require.resolve("@int3gra/engine/src/index.js");
  } catch {
    return resolve(import.meta.dirname ?? ".", "../../engine/src/index.js");
  }
}

function resolveTrafficControllerBin() {
  return resolve(import.meta.dirname ?? ".", "./trafficController.js");
}

const ENGINE_BIN = resolveEngineBin();
const TC_BIN     = resolveTrafficControllerBin();

/**
 * Reads integra.json from an integration directory.
 * Returns {} on any error — callers treat missing fields as absent.
 */
export async function readIntegrationManifest(integrationPath) {
  try {
    const raw = await readFile(join(integrationPath, "integra.json"), "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/**
 * Returns the effective lifecycle for an integration.
 * "scheduled" is derived from the registry entry (has a schedule field).
 * "listener" is declared in the integration's own integra.json.
 * Absent means run-once.
 */
export function resolveLifecycle(registryEntry, manifest) {
  if (registryEntry.schedule)             return "scheduled";
  if (manifest?.lifecycle === "listener") return "listener";
  return "run-once";
}

/**
 * Builds the PM2 descriptor for the integration process itself.
 */
export function buildIntegrationDescriptor(integration, registryDir, lifecycle = "run-once") {
  const cwd       = resolve(registryDir, integration.path);
  const scheduled = lifecycle === "scheduled";
  const listener  = lifecycle === "listener";
  // env_file: use integration.env_file if set, otherwise default to .env
  const envFile   = integration.env_file
    ? resolve(registryDir, integration.env_file)
    : join(cwd, ".env");

  return {
    name:                      integration.id,
    script:                    ENGINE_BIN,
    cwd,
    env_file:                  envFile,
    out_file:                  join(cwd, "logs", "out.log"),
    error_file:                join(cwd, "logs", "err.log"),
    merge_logs:                false,
    // Listeners must stay alive — restart on crash.
    // Scheduled processes are owned by TC — never auto-restart.
    // Run-once processes exit cleanly — no auto-restart needed.
    autorestart:               listener,
    watch:                     false,
    max_restarts:              listener  ? 10 : 0,
    restart_delay:             5000,
    exp_backoff_restart_delay: 1000,
    node_args:                 "--experimental-vm-modules",
  };
}

/**
 * Builds the PM2 descriptor for the TrafficController watchdog.
 * Only meaningful for scheduled integrations.
 */
export function buildTrafficControllerDescriptor(integration, registryDir) {
  const absRegistryDir = resolve(registryDir);
  const cwd            = resolve(registryDir, integration.path);

  return {
    name:         `${integration.id}--tc`,
    script:       TC_BIN,
    args:         `--integration ${integration.id} --registry ${absRegistryDir}`,
    cwd,
    out_file:     join(cwd, "logs", "tc.log"),
    error_file:   join(cwd, "logs", "tc-error.log"),
    merge_logs:   false,
    autorestart:  false,
    cron_restart: integration.schedule,
    watch:        false,
    node_args:    "--experimental-vm-modules",
  };
}

// Backwards-compatible alias
export const buildDescriptor = buildIntegrationDescriptor;
