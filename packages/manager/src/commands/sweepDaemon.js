#!/usr/bin/env node
// Copyright (c) 2026 Claudius Tiberiu Iacob — Licensed under BSL 1.1. See LICENSE for details.
/**
 * @int3gra/manager - commands/sweepDaemon.js
 *
 * PM2-managed process: loops sweepOnce() on an interval, then exits
 * cleanly (process.exit(0), not a crash) the moment a pass reports
 * nothing left to sweep. This is intentional, not a corner cut — a
 * resident process that does nothing for weeks is exactly the kind of
 * thing that gets discovered during an unrelated audit and costs someone
 * attention later for a job that's doing nothing. If it's running, there
 * is something for it to do; if there's nothing to do, it isn't running.
 *
 * Restart-on-crash is handled by PM2's own default behaviour — if this
 * process dies unexpectedly, the only consequence is "stale folders
 * accumulate a bit longer," never data loss, so no custom resilience is
 * needed beyond what PM2 already provides for any managed process.
 *
 * Lazy-started: archive.js's resolveArchive(), on a cache miss that
 * creates a brand new archive folder, checks whether this daemon is
 * currently running under PM2 and starts it if not. This file is the
 * thing that gets started — it is never expected to be run directly by a
 * human.
 */

import { sweepOnce } from "../sweep.js";

const POLL_INTERVAL_MS = 5 * 60 * 1000; // check every 5 minutes

async function loop() {
  const cwd = process.cwd();

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const result = await sweepOnce(cwd);

    if (result.removed.length) {
      console.log(`[sweep] removed ${result.removed.length} stale archive folder(s)`);
    }

    if (result.nothingLeftToSweep) {
      console.log(`[sweep] nothing left to sweep — exiting`);
      process.exit(0);
    }

    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
}

loop().catch(err => {
  console.error(`[sweep] fatal error: ${err.message}`);
  process.exit(1); // let PM2's restart-on-crash handle it
});
