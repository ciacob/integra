// Copyright (c) 2026 Claudius Tiberiu Iacob — Licensed under BSL 1.1. See LICENSE for details.
/**
 * @int3gra/manager - commands/duplicate.js
 *
 * `integra-manager duplicate <id> <new-id>`
 *
 * Locks <new-id>, seeds ~/integra/<new-id>.registry.json from <id>'s live
 * content with the id field already rewritten — so the staged file will
 * already pass the uniqueness check at publish time. Also copies the
 * integration's own directory, excluding .env, storage/, and logs/ (these
 * are run-specific, not part of the integration's definition).
 */

import { acquireLock, effectiveLockTtlMs } from "../lock.js";
import { readEntry, entryExists }           from "../registryStorage.js";
import { seedStagingFile, defaultStagingDir } from "../staging.js";
import { currentUser }                      from "../identity.js";
import { cp, mkdir }                        from "fs/promises";
import { resolve, join }                    from "path";

const EXCLUDED_TOP_LEVEL = new Set([".env", "storage", "logs"]);

/**
 * Computes where a duplicated integration's working directory should live.
 *
 * .integrations/<id>/live is the only supported layout — there is no other
 * valid path configuration for a registered integration's working tree —
 * so the duplicate's directory is always .integrations/<newId>/live under
 * the same root, a sibling of .integrations/<id> itself (not of live/).
 *
 * Pure given its inputs — no I/O, fully unit-testable.
 *
 * @param {string} root   the root .integrations/ lives under (i.e. cwd, which
 *                         by the time manager/index.js calls this is integra's
 *                         fixed home)
 * @param {string} newId  the target integration's id
 * @returns {string}      absolute path for the new integration's live/ directory
 */
export function siblingTargetDir(root, newId) {
  return join(root, ".integrations", newId, "live");
}

export async function duplicate(id, newId, { cwd = process.cwd(), stagingDir, ttlMs, now } = {}) {
  if (!id || !newId) throw new Error("Usage: integra-manager duplicate <id> <new-id>");
  if (id === newId)  throw new Error("Source and target id must differ.");

  const source = await readEntry(cwd, id);
  if (!source) throw new Error(`No published entry found for "${id}" — nothing to duplicate.`);

  if (await entryExists(cwd, newId)) {
    throw new Error(`"${newId}" already exists. Choose a different new id, or 'delete ${newId}' first.`);
  }

  const holder = currentUser();
  const lockResult = await acquireLock(cwd, newId, holder, ttlMs ?? effectiveLockTtlMs(), now);
  if (!lockResult.ok) {
    throw new Error(`"${newId}" is already checked out by "${lockResult.holder}". Try a different id.`);
  }

  // Resolve the target directory first — always .integrations/<newId>/live
  // (see siblingTargetDir) — so the staged registry entry's path can be
  // rewritten to actually match where the files are about to land. Leaving
  // path pointing at the source's old directory (a pre-existing bug,
  // independent of *where* the sibling lands) would publish an entry whose
  // declared path disagrees with the real copy destination.
  const sourceDir = resolve(cwd, source.path);
  const targetDir = siblingTargetDir(cwd, newId);
  const newPath   = `./.integrations/${newId}/live`;

  // Seed the staged content from the source, with id and path rewritten
  // up front — id so the staged file already passes the uniqueness check
  // at publish time, path so it actually points at the copied directory.
  const seedContent = { ...source, id: newId, path: newPath };
  const dir  = stagingDir ?? defaultStagingDir();
  const path = await seedStagingFile(dir, newId, seedContent, now);

  // Copy the integration folder, excluding run-specific artefacts.
  await mkdir(targetDir, { recursive: true });
  await cp(sourceDir, targetDir, {
    recursive: true,
    filter: (src) => {
      const base = src.split("/").pop();
      return !EXCLUDED_TOP_LEVEL.has(base);
    },
  });

  return {
    id: newId,
    holder,
    stagingPath: path,
    integrationDir: targetDir,
    lockExpiresAt: lockResult.record.expiresAt,
  };
}
