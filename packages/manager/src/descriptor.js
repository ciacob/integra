/**
 * @integra/manager - descriptor.js
 * Builds PM2 process descriptors from integration registry entries.
 */

import { resolve, join } from "path";
import { createRequire } from "module";

const require = createRequire(import.meta.url);

function resolveEngineBin() {
  try {
    return require.resolve("@integra/engine/src/index.js");
  } catch {
    // Fallback for monorepo development
    return resolve(import.meta.dirname ?? ".", "../../engine/src/index.js");
  }
}

const ENGINE_BIN = resolveEngineBin();

export function buildDescriptor(integration, registryDir) {
  const cwd = resolve(registryDir, integration.path);

  return {
    name:                      integration.id,
    script:                    ENGINE_BIN,
    cwd,
    env_file:                  join(cwd, ".env"),
    out_file:                  join(cwd, "logs", "out.log"),
    error_file:                join(cwd, "logs", "err.log"),
    merge_logs:                false,
    autorestart:               true,
    watch:                     false,
    max_restarts:              10,
    restart_delay:             5000,
    exp_backoff_restart_delay: 1000,
    node_args:                 "--experimental-vm-modules",
  };
}
