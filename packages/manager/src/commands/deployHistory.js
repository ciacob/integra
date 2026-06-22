// Copyright (c) 2026 Claudius Tiberiu Iacob — Licensed under BSL 1.1. See LICENSE for details.
/**
 * @int3gra/manager - commands/deployHistory.js
 *
 * `integra-manager deploy-history <id> [-n <count>]`
 *
 * Lists the most recent deploy-* tags, newest first, with the metadata
 * recorded in each tag's own annotation message (branch, deployer,
 * timestamp) — see deploy.js for why this lives in the tag's message
 * rather than the underlying commit's message. No separate bookkeeping
 * file; this is entirely derived from tags deploy.js already creates.
 */

import { execSync } from "child_process";
import { resolve }  from "path";

import { readEntry } from "../registryStorage.js";

const TAG_PREFIX = "deploy-";

function liveDirFor(cwd, entry) {
  return resolve(cwd, entry.path);
}

function sh(cmd, dir) {
  return execSync(cmd, { cwd: dir, encoding: "utf-8" });
}

/**
 * Parses a tag's annotation message of the form:
 *   "deployed branch=<name> by=<user> at=<iso-timestamp>"
 * into its parts. Tolerant of older/foreign tags that don't match this
 * shape — returns nulls for fields it can't parse rather than throwing,
 * since deploy-history is a read-only reporting command and a malformed
 * tag shouldn't crash the whole listing.
 */
function parseDeployMessage(message) {
  const branchMatch = message.match(/branch=(\S+)/);
  const byMatch      = message.match(/by=(\S+)/);
  const atMatch       = message.match(/at=(\S+)/);
  return {
    branch: branchMatch ? branchMatch[1] : null,
    by:     byMatch ? byMatch[1] : null,
    at:     atMatch ? atMatch[1] : null,
  };
}

export async function deployHistory(id, { cwd = process.cwd(), n = 10 } = {}) {
  if (!id) throw new Error("Usage: integra-manager deploy-history <id> [-n <count>]");

  const entry = await readEntry(cwd, id);
  if (!entry) throw new Error(`"${id}" is not registered in registry.d/.`);

  const liveDir = liveDirFor(cwd, entry);

  let raw;
  try {
    // No --sort=-creatordate here — see undeploy.js's listDeployTagsNewestFirst
    // for why: tags created in rapid succession can share the same
    // second-resolution timestamp, making creatordate ordering unreliable.
    // Sort by the numeric suffix instead, same as undeploy.js.
    raw = sh(
      `git for-each-ref --format="%(refname:short)|%(*objectname:short)|%(contents:subject)" refs/tags/${TAG_PREFIX}*`,
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
      const [tag, sha, message] = line.split("|");
      const num = parseInt(tag.slice(TAG_PREFIX.length), 10);
      return { tag, sha, n: Number.isNaN(num) ? -1 : num, ...parseDeployMessage(message ?? "") };
    });

  entries.sort((a, b) => b.n - a.n); // newest (highest n) first

  return entries.slice(0, n).map(({ n: _n, ...rest }) => rest);
}
