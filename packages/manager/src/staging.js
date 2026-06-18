// Copyright (c) 2026 Claudius Tiberiu Iacob — Licensed under BSL 1.1. See LICENSE for details.
/**
 * @int3gra/manager - staging.js
 *
 * The user's local working area for checked-out registry entries.
 * Default location: ~/integra/ — overridable via the INTEGRA_STAGING_DIR
 * env var (mirrors how most CLI tools let you relocate their scratch space).
 *
 * This is "genuinely personal scratch space" per the proposal §2.5 — normal
 * home-directory permissions apply, no special handling needed beyond
 * making sure the directory exists.
 */

import { readFile, writeFile, mkdir, stat } from "fs/promises";
import { resolve, join } from "path";
import { homedir }       from "os";
import { archiveStaleStagingFile } from "./lock.js";

export function defaultStagingDir() {
  return process.env.INTEGRA_STAGING_DIR
    ? resolve(process.env.INTEGRA_STAGING_DIR)
    : join(homedir(), "integra");
}

function stagingFilePath(stagingDir, id) {
  return join(stagingDir, `${id}.registry.json`);
}

async function pathExists(p) {
  try { await stat(p); return true; } catch { return false; }
}

/**
 * Writes the seed content for a fresh checkout, archiving any pre-existing
 * staging file for the same id first (proposal §2.3 — never silently
 * overwritten or silently reused).
 *
 * Returns the path written to.
 */
export async function seedStagingFile(stagingDir, id, content, nowMs = Date.now()) {
  await mkdir(stagingDir, { recursive: true });
  const target = stagingFilePath(stagingDir, id);

  if (await pathExists(target)) {
    await archiveStaleStagingFile(target, nowMs);
  }

  await writeFile(target, JSON.stringify(content, null, 2) + "\n");
  return target;
}

/**
 * Reads and JSON-parses a staging file. Throws a descriptive error if it's
 * missing or malformed — these are the two most common "I fumbled something"
 * states a user will hit, so the message should point at the fix.
 */
export async function readStagingFile(path) {
  let raw;
  try {
    raw = await readFile(path, "utf-8");
  } catch (err) {
    if (err.code === "ENOENT") {
      throw new Error(`Staging file not found: ${path}\nRun 'checkout <id>' first.`);
    }
    throw err;
  }

  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`Staging file is not valid JSON: ${path}\n${err.message}`);
  }
}

export { stagingFilePath };
