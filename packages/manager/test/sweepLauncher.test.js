// Copyright (c) 2026 Claudius Tiberiu Iacob — Licensed under BSL 1.1. See LICENSE for details.
/**
 * packages/manager/test/sweepLauncher.test.js
 *
 * This is the one test file that deliberately talks to a real, local PM2
 * daemon — sweepLauncher.js's entire job is PM2 interaction, so faking it
 * out would test nothing. Every test that starts the daemon cleans it up
 * in afterEach via pm2.delete, so no int3gra-sweep process survives this
 * file's run regardless of pass/fail.
 *
 * Requires a working local PM2 daemon — the same one every other part of
 * this codebase already assumes (manager.js connects to it directly).
 */

import pm2 from "pm2";

import { ensureSweepDaemonRunning, SWEEP_DAEMON_NAME } from "../src/sweepLauncher.js";

function pm2Connect() {
  return new Promise((res, rej) => pm2.connect(err => err ? rej(err) : res()));
}
function pm2Disconnect() {
  pm2.disconnect();
}
function pm2Delete(name) {
  return new Promise(res => pm2.delete(name, () => res())); // never reject — may not exist
}
function pm2List() {
  return new Promise((res, rej) => pm2.list((err, procs) => err ? rej(err) : res(procs)));
}

describe("sweepLauncher", () => {
  afterEach(async () => {
    // Unconditional cleanup, regardless of what the test did or whether it failed.
    await pm2Connect();
    await pm2Delete(SWEEP_DAEMON_NAME);
    pm2Disconnect();
  });

  test("starts the daemon when it is not already known to PM2", async () => {
    const result = await ensureSweepDaemonRunning(process.cwd());
    expect(result.started).toBe(true);

    await pm2Connect();
    const procs = await pm2List();
    pm2Disconnect();

    expect(procs.some(p => p.name === SWEEP_DAEMON_NAME)).toBe(true);
  });

  test("is idempotent — a second call does not start a duplicate", async () => {
    await ensureSweepDaemonRunning(process.cwd());
    const second = await ensureSweepDaemonRunning(process.cwd());

    expect(second.started).toBe(false);

    await pm2Connect();
    const procs = await pm2List();
    pm2Disconnect();

    const matches = procs.filter(p => p.name === SWEEP_DAEMON_NAME);
    expect(matches).toHaveLength(1);
  });
}, 20000); // PM2 start/list round-trips can be slow in CI; generous timeout
