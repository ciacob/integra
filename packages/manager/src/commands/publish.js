// Copyright (c) 2026 Claudius Tiberiu Iacob — Licensed under BSL 1.1. See LICENSE for details.
/**
 * @int3gra/manager - commands/publish.js
 *
 * `integra-manager publish <id> [file]`
 *
 * Validation order (per proposal §2.3):
 *   1. An unexpired lock for <id> exists.
 *   2. The calling user matches the lock's holder (unless expired).
 *   3. The file is schema-valid.
 *   4. The id declared inside the file's content matches the id argument.
 *   5. (implicit in step 4 + publishEntry) the write itself is atomic.
 *
 * On success: entry lands in registry.d/, lock is released.
 * On any failure: registry.d/ is untouched.
 */

import { assertCanActOnLock, removeLock } from "../lock.js";
import { publishEntry, validateEntry }     from "../registryStorage.js";
import { readStagingFile, defaultStagingDir,
         stagingFilePath }                 from "../staging.js";
import { currentUser }                     from "../identity.js";

export async function publish(id, file, { cwd = process.cwd(), stagingDir, now } = {}) {
  if (!id) throw new Error("Usage: integra-manager publish <id> [file]");

  const actor = currentUser();

  // 1 & 2: lock must exist, be unexpired, and belong to this actor.
  await assertCanActOnLock(cwd, id, actor, now);

  // Resolve the file to publish — defaults to the staging copy.
  const dir  = stagingDir ?? defaultStagingDir();
  const path = file ?? stagingFilePath(dir, id);
  const data = await readStagingFile(path);

  // 3: schema-valid content.
  await validateEntry(data);

  // 4: declared id must match the id we're publishing under.
  //    publishEntry() already enforces this, but we check here too so the
  //    error surfaces before any lock state changes.
  if (data.id !== id) {
    throw new Error(
      `Staged file declares id "${data.id}" but you're publishing it as "${id}".\n` +
      `Edit the file's "id" field, or run 'publish ${data.id}' instead.`
    );
  }

  // Write — atomic, validated again internally for defence in depth.
  await publishEntry(cwd, id, data);

  // Release the lock only after a successful write.
  await removeLock(cwd, id);

  return { id, path };
}
