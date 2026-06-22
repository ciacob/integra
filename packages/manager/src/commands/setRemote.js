// Copyright (c) 2026 Claudius Tiberiu Iacob — Licensed under BSL 1.1. See LICENSE for details.
/**
 * @int3gra/manager - commands/setRemote.js
 *
 * `integra-manager set-remote <id> <url>`
 *
 * Configures (or updates) the `origin` remote on an integration's live/
 * repository. This is the one sanctioned way to touch live/'s git config
 * directly — the guide delivered by `integra init` tells developers never
 * to edit files inside live/, and this command exists so an operator never
 * has to either; they go through integra-manager exactly as they do for
 * every other live/-adjacent operation (deploy, undeploy).
 *
 * Required once per integration, before `deploy`/`undeploy`/any `--branch`
 * command can fetch anything — live/ as scaffolded by `init` has no remote
 * at all, by design (init has no opinion on where the team's actual git
 * hosting lives).
 */

import { execSync } from "child_process";
import { resolve }  from "path";

import { readEntry } from "../registryStorage.js";

function liveDirFor(cwd, entry) {
  return resolve(cwd, entry.path);
}

/**
 * Returns the currently configured origin URL, or null if none is set.
 */
function currentOrigin(liveDir) {
  try {
    return execSync("git remote get-url origin", { cwd: liveDir, encoding: "utf-8" }).trim();
  } catch {
    return null;
  }
}

export async function setRemote(id, url, { cwd = process.cwd() } = {}) {
  if (!id || !url) throw new Error("Usage: integra-manager set-remote <id> <url>");

  const entry = await readEntry(cwd, id);
  if (!entry) {
    throw new Error(`"${id}" is not registered in registry.d/.`);
  }

  const liveDir = liveDirFor(cwd, entry);
  const existing = currentOrigin(liveDir);

  if (existing) {
    execSync(`git remote set-url origin ${url}`, { cwd: liveDir, stdio: "ignore" });
  } else {
    execSync(`git remote add origin ${url}`, { cwd: liveDir, stdio: "ignore" });
  }

  return { id, liveDir, url, replaced: existing !== null, previousUrl: existing };
}
