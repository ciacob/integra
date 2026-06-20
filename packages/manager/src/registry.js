// Copyright (c) 2026 Claudius Tiberiu Iacob — Licensed under BSL 1.1. See LICENSE for details.
/**
 * @int3gra/manager - registry.js
 *
 * Public registry API — same surface as before the registry.d/ migration.
 * Thin facade over registryStorage.js and lock.js.
 */

import { loadEntries, readEntry, publishEntry } from "./registryStorage.js";
import { acquireLock, removeLock, readLock, effectiveLockTtlMs } from "./lock.js";
import { currentUser } from "./identity.js";

export async function loadRegistry(cwd = process.cwd()) {
  return loadEntries(cwd);
}

export async function setEnabled(id, enabled, cwd = process.cwd(), { now } = {}) {
  const actor    = currentUser();
  const nowMs    = now ?? Date.now();

  // Check for an existing live lock before attempting to acquire one.
  // acquireLock() allows the same holder to re-acquire (refresh), so without
  // this pre-check we'd silently succeed even when the user has an open
  // checkout — overwriting changes they haven't published yet.
  const existing = await readLock(cwd, id);
  if (existing && (existing.expiresAt > nowMs)) {
    if (existing.holder === actor) {
      throw new Error(
        `"${id}" is currently checked out by you.\n` +
        `Run 'publish ${id}' to save your changes first, ` +
        `or 'uncheckout ${id}' to discard them.`
      );
    }
    // Another user holds a live lock.
    throw new Error(
      `Cannot change "${id}": checked out by "${existing.holder}". ` +
      `Ask them to finish, or wait for their lock to expire.`
    );
  }

  const lockResult = await acquireLock(cwd, id, actor, effectiveLockTtlMs(), nowMs);

  // Guard against the narrow race where someone else acquires between our
  // pre-check and our acquire call.
  if (!lockResult.ok) {
    throw new Error(
      `Cannot change "${id}": checked out by "${lockResult.holder}". ` +
      `Ask them to finish, or wait for their lock to expire.`
    );
  }

  try {
    const entry = await readEntry(cwd, id);
    if (!entry) throw new Error(`Integration not found in registry: ${id}`);

    entry.enabled = enabled;
    await publishEntry(cwd, id, entry);

    return entry;
  } finally {
    await removeLock(cwd, id);
  }
}
