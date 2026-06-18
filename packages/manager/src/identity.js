// Copyright (c) 2026 Claudius Tiberiu Iacob — Licensed under BSL 1.1. See LICENSE for details.
/**
 * @int3gra/manager - identity.js
 *
 * Resolves "who is running this command" for lock ownership.
 * Locking only makes sense if every invocation, regardless of which
 * engineer's shell triggered it, resolves to a stable identity for that
 * engineer (proposal §2.4: "lock state must be visible across sessions
 * and processes").
 *
 * Priority: explicit override (for tests and unusual setups) > OS username.
 * Kept deliberately simple — no LDAP/SSO lookups. The OS username is what
 * every "many engineers, one shared host" setup (cron.d, sudoers.d) relies
 * on already, and it requires zero new infrastructure.
 */

import os from "os";

export function currentUser() {
  return process.env.INTEGRA_USER || os.userInfo().username;
}
