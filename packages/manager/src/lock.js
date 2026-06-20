// Copyright (c) 2026 Claudius Tiberiu Iacob — Licensed under BSL 1.1. See LICENSE for details.
/**
 * @int3gra/manager - lock.js
 *
 * Implements the locking semantics described in the registry-d proposal:
 *   - Locks are exclusive per integration id.
 *   - Locks are time-boxed; an expired lock is treated as if it doesn't exist.
 *   - Only the original holder may publish/uncheckout against a live lock.
 *   - Lock state must be visible across processes/sessions, so it is a file
 *     on disk (registry.d-locks/<id>.lock.json), not in-memory state.
 *
 * Pure functions (no I/O):
 *   isExpired, buildLockRecord, canActOnLock
 *
 * I/O wrappers (thin, delegate decisions to the pure functions above):
 *   readLock, writeLock, removeLock, acquireLock, assertCanActOnLock
 */

import { readFile, writeFile, unlink, mkdir, rename } from "fs/promises";
import { resolve, join } from "path";

export const DEFAULT_LOCK_TTL_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Returns the effective lock TTL in milliseconds.
 * Reads INTEGRA_LOCK_TTL_SECONDS from the environment if set (loaded from
 * whichever .env file was passed to the manager command — the same files
 * that hold credentials). Falls back to DEFAULT_LOCK_TTL_MS.
 *
 * Kept as a function rather than a constant so it always reflects the
 * env as it stands at call time — the .env may have been loaded after
 * this module was first imported.
 */
export function effectiveLockTtlMs() {
  const raw = process.env.INTEGRA_LOCK_TTL_SECONDS;
  if (raw) {
    const seconds = parseInt(raw, 10);
    if (!Number.isNaN(seconds) && seconds > 0) return seconds * 1000;
  }
  return DEFAULT_LOCK_TTL_MS;
}

// ── Pure decision functions ───────────────────────────────────────────────────

/**
 * Returns true if a lock record is expired as of `nowMs`.
 * A null/undefined record is treated as "no lock" — callers decide what that
 * means; this function only answers the expiry question for a record that
 * does exist.
 */
export function isExpired(lockRecord, nowMs = Date.now()) {
  if (!lockRecord || typeof lockRecord.expiresAt !== "number") return true;
  return nowMs >= lockRecord.expiresAt;
}

/**
 * Builds a new lock record. Pure given its inputs.
 */
export function buildLockRecord(id, holder, nowMs = Date.now(), ttlMs = DEFAULT_LOCK_TTL_MS) {
  return {
    id,
    holder,
    acquiredAt: nowMs,
    expiresAt:  nowMs + ttlMs,
  };
}

/**
 * Decides whether `actor` may act (publish / uncheckout / delete) against
 * an existing lock record at `nowMs`.
 *
 * Rules (from the proposal, §2.4):
 *   - No lock at all                → cannot act (nothing was checked out)
 *   - Lock exists, expired          → cannot act under THIS lock; the lock
 *                                      confers no protection to its original
 *                                      holder once expired. Caller should
 *                                      treat this the same as "no lock" for
 *                                      the purpose of message wording, but
 *                                      action still requires a fresh checkout.
 *   - Lock exists, live, same actor → can act
 *   - Lock exists, live, other actor→ cannot act
 *
 * Returns { ok: boolean, reason: string } rather than throwing, so callers
 * (including tests) can inspect *why* without parsing error messages.
 */
export function canActOnLock(lockRecord, actor, nowMs = Date.now()) {
  if (!lockRecord) {
    return { ok: false, reason: "no_lock" };
  }
  if (isExpired(lockRecord, nowMs)) {
    return { ok: false, reason: "lock_expired" };
  }
  if (lockRecord.holder !== actor) {
    return { ok: false, reason: "held_by_other", holder: lockRecord.holder };
  }
  return { ok: true, reason: "ok" };
}

// ── I/O wrappers ──────────────────────────────────────────────────────────────

function locksDir(registryDir) {
  return resolve(registryDir, "registry.d-locks");
}

function lockPath(registryDir, id) {
  return join(locksDir(registryDir), `${id}.lock.json`);
}

/**
 * Reads a lock record for `id`. Returns null if no lock file exists.
 * A malformed lock file is treated as absent (logged by the caller if desired)
 * rather than crashing the whole flow — a corrupt lock should never be able
 * to permanently block an integration.
 */
export async function readLock(registryDir, id) {
  try {
    const raw = await readFile(lockPath(registryDir, id), "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function writeLockFile(registryDir, id, record) {
  await mkdir(locksDir(registryDir), { recursive: true });
  await writeFile(lockPath(registryDir, id), JSON.stringify(record, null, 2) + "\n");
}

export async function removeLock(registryDir, id) {
  try {
    await unlink(lockPath(registryDir, id));
  } catch {
    // already gone — fine
  }
}

/**
 * Attempts to acquire a lock for `id` on behalf of `holder`.
 *
 * If an existing lock is present and still live and held by someone else,
 * acquisition fails. If the existing lock is expired (or absent), it is
 * physically removed (per proposal §2.4: "Expired lock files get physically
 * deleted on next successful checkout") and a fresh lock is written.
 *
 * Returns { ok: true, record } or { ok: false, reason, holder? }.
 */
export async function acquireLock(registryDir, id, holder, ttlMs = DEFAULT_LOCK_TTL_MS, nowMs = Date.now()) {
  const existing = await readLock(registryDir, id);

  if (existing && !isExpired(existing, nowMs) && existing.holder !== holder) {
    return { ok: false, reason: "held_by_other", holder: existing.holder, expiresAt: existing.expiresAt };
  }

  // Either no lock, an expired lock, or our own still-live lock — proceed.
  // Re-acquiring our own live lock simply refreshes the TTL, which is a
  // reasonable behaviour for a long edit session.
  const record = buildLockRecord(id, holder, nowMs, ttlMs);
  await writeLockFile(registryDir, id, record);
  return { ok: true, record };
}

/**
 * Throws a descriptive Error if `actor` may not act on `id`'s lock right now.
 * Thin wrapper around canActOnLock for call sites that want exceptions.
 */
export async function assertCanActOnLock(registryDir, id, actor, nowMs = Date.now()) {
  const record   = await readLock(registryDir, id);
  const decision = canActOnLock(record, actor, nowMs);

  if (decision.ok) return record;

  switch (decision.reason) {
    case "no_lock":
      throw new Error(`No active checkout found for "${id}". Run 'checkout ${id}' first.`);
    case "lock_expired":
      throw new Error(`Your checkout of "${id}" has expired. Run 'checkout ${id}' again.`);
    case "held_by_other":
      throw new Error(`"${id}" is checked out by "${decision.holder}". You cannot act on their lock.`);
    default:
      throw new Error(`Cannot act on lock for "${id}".`);
  }
}

/**
 * Renames a stale staging file out of the way rather than overwriting it.
 * Per proposal §2.3: "renamed (e.g. <id>.registry.json.old_<epoch_seconds>)".
 */
export async function archiveStaleStagingFile(stagingPath, nowMs = Date.now()) {
  const archivedPath = `${stagingPath}.old_${Math.floor(nowMs / 1000)}`;
  await rename(stagingPath, archivedPath);
  return archivedPath;
}
