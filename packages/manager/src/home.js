// Copyright (c) 2026 Claudius Tiberiu Iacob — Licensed under BSL 1.1. See LICENSE for details.
/**
 * @int3gra/manager - home.js
 *
 * The canonical, fixed location of integra's own data: registry.d/ and
 * .integrations/ live directly under this path. Linux-only, by design —
 * integra runs on a server, never on a developer's own machine, and there
 * is no honest cross-platform story for a fixed, root-provisioned system
 * path worth maintaining for a tool nobody runs on Windows or macOS.
 *
 * The path is a literal constant: /opt/integra. Not resolved, not
 * configurable, not redirectable via any environment variable or
 * parameter. There is no relocation mechanism, and deliberately no
 * injection seam for tests either — if a test needs to verify behaviour
 * that depends on this path, it mocks this module's exports, it does not
 * get a back door that the production code could also use to drift from
 * "fixed." Anyone who genuinely needs the underlying storage on a
 * different disk or mount has exactly one lever: symlink /opt/integra to
 * wherever the real storage lives, set up once, before integra is ever
 * invoked for the first time on that host.
 *
 * Nothing creates this path automatically anymore. `integra setup` (see
 * @int3gra/cli's setup command) is the one and only thing that creates
 * it, and it must be run by hand, once, by whoever is provisioning the
 * host — typically as root, since /opt requires elevated privileges to
 * write into. Every other entry point calls assertIntegraHomeExists()
 * first and fails hard, with a message pointing at `integra setup`,
 * rather than silently creating the directory or working around its
 * absence.
 */

import { readFile, writeFile, mkdir } from "fs/promises";
import { existsSync, statSync } from "fs";
import { resolve } from "path";

const PROJECT_NAME = "integra";
const FIXED_HOME    = "/opt/integra";

/**
 * Returns the absolute path to integra's fixed home directory. A literal
 * constant — see the module docstring for why this is deliberately not
 * configurable.
 */
export function resolveIntegraHome() {
  return FIXED_HOME;
}

/**
 * Throws if integra's home does not exist (or exists but isn't a
 * directory — e.g. a stray file at the path). Every command that touches
 * registry.d/ or .integrations/ calls this first, so a host that was
 * never set up fails immediately with a clear, actionable message rather
 * than partway through, or silently creating state in the wrong place.
 *
 * Synchronous and side-effect-free (a stat check, nothing else) so it can
 * be called as the very first line of any entry point without ceremony.
 */
export function assertIntegraHomeExists(home = resolveIntegraHome()) {
  if (!existsSync(home) || !statSync(home).isDirectory()) {
    throw new Error(
      "App was not fully setup, run `integra setup` as sudo."
    );
  }
}

function configPath(home) {
  return resolve(home, "config.json");
}

/**
 * Reads config.json from the home directory. Returns null if it doesn't
 * exist yet — callers decide what that means.
 */
export async function readHomeConfig(home = resolveIntegraHome()) {
  try {
    const raw = await readFile(configPath(home), "utf-8");
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Writes config.json to the home directory, creating the directory if
 * needed. Used by `integra setup` on first provisioning, and available
 * for any future global setting (e.g. a lock TTL or sweep threshold
 * override) to grow into without inventing a second mechanism.
 */
export async function writeHomeConfig(config, home = resolveIntegraHome()) {
  await mkdir(home, { recursive: true });
  await writeFile(configPath(home), JSON.stringify(config, null, 2) + "\n");
}

export { PROJECT_NAME };
