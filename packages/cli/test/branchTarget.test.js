// Copyright (c) 2026 Claudius Tiberiu Iacob — Licensed under BSL 1.1. See LICENSE for details.
/**
 * packages/cli/test/branchTarget.test.js
 *
 * resolveBranchTarget reads integra's fixed home (/opt/integra in
 * production — see @int3gra/manager's home.js) instead of walking upward
 * from cwd looking for registry.d/. The home is a literal constant with
 * no override mechanism by design, so these tests mock
 * @int3gra/manager/home's resolveIntegraHome/assertIntegraHomeExists to
 * point at a per-test tmpdir, rather than touching the real /opt/integra.
 * Everything else here (git push into a real repo, archive resolution,
 * banner construction) is real and unmocked — that's the actual subject
 * of this file.
 */

import { jest } from "@jest/globals";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "fs/promises";
import { tmpdir }   from "os";
import { join }     from "path";
import { execSync } from "child_process";

let mockHome;

jest.unstable_mockModule("@int3gra/manager/home", () => ({
  resolveIntegraHome:     () => mockHome,
  assertIntegraHomeExists: () => {}, // mockHome always exists in these tests — nothing to assert
}));

const { resolveBranchTarget } = await import("../src/branchTarget.js");

describe("resolveBranchTarget", () => {
  let home, liveDir, devCwd, xdgRoot;
  let priorSweepDisableFlag;

  function sh(cmd, dir) {
    return execSync(cmd, { cwd: dir, encoding: "utf-8" }).trim();
  }

  beforeAll(() => {
    // Every test in this file exercises resolveArchive's real cache-miss
    // path. Disable the sweep-daemon lazy-start for the whole suite — same
    // reasoning as archive.test.js's direct injection, just via the env-var
    // seam since resolveBranchTarget reaches @int3gra/manager internally.
    priorSweepDisableFlag = process.env.INTEGRA_TEST_NO_SWEEP_DAEMON;
    process.env.INTEGRA_TEST_NO_SWEEP_DAEMON = "1";
  });

  afterAll(() => {
    if (priorSweepDisableFlag === undefined) delete process.env.INTEGRA_TEST_NO_SWEEP_DAEMON;
    else process.env.INTEGRA_TEST_NO_SWEEP_DAEMON = priorSweepDisableFlag;
  });

  beforeEach(async () => {
    // mockHome stands in for integra's fixed home for this test only —
    // resolveIntegraHome/assertIntegraHomeExists are mocked above to use it.
    xdgRoot  = await mkdtemp(join(tmpdir(), "integra-home-mock-"));
    mockHome = xdgRoot;
    home     = mockHome;

    liveDir   = join(home, ".integrations", "my-int", "live");

    // devCwd simulates "wherever the command happens to be invoked from" —
    // deliberately NOT inside home, to prove --branch no longer cares.
    devCwd = await mkdtemp(join(tmpdir(), "integra-devcwd-"));

    // liveDir IS the repository — no separate bare remote. Developer
    // clones are created directly from it and push branches back into it.
    sh(`mkdir -p ${liveDir}`, home);
    sh("git init -q", liveDir);
    sh("git config user.email test@test.com", liveDir);
    sh("git config user.name test", liveDir);
    await writeFile(join(liveDir, "integra.json"), JSON.stringify({ id: "my-int", entry: "live-version" }));
    sh("git add -A", liveDir);
    sh('git commit -q -m "init"', liveDir);
    sh("git branch -M master", liveDir);

    await mkdir(join(home, "registry.d"), { recursive: true });
    await writeFile(
      join(home, "registry.d", "my-int.registry.json"),
      JSON.stringify({ id: "my-int", path: "./.integrations/my-int/live", enabled: true })
    );

    // The cwd the command is invoked from needs integra.json present too —
    // resolveBranchTarget reads cwd's own integra.json to learn the id.
    // We copy live/'s manifest in: in real use, this directory IS live/
    // (the developer cd's there), but the point of this suite is to also
    // prove the home lookup no longer depends on cwd's *location* — only
    // on cwd containing a valid integra.json.
    await writeFile(join(devCwd, "integra.json"), JSON.stringify({ id: "my-int", entry: "live-version" }));
  });

  afterEach(async () => {
    // xdgRoot contains home/.integrations/.../live AND any dev clones —
    // removing it covers both, even if a test failed before its own
    // per-call cleanup ran.
    await rm(xdgRoot, { recursive: true, force: true });
    await rm(devCwd, { recursive: true, force: true });
  });

  async function pushBranch(branchName, entryValue) {
    const devClone = join(xdgRoot, `dev-clone-${branchName}`);
    sh(`git clone -q ${liveDir} ${devClone}`, xdgRoot);
    sh("git config user.email test@test.com", devClone);
    sh("git config user.name test", devClone);
    sh(`git checkout -q -b ${branchName}`, devClone);
    await writeFile(join(devClone, "integra.json"), JSON.stringify({ id: "my-int", entry: entryValue }));
    sh("git add -A", devClone);
    sh(`git commit -q -m "on ${branchName}"`, devClone);
    sh(`git push -q origin ${branchName}`, devClone);
    await rm(devClone, { recursive: true, force: true });
  }

  // ── No --branch: complete no-op ───────────────────────────────────────────

  test("with no --branch, returns cwd unchanged and an empty banner", async () => {
    const result = await resolveBranchTarget({}, devCwd);
    expect(result.targetDir).toBe(devCwd);
    expect(result.banner).toEqual([]);
    expect(result.envFile).toBeNull();
  });

  test("with no --branch, ignores --env entirely (left to the caller)", async () => {
    const result = await resolveBranchTarget({ env: ".env.dev" }, devCwd);
    expect(result.envFile).toBeNull();
  });

  // ── --branch requires --env (except when envRequired: false) ─────────────

  test("--branch without --env throws by default", async () => {
    await expect(resolveBranchTarget({ branch: "x" }, devCwd)).rejects.toThrow(/requires --env/i);
  });

  test("--branch without --env does NOT throw when envRequired: false", async () => {
    await pushBranch("feature-noenv", "patched");
    const result = await resolveBranchTarget({ branch: "feature-noenv" }, devCwd, { envRequired: false });
    expect(result.envFile).toBeNull();
    expect(result.targetDir).not.toBe(devCwd);
  });

  // ── cwd no longer needs to be inside (or beneath) home at all ────────────

  test("works from an arbitrary cwd unrelated to integra's home — no upward search, no cd required", async () => {
    await pushBranch("feature-anywhere", "patched-anywhere");
    await writeFile(join(devCwd, ".env"), "");

    // devCwd is a plain temp dir with no relation to home's location at all.
    const result = await resolveBranchTarget({ branch: "feature-anywhere", env: ".env" }, devCwd);

    expect(result.targetDir).not.toBe(devCwd);
    const manifest = JSON.parse(await readFile(join(result.targetDir, "integra.json"), "utf-8"));
    expect(manifest.entry).toBe("patched-anywhere");
  });

  // ── Successful resolution ──────────────────────────────────────────────────

  test("with --branch and --env, returns the archived directory, not live/", async () => {
    await pushBranch("feature-a", "patched-a");
    await writeFile(join(devCwd, ".env"), "");

    const result = await resolveBranchTarget({ branch: "feature-a", env: ".env" }, devCwd);

    expect(result.targetDir).not.toBe(devCwd);
    expect(result.targetDir).not.toBe(liveDir);
    const manifest = JSON.parse(await readFile(join(result.targetDir, "integra.json"), "utf-8"));
    expect(manifest.entry).toBe("patched-a");
  });

  test("archived directory lives under home's .integrations/<id>/tests/", async () => {
    await pushBranch("feature-loc", "patched-loc");
    await writeFile(join(devCwd, ".env"), "");

    const result = await resolveBranchTarget({ branch: "feature-loc", env: ".env" }, devCwd);
    expect(result.targetDir).toContain(join(home, ".integrations", "my-int", "tests"));
  });

  test("banner mentions the branch name and that it is not live", async () => {
    await pushBranch("feature-b", "patched-b");
    await writeFile(join(devCwd, ".env"), "");

    const result = await resolveBranchTarget({ branch: "feature-b", env: ".env" }, devCwd);
    expect(result.banner.join(" ")).toMatch(/feature-b/);
    expect(result.banner.join(" ")).toMatch(/not the live code/i);
  });

  test("banner mentions the env file used", async () => {
    await pushBranch("feature-c", "patched-c");
    await writeFile(join(devCwd, ".env.dev"), "");

    const result = await resolveBranchTarget({ branch: "feature-c", env: ".env.dev" }, devCwd);
    expect(result.banner.join(" ")).toContain(".env.dev");
  });

  test("throws when the given --env file doesn't exist", async () => {
    await pushBranch("feature-d", "patched-d");
    await expect(resolveBranchTarget({ branch: "feature-d", env: ".env.missing" }, devCwd))
      .rejects.toThrow(/env file not found/i);
  });

  test("throws when integra.json in cwd has no id", async () => {
    const badCwd = await mkdtemp(join(tmpdir(), "integra-no-id-"));
    try {
      await writeFile(join(badCwd, "integra.json"), JSON.stringify({ entry: "x" })); // no id
      await writeFile(join(badCwd, ".env"), "");

      await expect(resolveBranchTarget({ branch: "x", env: ".env" }, badCwd))
        .rejects.toThrow(/could not determine.*id/i);
    } finally {
      await rm(badCwd, { recursive: true, force: true });
    }
  });
});
