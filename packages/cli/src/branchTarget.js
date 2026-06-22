// Copyright (c) 2026 Claudius Tiberiu Iacob — Licensed under BSL 1.1. See LICENSE for details.
/**
 * @int3gra/cli - branchTarget.js
 *
 * Shared resolution for the `--branch` flag across run/validate/ping/test.
 * Without --branch, every command operates on process.cwd() exactly as
 * before — this module is a no-op in that case.
 *
 * integra only ever runs on the server — there is no developer-machine
 * install to speak of. A developer pushes a branch, then SSHes into the
 * same server integra already lives on and runs, e.g.,
 * `integra test --branch my-patch`, to verify their own pushed work before
 * asking an operator (or themselves) to `integra-manager deploy` it. This
 * is the normal, expected, day-to-day use of --branch — not an edge case
 * and not something done on behalf of someone else's work.
 *
 * The integration's registry entry and .integrations/ tree live at a
 * single, fixed location — integra's "home" (see @int3gra/manager's
 * home.js), resolved via env-paths and decided once at install time, never
 * relocated. --branch reads that home directly; it no longer searches for
 * it by walking upward from cwd. This means the command can be run from
 * any directory at all — there is no requirement to `cd` anywhere first.
 *
 * With --branch, this module:
 *
 *   1. Enforces that --env is also present (except when explicitly told
 *      this command never uses real credentials, i.e. `test`) — refusing
 *      before doing anything else, so a patch branch can never run
 *      against production credentials via a forgotten default .env.
 *   2. Reads the current directory's integra.json to learn the
 *      integration's own id (the same file every command already reads
 *      first).
 *   3. Resolves integra's fixed home and delegates to @int3gra/manager's
 *      resolveArchive() to get an ephemeral, content-addressed copy of
 *      that branch.
 *   4. Returns the directory the calling command should actually operate
 *      against, plus the banner text it should print before doing
 *      anything else.
 */

import { existsSync } from "fs";
import { resolve }    from "path";

/**
 * @param {object} flags          parsed CLI flags (from parseArgs)
 * @param {string} cwd            the directory the command was invoked from
 * @param {object} [options]
 * @param {boolean} [options.envRequired]  whether --env must accompany --branch (default true)
 * @returns {Promise<{ targetDir: string, banner: string[], envFile: string|null }>}
 */
export async function resolveBranchTarget(flags, cwd, { envRequired = true } = {}) {
  if (!flags.branch) {
    // No --branch: operate on cwd exactly as before. envFile resolution is
    // left to the caller, which already has its own default-.env logic.
    return { targetDir: cwd, banner: [], envFile: null };
  }

  if (envRequired && !flags.env) {
    throw new Error(
      `--branch requires --env.\n` +
      `This exists so a patch branch can never accidentally run against ` +
      `production credentials via a forgotten default .env. Pass an explicit ` +
      `--env file (e.g. --env .env.dev).`
    );
  }

  const { readManifest } = await import("@int3gra/engine");
  const manifest = await readManifest(cwd);

  if (!manifest.id) {
    throw new Error(
      `Could not determine this integration's id from integra.json in ${cwd}.\n` +
      `--branch requires a valid integra.json with an "id" field.`
    );
  }

  const { resolveIntegraHome, readHomeConfig } = await import("@int3gra/manager/home");
  const home   = resolveIntegraHome();
  const config = await readHomeConfig(home);

  if (config === null) {
    throw new Error(
      `integra's home (${home}) hasn't been initialised on this host.\n` +
      `This is normally set up automatically when @int3gra/manager is installed. ` +
      `If it's missing, reinstall @int3gra/manager or run its postinstall script directly.`
    );
  }

  const doResolveArchive = await resolveArchiveImpl();
  const { sha, path: archivePath } = await doResolveArchive(manifest.id, flags.branch, home);

  const banner = [
    `Using branch "${flags.branch}" (${sha.slice(0, 12)}) — NOT the live code.`,
  ];

  let envFile = null;
  if (flags.env) {
    envFile = resolve(cwd, flags.env);
    if (!existsSync(envFile)) {
      throw new Error(`Env file not found: ${envFile}`);
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
