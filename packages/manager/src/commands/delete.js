// Copyright (c) 2026 Claudius Tiberiu Iacob — Licensed under BSL 1.1. See LICENSE for details.
/**
 * @int3gra/manager - commands/delete.js
 *
 * `integra-manager delete <id> [--purge]`
 *
 * Design decision for the open question in the proposal (§4): delete
 * auto-acquires a lock exactly like checkout does, rather than requiring a
 * separate prior `checkout` step. Rationale: deletion is a single atomic
 * intent ("this id should no longer exist") rather than an editing session,
 * so forcing a two-step checkout-then-delete adds friction without adding
 * safety. The auto-acquire still goes through the normal acquireLock()
 * path, so it is correctly rejected if someone else currently holds a live
 * lock on the same id — you cannot delete out from under an in-progress edit.
 *
 * Symmetrical to publish: removes the registry.d/ entry, rebuilds happens
 * naturally on next loadEntries() call, and the lock is released.
 * --purge additionally removes the integration's own directory.
 */

import { acquireLock, removeLock, effectiveLockTtlMs } from "../lock.js";
import { removeEntry, readEntry, registryDirPath } from "../registryStorage.js";
import { currentUser } from "../identity.js";
import { rm } from "fs/promises";
import { resolve } from "path";

export async function deleteEntry(id, { cwd = process.cwd(), purge = false, ttlMs, now } = {}) {
  if (!id) throw new Error("Usage: integra-manager delete <id> [--purge]");

  const actor = currentUser();

  // Auto-acquire — fails cleanly if someone else holds a live lock.
  const lockResult = await acquireLock(cwd, id, actor, ttlMs ?? effectiveLockTtlMs(), now);
  if (!lockResult.ok) {
    throw new Error(
      `Cannot delete "${id}": checked out by "${lockResult.holder}". ` +
      `Ask them to finish or 'uncheckout ${id}' first.`
    );
  }

  const existing = await readEntry(cwd, id);
  if (!existing) {
    await removeLock(cwd, id);
    throw new Error(`No published entry found for "${id}" — nothing to delete.`);
  }

  await removeEntry(cwd, id);

  let purgedPath = null;
  if (purge) {
    purgedPath = resolve(cwd, existing.path);
    await rm(purgedPath, { recursive: true, force: true });
  }

  await removeLock(cwd, id);

  return { id, deleted: true, purgedPath };
}
