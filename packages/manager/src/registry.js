// Copyright (c) 2026 Claudius Tiberiu Iacob — Licensed under BSL 1.1. See LICENSE for details.
/**
 * @int3gra/manager - registry.js
 *
 * Public registry API. Same surface as before the registry.d/ migration —
 * loadRegistry() still returns a flat array, setEnabled() still flips one
 * boolean — so manager.js requires zero changes for its read paths.
 *
 * Internally, this is now a thin facade over registryStorage.js (the
 * registry.d/ fragment store) and lock.js (the access-control layer).
 *
 * setEnabled() is the one place that used to do a direct read-modify-write
 * against registry.json. It still needs to mutate a single field, but it
 * must now respect the same lock that a human checkout/publish cycle would.
 * Rather than silently bypassing the lock layer (which would reintroduce
 * exactly the write-race the whole proposal exists to close), it performs
 * its own internal checkout → edit → publish cycle, under the identity of
 * whichever user invoked the manager command. If that user (or anyone else)
 * currently holds a live lock on the same id, setEnabled fails with the same
 * "checked out by X" error a human publish would get — enable/disable are
 * not exempt from the access-control model, they just automate the dance.
 */

import { loadEntries, readEntry, publishEntry } from "./registryStorage.js";
import { acquireLock, removeLock, DEFAULT_LOCK_TTL_MS } from "./lock.js";
import { currentUser } from "./identity.js";

export async function loadRegistry(cwd = process.cwd()) {
  return loadEntries(cwd);
}

export async function setEnabled(id, enabled, cwd = process.cwd(), { now } = {}) {
  const actor = currentUser();

  const lockResult = await acquireLock(cwd, id, actor, DEFAULT_LOCK_TTL_MS, now);
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
    // Always release — whether the publish succeeded or the entry was missing.
    await removeLock(cwd, id);
  }
}
