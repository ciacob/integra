// Copyright (c) 2026 Claudius Tiberiu Iacob — Licensed under BSL 1.1. See LICENSE for details.
/**
 * @int3gra/manager - registryStorage.js
 *
 * Storage layer for the decomposed registry: a directory of per-integration
 * fragments (registry.d/<id>.registry.json) instead of one shared
 * registry.json file.
 *
 * This module is the *only* place that knows the on-disk shape changed.
 * It exposes the same flat-array contract loadRegistry() always returned,
 * so manager.js and everything above it needs zero changes for reads.
 *
 * Writes (publishEntry / removeEntry) are only ever called from the
 * checkout/publish/delete/duplicate command modules — never directly by
 * manager.js — because writes must go through the lock layer first.
 */

import { readFile, writeFile, readdir, unlink, mkdir, rename } from "fs/promises";
import { resolve, join } from "path";
import { fileURLToPath } from "url";
import Ajv from "ajv";

const __dirname    = resolve(fileURLToPath(import.meta.url), "..");
const SCHEMA_FILE   = resolve(__dirname, "../schemas/registry-entry.schema.json");
const REGISTRY_DIR  = "registry.d";
const ENTRY_SUFFIX  = ".registry.json";

let cachedSchema = null;

async function loadEntrySchema() {
  if (cachedSchema !== null) return cachedSchema;
  try {
    const raw = await readFile(SCHEMA_FILE, "utf-8");
    cachedSchema = JSON.parse(raw);
  } catch {
    cachedSchema = null; // schema file absent — skip validation rather than crash
  }
  return cachedSchema;
}

/**
 * Validates a single entry object. Throws with field-level detail on failure.
 * Exported so checkout/publish flows can validate staged content before
 * attempting to write it live.
 */
export async function validateEntry(data) {
  const schema = await loadEntrySchema();
  if (!schema) return; // no schema available — accept (matches prior behaviour)

  const ajv      = new Ajv({ allErrors: true });
  const validate = ajv.compile(schema);
  if (!validate(data)) {
    const errors = validate.errors
      .map(e => `  ${e.instancePath || "(root)"} ${e.message}`)
      .join("\n");
    throw new Error(`Registry entry validation failed:\n${errors}`);
  }
}

function registryDirPath(cwd) {
  return resolve(cwd, REGISTRY_DIR);
}

function entryFilePath(cwd, id) {
  return join(registryDirPath(cwd), `${id}${ENTRY_SUFFIX}`);
}

/**
 * Lists every <id> currently published in registry.d/, derived from
 * filenames — this is intentionally filename-driven (not content-driven)
 * for the *listing* step; validateEntry() checks that file content's
 * declared id matches expectations at publish time, not at read time,
 * matching proposal §4: a locally renamed staged file is still published
 * under the id its *content* declares, but once live, the filename is the
 * source of truth for "what ids exist" so a directory listing is cheap.
 */
async function listEntryIds(cwd) {
  const dir = registryDirPath(cwd);
  try {
    const files = await readdir(dir);
    return files
      .filter(f => f.endsWith(ENTRY_SUFFIX))
      .map(f => f.slice(0, -ENTRY_SUFFIX.length));
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}

/**
 * Reads and validates a single published entry. Returns null if absent.
 */
export async function readEntry(cwd, id) {
  try {
    const raw  = await readFile(entryFilePath(cwd, id), "utf-8");
    const data = JSON.parse(raw);
    await validateEntry(data);
    return data;
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Reads, validates, and assembles every published entry into the flat array
 * the rest of the system expects. This is the read-side replacement for the
 * old "parse registry.json, return data.integrations" path.
 *
 * Throws if registry.d/ does not exist at all — mirrors the old behaviour
 * of throwing when registry.json was missing, so callers get an equally
 * clear signal that the manager hasn't been initialised in this directory.
 */
export async function loadEntries(cwd = process.cwd()) {
  const dir = registryDirPath(cwd);
  const ids = await listEntryIds(cwd);

  if (ids.length === 0) {
    // Distinguish "directory missing entirely" (likely not initialised)
    // from "directory exists but is empty" (valid — zero integrations yet).
    try {
      await readdir(dir);
      return []; // directory exists, just empty — valid state
    } catch (err) {
      if (err.code === "ENOENT") {
        throw new Error(
          `No registry.d/ directory found at ${dir}.\n` +
          `Run 'integra-manager checkout <id>' then 'publish' to register your first integration.`
        );
      }
      throw err;
    }
  }

  const entries = [];
  for (const id of ids.sort()) {
    const data = await readEntry(cwd, id);
    if (data) entries.push(data);
  }
  return entries;
}

/**
 * Atomically writes a validated entry into registry.d/.
 * Write-temp-then-rename, so a crash mid-write can never leave a partially
 * written file where loadEntries() would trip over it.
 *
 * Callers (publish.js) are responsible for checking the lock *before*
 * calling this — this function only enforces content validity, not
 * authorization.
 */
export async function publishEntry(cwd, id, data) {
  await validateEntry(data);

  if (data.id !== id) {
    throw new Error(
      `Entry content declares id "${data.id}" but is being published as "${id}". ` +
      `These must match.`
    );
  }

  const dir = registryDirPath(cwd);
  await mkdir(dir, { recursive: true });

  const finalPath = entryFilePath(cwd, id);
  const tmpPath   = `${finalPath}.tmp_${process.pid}_${Date.now()}`;

  await writeFile(tmpPath, JSON.stringify(data, null, 2) + "\n");
  await rename(tmpPath, finalPath);
}

/**
 * Removes a published entry. No-op (does not throw) if it was already absent,
 * matching the general "deletion of something already gone is not an error"
 * convention used elsewhere in this codebase (e.g. pm2StopOne).
 */
export async function removeEntry(cwd, id) {
  try {
    await unlink(entryFilePath(cwd, id));
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
}

/**
 * True if an entry with this id is currently published.
 */
export async function entryExists(cwd, id) {
  return (await readEntry(cwd, id)) !== null;
}

export { registryDirPath, entryFilePath };
