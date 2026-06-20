// Copyright (c) 2026 Claudius Tiberiu Iacob — Licensed under BSL 1.1. See LICENSE for details.
/**
 * @int3gra/manager - commands/checkout.js
 *
 * `integra-manager checkout <id>`
 *
 * Acquires an exclusive, time-boxed lock on <id> and seeds a staging file
 * from the integration's current live content, ready to edit.
 *
 * Requires the id to already exist in registry.d/. If it doesn't, the user
 * is directed to `integra init <id>` — that is the one and only creation
 * path. Accepting a non-existing id here would make typos silently create
 * ghost entries, which is worse than a clear error.
 *
 * The lock TTL is read from INTEGRA_LOCK_TTL_SECONDS in the environment
 * (default: 30 minutes). Set this in your .env file to adjust team-wide.
 */

import { acquireLock, effectiveLockTtlMs } from "../lock.js";
import { readEntry }                        from "../registryStorage.js";
import { seedStagingFile, defaultStagingDir } from "../staging.js";
import { currentUser }                      from "../identity.js";

export async function checkout(id, { cwd = process.cwd(), stagingDir, ttlMs, now } = {}) {
  if (!id) throw new Error("Usage: integra-manager checkout <id>");

  // Error clearly on non-existing id — creation must go through `integra init`.
  const existing = await readEntry(cwd, id);
  if (!existing) {
    throw new Error(
      `"${id}" is not registered in registry.d/.\n` +
      `To register a new integration, run 'integra init ${id}' first.`
    );
  }

  const holder     = currentUser();
  const resolvedTtl = ttlMs ?? effectiveLockTtlMs();
  const result     = await acquireLock(cwd, id, holder, resolvedTtl, now);

  if (!result.ok) {
    const minutesLeft = Math.ceil((result.expiresAt - (now ?? Date.now())) / 60000);
    throw new Error(
      `"${id}" is already checked out by "${result.holder}" ` +
      `(expires in ~${minutesLeft} min). Try again later, or ask them to ` +
      `'uncheckout ${id}' if they're done.`
    );
  }

  const dir  = stagingDir ?? defaultStagingDir();
  const path = await seedStagingFile(dir, id, existing, now);

  return {
    id,
    holder,
    stagingPath: path,
    lockExpiresAt: result.record.expiresAt,
  };
}
