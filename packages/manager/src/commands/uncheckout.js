// Copyright (c) 2026 Claudius Tiberiu Iacob — Licensed under BSL 1.1. See LICENSE for details.
/**
 * @int3gra/manager - commands/uncheckout.js
 *
 * `integra-manager uncheckout <id>`
 *
 * Releases a held lock without publishing — for when an engineer checks
 * something out, decides not to proceed, and wants to free it for others
 * rather than waiting out the TTL. Same ownership checks as publish:
 * Alice cannot uncheckout what Bob checked out.
 */

import { assertCanActOnLock, removeLock } from "../lock.js";
import { currentUser }                    from "../identity.js";

export async function uncheckout(id, { cwd = process.cwd(), now } = {}) {
  if (!id) throw new Error("Usage: integra-manager uncheckout <id>");

  const actor = currentUser();

  // Same authorization check as publish — must hold the live lock.
  await assertCanActOnLock(cwd, id, actor, now);

  await removeLock(cwd, id);

  return { id, released: true };
}
