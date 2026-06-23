// Copyright (c) 2026 Claudius Tiberiu Iacob — Licensed under BSL 1.1. See LICENSE for details.
/**
 * @int3gra/cli - branchTarget.js
 *
 * Shared resolution for run/validate/ping/test. --branch and --id are
 * both mandatory — there is no "operate on whatever directory you
 * happen to be standing in" mode anymore. What gets verified must always
 * be a named, traceable commit, never an anonymous pile of whatever's on
 * disk (including, critically, live/ itself — these commands cannot
 * point at live/ directly; deploy is the only path onto it). This also
 * means none of these commands have any remaining use for cwd: not to
 * find the integration's id (that's --id now), and not to resolve --env
 * (that's the resolved branch's own root now, see below).
 *
 * integra only ever runs on the server — there is no developer-machine
 * install to speak of. A developer pushes a branch, then SSHes into the
 * same server integra already lives on and runs, e.g.,
 * `integra test --id my-sn-jira --branch my-patch`, to verify their own
 * pushed work before asking an operator (or themselves) to
 * `integra-manager deploy` it. This is the normal, expected, day-to-day
 * use of these commands — not an edge case.
 *
 * The integration's registry entry and .integrations/ tree live at a
 * single, fixed location — integra's "home" (see @int3gra/manager's
 * home.js), a literal constant (/opt/integra), never relocated. It must
 * already exist on this host — `integra setup` (run by hand, as root) is
 * the one and only thing that creates it.
 *
 * This module:
 *
 *   1. Requires --id and --branch — refuses immediately, before doing
 *      anything else, if either is missing.
 *   2. Resolves integra's fixed home and delegates to @int3gra/manager's
 *      resolveArchive() to get an ephemeral, content-addressed copy of
 *      that branch for that id.
 *   3. Resolves --env (if given) against that archive's own root — never
 *      against cwd. --env must be a plain relative filename: no leading
 *      "/", no ".." segment. The env file, like everything else being
 *      verified, must already be committed on the branch — there is no
 *      other way it could exist inside the archive at all (see the
 *      "Env files: committed, not personal" section of the root README).
 *   4. Returns the directory the calling command should actually operate
 *      against, plus the banner text it should print before doing
 *      anything else.
 */

import { existsSync } from "fs";
import { resolve, isAbsolute, sep } from "path";

/**
 * @param {object} flags          parsed CLI flags (from parseArgs) — must include id and branch
 * @param {object} [options]
 * @param {boolean} [options.envRequired]  whether --env must accompany --branch (default true)
 * @returns {Promise<{ targetDir: string, banner: string[], envFile: string|null }>}
 */
export async function resolveBranchTarget(flags, { envRequired = true } = {}) {
  if (!flags.id) {
    throw new Error(
      `Usage requires --id <integration-id>.\n` +
      `There is no implicit "current integration" anymore — every run must ` +
      `name the integration explicitly.`
    );
  }

  if (!flags.branch) {
    throw new Error(
      `Usage requires --branch <name>.\n` +
      `These commands can no longer operate on live/ directly, or on an ` +
      `arbitrary local checkout — only on a branch already pushed into ` +
      `live/. Push your work, then pass --branch <name>.`
    );
  }

  if (envRequired && !flags.env) {
    throw new Error(
      `--branch requires --env.\n` +
      `This exists so a patch branch can never accidentally run against ` +
      `production credentials via a forgotten default .env. Pass an explicit ` +
      `--env file (e.g. --env .env.dev).`
    );
  }

  const { resolveIntegraHome, assertIntegraHomeExists } = await import("@int3gra/manager/home");
  assertIntegraHomeExists();
  const home = resolveIntegraHome();

  const doResolveArchive = await resolveArchiveImpl();
  const { sha, path: archivePath } = await doResolveArchive(flags.id, flags.branch, home);

  const banner = [
    `Using branch "${flags.branch}" (${sha.slice(0, 12)}) for "${flags.id}".`,
  ];

  let envFile = null;
  if (flags.env) {
    if (isAbsolute(flags.env) || flags.env.split(sep).includes("..")) {
      throw new Error(
        `--env must be a plain relative filename (e.g. ".env.dev") — no ` +
        `leading "/" and no ".." segment. Got: ${flags.env}`
      );
    }
    envFile = resolve(archivePath, flags.env);
    if (!existsSync(envFile)) {
      throw new Error(
        `Env file not found: ${flags.env} (looked in the "${flags.branch}" ` +
        `branch's own root). It must be committed there, like any other file.`
      );
    }
    banner.push(`Using env: ${flags.env}`);
  }

  return { targetDir: archivePath, banner, envFile };
}

/**
 * Returns the resolveArchive function to use. When INTEGRA_TEST_NO_SWEEP_DAEMON
 * is set, wraps the real resolveArchive with a no-op sweep-launcher override —
 * this is the CLI-layer equivalent of the same injection archive.test.js uses
 * directly. It exists as an env var (rather than a parameter threaded through
 * every command's public signature) because run()/validate()/ping()/test()
 * all take a single argv array as their public contract; adding a test-only
 * second parameter to four public command signatures just for this would be
 * worse than a narrowly-scoped env var, consistent with how INTEGRA_USER and
 * INTEGRA_STAGING_DIR already serve as test seams elsewhere in this codebase.
 *
 * Without this var set, behaves identically to calling resolveArchive directly.
 */
async function resolveArchiveImpl() {
  const { resolveArchive } = await import("@int3gra/manager/archive");

  if (!process.env.INTEGRA_TEST_NO_SWEEP_DAEMON) {
    return resolveArchive;
  }

  return (id, branch, cwd) =>
    resolveArchive(id, branch, cwd, { ensureSweepRunning: async () => {} });
}
