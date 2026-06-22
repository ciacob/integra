// Copyright (c) 2026 Claudius Tiberiu Iacob — Licensed under BSL 1.1. See LICENSE for details.
/**
 * @int3gra/manager - home.js
 *
 * The canonical, fixed location of integra's own data: registry.d/ and
 * .integrations/ live directly under this path. Resolved via env-paths,
 * which picks the right convention per platform (XDG on Linux, Application
 * Support on macOS, %APPDATA% on Windows) — integra is not deliberately
 * Unix-only, even though every real deployment of it today is.
 *
 * There is no relocation mechanism. The home is whatever env-paths
 * resolves for the user that ran `npm install -g @int3gra/manager`, fixed
 * at that moment, for as long as the install exists. This removes an
 * entire category of problems a movable home would otherwise need to
 * handle: no migration story, no "what if running processes are still
 * pointed at the old location," no question of whether data needs copying.
 * Anyone who genuinely needs the underlying storage on a different disk or
 * mount has exactly one lever: symlink the resolved path to wherever the
 * real storage lives, set up once, before integra is ever invoked for the
 * first time.
 *
 * The suffix env-paths appends by default ("-nodejs", meant to avoid
 * collisions with native apps of the same name) is explicitly disabled
 * here — there is no competing native "integra" application, and the
 * suffix would appear in every doc example, every error message, and
 * every path a person ever has to type or read. env-paths' own docs flag
 * this as an option to leave alone "unless you really have to" — this is
 * judged to be exactly such a case.
 *
 * postinstall.js is the only place that creates anything at this path on
 * a fresh install; this module is read-mostly elsewhere.
 */

import envPaths from "env-paths";
import { readFile, writeFile, mkdir } from "fs/promises";
import { resolve } from "path";

const PROJECT_NAME = "integra";

/**
 * Returns the absolute path to integra's fixed home directory. Pure given
 * the environment — no filesystem access, no caching across calls (cheap
 * enough to recompute, and recomputing means it always reflects the
 * current environment rather than whatever it was at first import, which
 * matters for tests that override XDG_DATA_HOME between cases).
 */
export function resolveIntegraHome() {
  return envPaths(PROJECT_NAME, { suffix: "" }).data;
}

function configPath(home) {
  return resolve(home, "config.json");
}

/**
 * Reads config.json from the home directory. Returns null if it doesn't
 * exist yet — callers decide what that means (typically: integra hasn't
 * been installed/initialised on this host, or postinstall hasn't run).
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
 * needed. Used by postinstall.js on a fresh install, and available for
 * any future global setting (e.g. a lock TTL or sweep threshold override)
 * to grow into without inventing a second mechanism.
 */
export async function writeHomeConfig(config, home = resolveIntegraHome()) {
  await mkdir(home, { recursive: true });
  await writeFile(configPath(home), JSON.stringify(config, null, 2) + "\n");
}

export { PROJECT_NAME };
