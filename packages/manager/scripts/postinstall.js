#!/usr/bin/env node
// Copyright (c) 2026 Claudius Tiberiu Iacob — Licensed under BSL 1.1. See LICENSE for details.
/**
 * @int3gra/manager - scripts/postinstall.js
 *
 * npm postinstall hook. Runs automatically after `npm install`.
 *
 * Deliberately narrow, on the principle that an unconditional postinstall
 * writing to the filesystem is exactly the pattern that has burned the npm
 * ecosystem before (crypto-miners, telemetry, surprise network calls):
 *
 *   - Never overwrites an existing config — if integra's home already has
 *     a config.json, this is a true no-op, every time, including on
 *     reinstall/upgrade.
 *   - Never makes a network call.
 *   - Never touches anything outside the one resolved home path.
 *   - Never requires elevated privileges on its own — correctness of the
 *     resulting permissions depends entirely on *which user* ran
 *     `npm install -g`, which is a deployment/process concern (see the
 *     README's dedicated-service-user recommendation), not something this
 *     script enforces or assumes.
 *
 * If the dedicated-service-user model is followed, this runs as that
 * service user, and the resulting home directory is naturally owned by
 * it — no extra step required here for that to be true.
 */

import { resolveIntegraHome, readHomeConfig, writeHomeConfig } from "../src/home.js";

async function main() {
  const home = resolveIntegraHome();
  const existing = await readHomeConfig(home);

  if (existing !== null) {
    // Already initialised — true no-op, including on reinstall/upgrade.
    return;
  }

  await writeHomeConfig({}, home);
  console.log(`[int3gra] Initialised home: ${home}`);
}

main().catch(err => {
  // A postinstall failure must never block `npm install` itself from
  // succeeding — print a warning and exit 0. Worst case, the home gets
  // created lazily by whatever command needs it next, or the operator can
  // re-run this script directly.
  console.warn(`[int3gra] postinstall warning: ${err.message}`);
  process.exit(0);
});
