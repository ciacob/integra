// Copyright (c) 2026 Claudius Tiberiu Iacob — Licensed under BSL 1.1. See LICENSE for details.
/**
 * @int3gra/manager - archive.js
 *
 * Shared ephemeral-archive helper, used by `run`/`validate`/`ping`/`test
 * --branch` (CLI) and reusable by `deploy`'s own git plumbing if it ever
 * needs to inspect a branch before merging it.
 *
 * live/ has no remote of its own and never fetches from anywhere — it IS
 * the repository. A branch a developer pushes (from their own clone, into
 * live/ directly) exists in live/'s own object store the instant the push
 * completes, as an ordinary local branch. This module reads that branch
 * directly; there is no fetch step anywhere in it.
 *
 * Correctness vs. eviction are deliberately independent questions:
 *   - Correctness: is this folder's content the right content for this
 *     branch right now? Answered by content-addressing the folder under
 *     the branch's current commit SHA — a cheap `git rev-parse`, no
 *     diffing, no marker file. If a folder for that exact SHA already
 *     exists, it is definitionally correct and reused untouched.
 *   - Eviction: is this folder still needed? Answered separately, by
 *     sweep.js — out of scope for this module entirely.
 *
 * No `.git` directory ever exists in an archived folder — `git archive`
 * produces a tar stream with zero git metadata, fully disconnected from
 * the source repo's object store the moment extraction finishes. This is
 * the deliberate isolation boundary: nothing in an archived folder can
 * reach back into live/'s repository.
 *
 * Concurrency: two near-simultaneous requests for the same just-moved
 * branch could both decide to archive on a cache miss. Guarded the same
 * way registry.d/'s publishEntry() guards against partial writes:
 * archive to a temp-named directory, then atomically rename into the
 * final SHA-named path. If the rename target already exists by the time
 * we get there (the other request won the race), discard our redundant
 * copy and use theirs — they are byte-for-byte identical, since both are
 * built from the same SHA.
 */

import { execSync } from "child_process";
import { mkdir, rm, rename, readdir } from "fs/promises";
import { existsSync } from "fs";
import { resolve, join } from "path";

import { readEntry } from "./registryStorage.js";
import { ensureSweepDaemonRunning } from "./sweepLauncher.js";

function testsDir(cwd, id) {
  return resolve(cwd, ".integrations", id, "tests");
}

function liveDirFor(cwd, entry) {
  return resolve(cwd, entry.path);
}

/**
 * Resolves <branch>'s current commit SHA directly from live/'s own object
 * store. live/ has no remote and never fetches — a branch pushed into it
 * by a developer's clone already exists there as an ordinary local branch
 * the instant the push completes, so this is just a rev-parse, no fetch
 * step involved at all. Confirmed directly against a real repo (push from
 * a separate clone, then rev-parse/archive the resulting branch with no
 * fetch in between) before relying on this.
 */
function resolveBranchSha(liveDir, branch) {
  try {
    return execSync(`git rev-parse ${branch}`, { cwd: liveDir, encoding: "utf-8" }).trim();
  } catch {
    throw new Error(
      `Branch "${branch}" was not found in live/.\n` +
      `Did you push it? Branches must be pushed directly into live/'s own ` +
      `repository — there is no separate remote to fetch from.`
    );
  }
}

/**
 * Archives <sha> out of live/'s git history into `targetDir`, with zero
 * git metadata. Uses a temp-named sibling directory and an atomic rename
 * into place, so a concurrent archive of the same SHA can never produce a
 * half-written folder at the final path.
 */
async function archiveShaInto(liveDir, sha, finalDir) {
  const tmpDir = `${finalDir}.tmp_${process.pid}_${Date.now()}`;
  await mkdir(tmpDir, { recursive: true });

  try {
    execSync(`git archive --format=tar ${sha} | (cd ${tmpDir} && tar -xf -)`, {
      cwd: liveDir,
      shell: "/bin/sh",
      stdio: "ignore",
    });
  } catch (err) {
    await rm(tmpDir, { recursive: true, force: true });
    throw new Error(`Failed to archive ${sha}: ${err.message}`);
  }

  try {
    await rename(tmpDir, finalDir);
  } catch (err) {
    // Lost the race to another concurrent archive of the same SHA — the
    // folder at finalDir is, by construction, identical content (same
    // SHA), so discard our redundant copy and defer to theirs.
    if (existsSync(finalDir)) {
      await rm(tmpDir, { recursive: true, force: true });
    } else {
      throw err;
    }
  }
}

/**
 * Resolves an ephemeral, content-addressed archive of `branch` for
 * integration `id`. Reuses an existing archive if the branch hasn't moved
 * since the last call; otherwise archives fresh from live/'s own object
 * store — there is no fetch step, since live/ has no remote and the
 * branch already exists there as soon as a developer pushes it.
 *
 * On a cache miss that creates a brand new archive, lazily ensures the
 * sweep daemon is running under PM2 — see sweepLauncher.js. Injectable via
 * `ensureSweepRunning` so tests can disable this without spinning up a
 * real PM2-managed process on every cache miss; production callers should
 * never need to pass this.
 *
 * Returns { path, sha }.
 */
export async function resolveArchive(id, branch, cwd = process.cwd(), { ensureSweepRunning = ensureSweepDaemonRunning } = {}) {
  if (!id || !branch) throw new Error("resolveArchive requires both an id and a branch");

  const entry = await readEntry(cwd, id);
  if (!entry) throw new Error(`"${id}" is not registered in registry.d/.`);

  const liveDir = liveDirFor(cwd, entry);
  const sha     = resolveBranchSha(liveDir, branch);

  const dir        = testsDir(cwd, id);
  const archivePath = join(dir, sha);

  if (existsSync(archivePath)) {
    return { path: archivePath, sha };
  }

  await mkdir(dir, { recursive: true });
  await archiveShaInto(liveDir, sha, archivePath);

  // Best-effort: if PM2 isn't reachable for some reason, the archive is
  // still perfectly usable — it just won't get auto-swept until something
  // else triggers the daemon (an operator running it manually, or the
  // next successful cache-miss call). Never let this block the archive.
  try {
    await ensureSweepRunning(cwd);
  } catch {
    // intentionally swallowed — see comment above
  }

  return { path: archivePath, sha };
}
