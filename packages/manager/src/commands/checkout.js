// Copyright (c) 2026 Claudius Tiberiu Iacob — Licensed under BSL 1.1. See LICENSE for details.
/**
 * @int3gra/manager - commands/checkout.js
 *
 * `integra-manager checkout <id>`
 *
 * Acquires an exclusive, time-boxed lock on <id> and seeds a staging file
 * the user can edit. If <id> already exists live, the staging file is
 * seeded from its current content. If it doesn't exist yet, this is how a
 * brand new integration gets registered — seeded from a minimal template.
 */

import { acquireLock, DEFAULT_LOCK_TTL_MS } from "../lock.js";
import { readEntry }                        from "../registryStorage.js";
import { seedStagingFile, defaultStagingDir,
         stagingFilePath }                  from "../staging.js";
import { currentUser }                      from "../identity.js";

function minimalTemplate(id) {
  return {
    id,
    path:        `./${id}`,
    enabled:     true,
    description: "",
  };
}

export async function checkout(id, { cwd = process.cwd(), stagingDir, ttlMs = DEFAULT_LOCK_TTL_MS, now } = {}) {
  if (!id) throw new Error("Usage: integra-manager checkout <id>");

  const holder = currentUser();
  const result = await acquireLock(cwd, id, holder, ttlMs, now);

  if (!result.ok) {
    const minutesLeft = Math.ceil((result.expiresAt - (now ?? Date.now())) / 60000);
    throw new Error(
      `"${id}" is already checked out by "${result.holder}" ` +
      `(expires in ~${minutesLeft} min). Try again later, or ask them to ` +
      `'uncheckout ${id}' if they're done.`
    );
  }

  const existing = await readEntry(cwd, id);
  const seedContent = existing ?? minimalTemplate(id);
  const isNew        = existing === null;

  const dir  = stagingDir ?? defaultStagingDir();
  const path = await seedStagingFile(dir, id, seedContent, now);

  return {
    id,
    holder,
    isNew,
    stagingPath: path,
    lockExpiresAt: result.record.expiresAt,
  };
}
