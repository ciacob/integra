// Copyright (c) 2026 Claudius Tiberiu Iacob — Licensed under BSL 1.1. See LICENSE for details.
/**
 * @int3gra/manager - commands/deploy.js
 *
 * `integra-manager deploy <id> --branch <name>`
 *
 * Fast-forward-merges a branch already pushed into live/ — live/ has no
 * remote and the branch already exists in its own object store the
 * instant a developer's clone pushes it there, so this is a plain local
 * merge, no fetch involved — tags the result, and restarts the
 * integration via the existing, unmodified restartOne() — the graceful
 * per-lifecycle restart described in the architecture proposal is
 * deliberately deferred to a later pass; this stage proves the git/tag
 * plumbing against a simple, already-correct restart path first.
 *
 * Fast-forward only: if live/ has diverged from the named branch (someone
 * committed directly to live/, or a previous deploy was rolled back and
 * a new one supersedes it incorrectly), the merge is refused outright.
 * live/ is provably untouched in that case — git's own --ff-only guarantees
 * this; verified directly against a real repo (not assumed) before writing
 * this module: a failed --ff-only merge leaves HEAD exactly where it was.
 *
 * Each successful deploy is recorded as an annotated tag (deploy-<n>)
 * whose *tag message* — not the underlying commit's message, which belongs
 * to the developer, not to the deploy — records which branch, by whom, and
 * when. This is what makes deploy-history and undeploy well-defined,
 * rather than relying on commit messages or HEAD~1, which only mean
 * "the deploy" if every commit happens to be exactly one deploy.
 */

import { execSync } from "child_process";
import { resolve }  from "path";

import { readEntry }   from "../registryStorage.js";
import { restartOne }  from "../manager.js";
import { currentUser } from "../identity.js";

const TAG_PREFIX = "deploy-";

function liveDirFor(cwd, entry) {
  return resolve(cwd, entry.path);
}

function sh(cmd, dir) {
  return execSync(cmd, { cwd: dir, encoding: "utf-8" });
}

/**
 * Returns the next deploy tag name, robust to non-contiguous existing tags
 * (e.g. one was manually deleted) — always (highest existing number) + 1,
 * never just (count of existing tags) + 1, which would collide if a tag in
 * the middle of the sequence was ever removed.
 */
function nextTagName(liveDir) {
  let highest = 0;
  try {
    const raw = sh(`git tag -l "${TAG_PREFIX}*"`, liveDir);
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith(TAG_PREFIX)) continue;
      const n = parseInt(trimmed.slice(TAG_PREFIX.length), 10);
      if (!Number.isNaN(n) && n > highest) highest = n;
    }
  } catch {
    // No tags at all yet — highest stays 0
  }
  return `${TAG_PREFIX}${highest + 1}`;
}

export async function deploy(id, branch, { cwd = process.cwd() } = {}) {
  if (!id || !branch) throw new Error("Usage: integra-manager deploy <id> --branch <name>");

  const entry = await readEntry(cwd, id);
  if (!entry) throw new Error(`"${id}" is not registered in registry.d/.`);

  const liveDir = liveDirFor(cwd, entry);

  const headBefore = sh("git rev-parse HEAD", liveDir).trim();

  try {
    sh(`git merge --ff-only ${branch}`, liveDir);
  } catch (err) {
    // --ff-only's own failure is the clearest signal available — surface it
    // verbatim, plus the explicit reassurance that nothing changed.
    throw new Error(
      `Deploy refused: "${branch}" does not fast-forward from live/'s current state.\n` +
      `live/ was NOT modified — it remains at ${headBefore.slice(0, 12)}.\n\n` +
      `${err.stderr || err.message}\n\n` +
      `Resolve this in your own clone (rebase your branch onto live's current ` +
      `state, or investigate what's diverged), push, and try again.`
    );
  }

  const headAfter = sh("git rev-parse HEAD", liveDir).trim();
  const tagName   = nextTagName(liveDir);
  const deployer  = currentUser();
  const timestamp = new Date().toISOString();

  sh(
    `git tag -a ${tagName} -m "deployed branch=${branch} by=${deployer} at=${timestamp}"`,
    liveDir
  );

  await restartOne(id, cwd);

  return {
    id,
    branch,
    tag: tagName,
    headBefore,
    headAfter,
    deployer,
  };
}
