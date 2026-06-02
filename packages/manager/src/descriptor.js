/**
 * @integra/manager - descriptor.js
 * Builds PM2 process descriptors from integration registry entries.
 *
 * Two descriptors exist per scheduled integration:
 *   buildIntegrationDescriptor   — the integration process itself
 *   buildTrafficControllerDescriptor — the watchdog that decides when to run it
 *
 * For unscheduled integrations, only buildIntegrationDescriptor is used,
 * with autorestart: true (original behaviour).
 */

import { resolve, join } from "path";
import { createRequire } from "module";

const require = createRequire(import.meta.url);

function resolveEngineBin() {
  try {
    return require.resolve("@integra/engine/src/index.js");
  } catch {
    return resolve(import.meta.dirname ?? ".", "../../engine/src/index.js");
  }
}

function resolveTrafficControllerBin() {
  return resolve(import.meta.dirname ?? ".", "./trafficController.js");
}

const ENGINE_BIN      = resolveEngineBin();
const TC_BIN          = resolveTrafficControllerBin();

/**
 * Builds the PM2 descriptor for the integration process itself.
 *
 * When the integration is scheduled, autorestart is set to false —
 * the TrafficController is the only thing that starts it.
 * When unscheduled, autorestart remains true (supervised long-running service).
 */
export function buildIntegrationDescriptor(integration, registryDir) {
  const cwd        = resolve(registryDir, integration.path);
  const scheduled  = !!integration.schedule;

  return {
    name:                      integration.id,
    script:                    ENGINE_BIN,
    cwd,
    env_file:                  join(cwd, ".env"),
    out_file:                  join(cwd, "logs", "out.log"),
    error_file:                join(cwd, "logs", "err.log"),
    merge_logs:                false,
    autorestart:               !scheduled,   // TC owns restarts for scheduled integrations
    watch:                     false,
    max_restarts:              scheduled ? 0 : 10,
    restart_delay:             5000,
    exp_backoff_restart_delay: 1000,
    node_args:                 "--experimental-vm-modules",
  };
}

/**
 * Builds the PM2 descriptor for the TrafficController watchdog.
 * Only meaningful when the integration has a schedule defined.
 * PM2 restarts the TC on the cron schedule; the TC decides whether
 * to actually start the integration or stand down.
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
    autorestart:  false,          // only cron-driven, never crash-driven
    cron_restart: integration.schedule,
    watch:        false,
    node_args:    "--experimental-vm-modules",
  };
}

// Keep the old name available for any callers that haven't been updated yet
export const buildDescriptor = buildIntegrationDescriptor;
