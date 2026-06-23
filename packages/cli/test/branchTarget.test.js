// Copyright (c) 2026 Claudius Tiberiu Iacob — Licensed under BSL 1.1. See LICENSE for details.
/**
 * packages/cli/test/branchTarget.test.js
 *
 * resolveBranchTarget requires --id and --branch — there is no longer a
 * "no --branch, operate on cwd" mode, and no cwd parameter at all; the
 * function takes only flags. Reads integra's fixed home (/opt/integra in
 * production — see @int3gra/manager's home.js). The home is a literal
 * constant with no override mechanism by design, so these tests mock
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
  let home, liveDir, xdgRoot;
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
  });

  afterEach(async () => {
    await rm(xdgRoot, { recursive: true, force: true });
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

  // ── --id and --branch are both mandatory — no fallback mode ───────────────

  test("throws when --id is missing", async () => {
    await expect(resolveBranchTarget({ branch: "x" })).rejects.toThrow(/--id/i);
  });

  test("throws when --branch is missing", async () => {
    await expect(resolveBranchTarget({ id: "my-int" })).rejects.toThrow(/--branch/i);
  });

  // ── --branch requires --env (except when envRequired: false) ─────────────

  test("--branch without --env throws by default", async () => {
    await expect(resolveBranchTarget({ id: "my-int", branch: "x" })).rejects.toThrow(/requires --env/i);
  });

  test("--branch without --env does NOT throw when envRequired: false", async () => {
    await pushBranch("feature-noenv", "patched");
    const result = await resolveBranchTarget({ id: "my-int", branch: "feature-noenv" }, { envRequired: false });
    expect(result.envFile).toBeNull();
    expect(result.targetDir).toBeTruthy();
  });

  // ── Genuinely location-independent — no cwd involved at all anymore ──────

  test("resolves correctly with no relationship whatsoever to any particular directory", async () => {
    // There is no cwd parameter at all anymore — flags alone (id, branch,
    // env) are enough. This is a stronger property than the old "doesn't
    // search upward from cwd" guarantee: there is no cwd input to this
    // function in the first place.
    await pushBranch("feature-anywhere", "patched-anywhere");
    await writeFile(join(home, ".integrations", "my-int", "live", ".env"), ""); // irrelevant — env comes from the archive, not live/

    const archiveEnvPath = join(home, ".integrations", "my-int", "tests");
    const result = await resolveBranchTarget({ id: "my-int", branch: "feature-anywhere" }, { envRequired: false });

    expect(result.targetDir).not.toBe(liveDir);
    const manifest = JSON.parse(await readFile(join(result.targetDir, "integra.json"), "utf-8"));
    expect(manifest.entry).toBe("patched-anywhere");
  });

  // ── Successful resolution ──────────────────────────────────────────────────

  test("with --id and --branch, returns the archived directory, not live/", async () => {
    await pushBranch("feature-a", "patched-a");

    const result = await resolveBranchTarget({ id: "my-int", branch: "feature-a" }, { envRequired: false });

    expect(result.targetDir).not.toBe(liveDir);
    const manifest = JSON.parse(await readFile(join(result.targetDir, "integra.json"), "utf-8"));
    expect(manifest.entry).toBe("patched-a");
  });

  test("archived directory lives under home's .integrations/<id>/tests/", async () => {
    await pushBranch("feature-loc", "patched-loc");

    const result = await resolveBranchTarget({ id: "my-int", branch: "feature-loc" }, { envRequired: false });
    expect(result.targetDir).toContain(join(home, ".integrations", "my-int", "tests"));
  });

  test("banner mentions the branch name and the integration id", async () => {
    await pushBranch("feature-b", "patched-b");

    const result = await resolveBranchTarget({ id: "my-int", branch: "feature-b" }, { envRequired: false });
    expect(result.banner.join(" ")).toMatch(/feature-b/);
    expect(result.banner.join(" ")).toMatch(/my-int/);
  });

  // ── --env: relative-only, resolved against the archive's own root ─────────
  // .env must be committed on the branch itself — there is no other
  // mechanism that gets it into the archive at all (git archive exports
  // straight from the commit tree).

  test("--env is resolved against the archive's own root, not any cwd", async () => {
    const devClone = join(xdgRoot, "dev-clone-feature-env");
    sh(`git clone -q ${liveDir} ${devClone}`, xdgRoot);
    sh("git config user.email test@test.com", devClone);
    sh("git config user.name test", devClone);
    sh("git checkout -q -b feature-env", devClone);
    await writeFile(join(devClone, "integra.json"), JSON.stringify({ id: "my-int", entry: "patched-env" }));
    await writeFile(join(devClone, ".env.dev"), "SN_USER=realuser\n"); // committed, like any other file
    sh("git add -A", devClone);
    sh('git commit -q -m "on feature-env"', devClone);
    sh("git push -q origin feature-env", devClone);
    await rm(devClone, { recursive: true, force: true });

    const result = await resolveBranchTarget({ id: "my-int", branch: "feature-env", env: ".env.dev" });
    expect(result.envFile).toBe(join(result.targetDir, ".env.dev"));
    const content = await readFile(result.envFile, "utf-8");
    expect(content).toContain("SN_USER=realuser");
  });

  test("banner mentions the env file used", async () => {
    await pushBranch("feature-c", "patched-c");
    // .env must exist in the archive — push it committed, same as any file.
    const devClone = join(xdgRoot, "dev-clone-feature-c2");
    sh(`git clone -q ${liveDir} ${devClone}`, xdgRoot);
    sh("git config user.email test@test.com", devClone);
    sh("git config user.name test", devClone);
    sh("git fetch -q origin feature-c", devClone);
    sh("git checkout -q feature-c", devClone);
    await writeFile(join(devClone, ".env.dev"), "");
    sh("git add -A", devClone);
    sh('git commit -q -m "add env"', devClone);
    sh("git push -q origin feature-c", devClone);
    await rm(devClone, { recursive: true, force: true });

    const result = await resolveBranchTarget({ id: "my-int", branch: "feature-c", env: ".env.dev" });
    expect(result.banner.join(" ")).toContain(".env.dev");
  });

  test("throws when the given --env file doesn't exist in the archive", async () => {
    await pushBranch("feature-d", "patched-d");
    await expect(resolveBranchTarget({ id: "my-int", branch: "feature-d", env: ".env.missing" }))
      .rejects.toThrow(/env file not found/i);
  });

  test("rejects --env with a leading slash", async () => {
    await pushBranch("feature-abs", "patched-abs");
    await expect(resolveBranchTarget({ id: "my-int", branch: "feature-abs", env: "/etc/passwd" }))
      .rejects.toThrow(/relative filename/i);
  });

  test("rejects --env containing a '..' segment", async () => {
    await pushBranch("feature-traverse", "patched-traverse");
    await expect(resolveBranchTarget({ id: "my-int", branch: "feature-traverse", env: "../../../etc/passwd" }))
      .rejects.toThrow(/relative filename/i);
  });
});
