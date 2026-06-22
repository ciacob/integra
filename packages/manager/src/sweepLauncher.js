// Copyright (c) 2026 Claudius Tiberiu Iacob — Licensed under BSL 1.1. See LICENSE for details.
/**
 * @int3gra/manager - sweepLauncher.js
 *
 * Lazy-starts the sweep daemon (commands/sweepDaemon.js) under PM2 the
 * first time an archive is actually created. Kept as its own module,
 * separate from both archive.js (pure git plumbing, no PM2 awareness) and
 * sweep.js (pure eviction logic, no PM2 awareness) — this is the one place
 * those two concerns meet.
 *
 * Idempotent: if the daemon is already running, ensureSweepDaemonRunning()
 * is a fast no-op (one pm2.list() call). Safe to call on every archive
 * creation without meaningfully slowing anything down.
 */

import pm2          from "pm2";
import { resolve }  from "path";
import { fileURLToPath } from "url";

const SWEEP_DAEMON_NAME = "int3gra-sweep";
const __dirname = resolve(fileURLToPath(import.meta.url), "..");
const DAEMON_SCRIPT = resolve(__dirname, "commands/sweepDaemon.js");

function pm2Connect() {
  return new Promise((res, rej) => pm2.connect(err => err ? rej(err) : res()));
}

function pm2Disconnect() {
  pm2.disconnect();
}

function pm2List() {
  return new Promise((res, rej) => pm2.list((err, procs) => err ? rej(err) : res(procs)));
}

function pm2Start(descriptor) {
  return new Promise((res, rej) => pm2.start(descriptor, err => err ? rej(err) : res()));
}

/**
 * Returns true if the sweep daemon is currently known to PM2, in any
 * state (online, stopped, errored) — "known" is enough to mean "don't
 * start a second one"; a stopped-but-known entry will be restarted by an
 * operator or by PM2's own resurrect behaviour, not by this function.
 */
async function daemonIsKnown() {
  const procs = await pm2List();
  return procs.some(p => p.name === SWEEP_DAEMON_NAME);
}

/**
 * Ensures the sweep daemon is running under PM2, starting it if it isn't
 * already known to PM2. Connects and disconnects its own PM2 session —
 * callers do not need to manage the connection.
 */
export async function ensureSweepDaemonRunning(cwd = process.cwd()) {
  await pm2Connect();
  try {
    if (await daemonIsKnown()) return { started: false };

    await pm2Start({
      name:         SWEEP_DAEMON_NAME,
      script:       DAEMON_SCRIPT,
      cwd,
      autorestart:  true,   // PM2's own crash-restart — no custom resilience needed
      max_restarts: 10,
    });

    return { started: true };
  } finally {
    pm2Disconnect();
  }
}

export { SWEEP_DAEMON_NAME };
