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
import { resolve }                          from "path";

const EXCLUDED_TOP_LEVEL = new Set([".env", "storage", "logs"]);

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

  // Seed the staged content from the source, with id rewritten up front.
  const seedContent = { ...source, id: newId };
  const dir  = stagingDir ?? defaultStagingDir();
  const path = await seedStagingFile(dir, newId, seedContent, now);

  // Copy the integration folder, excluding run-specific artefacts.
  const sourceDir = resolve(cwd, source.path);
  const targetDir = resolve(cwd, `./${newId}`);

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
