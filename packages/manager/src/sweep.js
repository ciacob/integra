// Copyright (c) 2026 Claudius Tiberiu Iacob — Licensed under BSL 1.1. See LICENSE for details.
/**
 * @int3gra/manager - sweep.js
 *
 * Eviction for ephemeral archive folders (.integrations/<id>/tests/<sha>/),
 * produced by archive.js's resolveArchive(). This module answers a
 * deliberately different question than archive.js does:
 *
 *   - archive.js:  "is this folder's content correct?" — answered by SHA
 *                  match, no marker file, no mtime involved at all.
 *   - sweep.js:    "is this folder still needed?" — answered here, by
 *                  finding the most-recently-modified file inside each
 *                  folder and comparing its age against a fixed threshold.
 *
 * No marker file is written or read by either module — a SHA-named folder
 * is either correct (exists, matches) or stale (too old since anything
 * touched it), and both questions are answerable from information that
 * already exists on disk.
 *
 * Threshold is fixed at 2 hours, intentionally not configurable — this is
 * a safety net for crashed/abandoned runs, not a tuning knob.
 *
 * Deletion is async/best-effort: a failed delete (permissions, a file held
 * open) is logged and skipped, not retried inline — the next sweep pass
 * will simply try again.
 */

import { readdir, stat, rm } from "fs/promises";
import { resolve, join }     from "path";

export const SWEEP_THRESHOLD_MS = 2 * 60 * 60 * 1000; // 2 hours, fixed

function integrationsRoot(cwd) {
  return resolve(cwd, ".integrations");
}

/**
 * Finds the most recent mtime among all files in `dir`, recursively.
 * Returns null if the directory is empty or unreadable (treated as
 * "nothing to judge recency by" — caller decides what that means).
 *
 * This is deliberately a real recursive walk, not just a stat on the
 * folder itself — a folder's own mtime does not update when a file deep
 * inside it is modified, only when an entry is added/removed directly
 * within it. Walking the whole tree is the only way to find true "last
 * touched anything inside here" — affordable because this only ever runs
 * from the async sweep, never from the request-handling hot path.
 */
async function mostRecentMtime(dir) {
  let latest = null;

  async function walk(current) {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return; // unreadable — skip, don't crash the whole sweep over one folder
    }

    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else {
        try {
          const s = await stat(full);
          if (!latest || s.mtimeMs > latest) latest = s.mtimeMs;
        } catch {
          // file vanished between readdir and stat — ignore, not fatal
        }
      }
    }
  }

  await walk(dir);
  return latest;
}

/**
 * Lists every integration id that currently has a tests/ directory.
 */
async function listIntegrationIds(cwd) {
  try {
    return await readdir(integrationsRoot(cwd));
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}

/**
 * Lists every archive folder (by full path) under <id>/tests/.
 */
async function listArchiveFolders(cwd, id) {
  const dir = join(integrationsRoot(cwd), id, "tests");
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter(e => e.isDirectory()).map(e => join(dir, e.name));
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}

/**
 * Runs one sweep pass across every integration's tests/ directory.
 *
 * Returns:
 *   { removed: string[], remaining: number, nothingLeftToSweep: boolean }
 *
 * `nothingLeftToSweep` is true only when, after this pass, every
 * integration's tests/ directory is empty — the signal the lazy-start/
 * self-terminating daemon (Stage 4, daemon wrapper) uses to decide whether
 * to exit.
 */
export async function sweepOnce(cwd = process.cwd(), { now = Date.now(), thresholdMs = SWEEP_THRESHOLD_MS } = {}) {
  const ids = await listIntegrationIds(cwd);
  const removed = [];
  let remaining = 0;

  for (const id of ids) {
    const folders = await listArchiveFolders(cwd, id);

    for (const folder of folders) {
      const latest = await mostRecentMtime(folder);

      // A folder with no files at all (latest === null) is judged stale —
      // there is nothing in it worth keeping, and a folder this empty is
      // most plausibly the leftover of a failed/interrupted archive.
      const age = latest === null ? Infinity : (now - latest);

      if (age >= thresholdMs) {
        try {
          await rm(folder, { recursive: true, force: true });
          removed.push(folder);
        } catch {
          // Best-effort: leave it for the next pass rather than crashing
          // the whole sweep over one folder that wouldn't delete.
          remaining++;
        }
      } else {
        remaining++;
      }
    }
  }

  return { removed, remaining, nothingLeftToSweep: remaining === 0 };
}
