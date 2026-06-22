// Copyright (c) 2026 Claudius Tiberiu Iacob — Licensed under BSL 1.1. See LICENSE for details.
/**
 * @int3gra/manager - commands/undeploy.js
 *
 * `integra-manager undeploy <id>`
 *
 * Moves live/ back to the deploy tag immediately before the current one,
 * NOT HEAD~1. This distinction matters: HEAD~1 only means "the previous
 * deploy" if every single commit in live/'s history corresponds to exactly
 * one deploy — an assumption that breaks the moment anyone commits
 * directly to live/ for any reason. Tags name deploys explicitly; walking
 * tags is correct regardless of what else has touched the repository.
 *
 * Restarts via the same unmodified restartOne() deploy.js uses — the
 * graceful per-lifecycle restart is deferred to a later pass.
 */

import { execSync } from "child_process";
import { resolve }  from "path";

import { readEntry }  from "../registryStorage.js";
import { restartOne } from "../manager.js";

const TAG_PREFIX = "deploy-";

function liveDirFor(cwd, entry) {
  return resolve(cwd, entry.path);
}

function sh(cmd, dir) {
  return execSync(cmd, { cwd: dir, encoding: "utf-8" });
}

/**
 * Returns deploy-* tags ordered newest-first, each as { name, sha }, where
 * sha is the underlying COMMIT's SHA (see comment below on annotated tags).
 *
 * Ordering is by the numeric suffix in the tag name (deploy-<n>), NOT by
 * --sort=-creatordate. Confirmed directly against a real repo: tags created
 * in rapid succession (as happens in normal operation, and especially in
 * fast test runs) can land on the exact same second-resolution timestamp,
 * making creatordate ordering unreliable — git for-each-ref's tiebreak in
 * that case is not guaranteed to match creation order. The numeric suffix
 * is unambiguous by construction (nextTagName always increments from the
 * highest existing number) and has no such resolution problem.
 */
function listDeployTagsNewestFirst(liveDir) {
  let raw;
  try {
    // %(*objectname) is the dereferenced (peeled) commit SHA for an
    // annotated tag — an annotated tag is itself a distinct git object
    // with its own SHA, separate from the commit it points at. Comparing
    // against `git rev-parse HEAD` (always a commit SHA) requires this
    // peeled form, not the tag object's own %(objectname).
    raw = sh(
      `git for-each-ref --format="%(refname:short) %(*objectname)" refs/tags/${TAG_PREFIX}*`,
      liveDir
    );
  } catch {
    return [];
  }

  const entries = raw
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const [name, sha] = line.split(" ");
      const n = parseInt(name.slice(TAG_PREFIX.length), 10);
      return { name, sha, n: Number.isNaN(n) ? -1 : n };
    });

  entries.sort((a, b) => b.n - a.n); // newest (highest n) first
  return entries.map(({ name, sha }) => ({ name, sha }));
}

export async function undeploy(id, { cwd = process.cwd() } = {}) {
  if (!id) throw new Error("Usage: integra-manager undeploy <id>");

  const entry = await readEntry(cwd, id);
  if (!entry) throw new Error(`"${id}" is not registered in registry.d/.`);

  const liveDir = liveDirFor(cwd, entry);
  const tags    = listDeployTagsNewestFirst(liveDir);

  if (tags.length === 0) {
    throw new Error(`"${id}" has no recorded deploys — nothing to undeploy.`);
  }
  if (tags.length === 1) {
    throw new Error(
      `"${id}" has only one recorded deploy (${tags[0].name}) — there is no ` +
      `previous deploy to roll back to.`
    );
  }

  const headBefore     = sh("git rev-parse HEAD", liveDir).trim();
  const currentTag     = tags.find(t => t.sha === headBefore);
  // If HEAD doesn't match any known deploy tag exactly (someone committed
  // directly to live/ after the last deploy), the "previous" deploy is
  // still well-defined as the most recent tag — that is the last point we
  // know for certain was a deliberate deploy.
  const targetIndex = currentTag
    ? tags.findIndex(t => t.name === currentTag.name) + 1
    : 0;

  if (targetIndex >= tags.length) {
    throw new Error(
      `"${id}" is already at its oldest recorded deploy (${tags[tags.length - 1].name}) — ` +
      `there is no earlier deploy to roll back to.`
    );
  }

  const target = tags[targetIndex];

  sh(`git reset --hard ${target.sha}`, liveDir);

  await restartOne(id, cwd);

  return {
    id,
    tag: target.name,
    headBefore,
    headAfter: target.sha,
  };
}
