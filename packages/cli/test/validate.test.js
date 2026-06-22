// Copyright (c) 2026 Claudius Tiberiu Iacob — Licensed under BSL 1.1. See LICENSE for details.
/**
 * packages/cli/test/validate.test.js
 *
 * validate() never reads process.env or {{env.X}} placeholders — it only
 * inspects JSON shape and lints process structure. --branch must work on
 * it without --env, unlike run/ping. live/ IS the repository — no
 * separate bare remote; developer clones push branches directly into it.
 */

import { mkdtemp, rm, writeFile, mkdir } from "fs/promises";
import { tmpdir }   from "os";
import { join }     from "path";
import { execSync } from "child_process";

import { validate } from "../src/commands/validate.js";

describe("integra validate --branch", () => {
  let originalCwd, home, liveDir, devCwd, xdgRoot;
  let priorSweepDisableFlag, priorXdgDataHome;

  function sh(cmd, dir) {
    return execSync(cmd, { cwd: dir, encoding: "utf-8" }).trim();
  }

  beforeAll(() => {
    // This suite exercises --branch end-to-end through the real validate()
    // command, which reaches @int3gra/manager's resolveArchive internally.
    // Disable the sweep-daemon lazy-start so this suite never starts a real
    // PM2-managed process — same reasoning as every other --branch suite.
    priorSweepDisableFlag = process.env.INTEGRA_TEST_NO_SWEEP_DAEMON;
    process.env.INTEGRA_TEST_NO_SWEEP_DAEMON = "1";
  });

  afterAll(() => {
    if (priorSweepDisableFlag === undefined) delete process.env.INTEGRA_TEST_NO_SWEEP_DAEMON;
    else process.env.INTEGRA_TEST_NO_SWEEP_DAEMON = priorSweepDisableFlag;
  });

  beforeEach(async () => {
    originalCwd = process.cwd();

    // Isolate integra's resolved home per test via XDG_DATA_HOME.
    xdgRoot = await mkdtemp(join(tmpdir(), "integra-xdg-validate-"));
    priorXdgDataHome = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = xdgRoot;

    const { resolveIntegraHome, writeHomeConfig } = await import("@int3gra/manager/home");
    home = resolveIntegraHome();
    await writeHomeConfig({}, home);

    liveDir = join(home, ".integrations", "val-int", "live");
    // The directory the command is invoked from — deliberately unrelated
    // to home, to prove --branch doesn't require being inside it.
    devCwd  = await mkdtemp(join(tmpdir(), "integra-validate-devcwd-"));

    // liveDir IS the repository — no separate bare remote.
    sh(`mkdir -p ${liveDir}`, home);
    sh("git init -q", liveDir);
    sh("git config user.email test@test.com", liveDir);
    sh("git config user.name test", liveDir);

    await writeFile(join(liveDir, "integra.json"), JSON.stringify({ id: "val-int", entry: null }));
    for (const sub of ["connections", "maps", "processes", "resolvers"]) {
      await mkdir(join(liveDir, sub), { recursive: true });
    }
    sh("git add -A", liveDir);
    sh('git commit -q -m "init"', liveDir);
    sh("git branch -M master", liveDir);

    await mkdir(join(home, "registry.d"), { recursive: true });
    await writeFile(
      join(home, "registry.d", "val-int.registry.json"),
      JSON.stringify({ id: "val-int", path: "./.integrations/val-int/live", enabled: true })
    );

    // devCwd needs its own integra.json — validate --branch reads cwd's
    // own manifest to learn the id. Deliberately no .env written here at
    // all, for any test in this file — proving --env is genuinely never
    // required.
    await writeFile(join(devCwd, "integra.json"), JSON.stringify({ id: "val-int", entry: null }));
    process.chdir(devCwd);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(xdgRoot, { recursive: true, force: true });
    await rm(devCwd, { recursive: true, force: true });
    if (priorXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = priorXdgDataHome;
  });

  async function pushBranch(branchName, manifestOverrides) {
    const devClone = join(xdgRoot, `dev-clone-${branchName}`);
    sh(`git clone -q ${liveDir} ${devClone}`, xdgRoot);
    sh("git config user.email test@test.com", devClone);
    sh("git config user.name test", devClone);
    sh(`git checkout -q -b ${branchName}`, devClone);
    // A marker file guarantees there's always something to commit, even
    // when manifestOverrides happens to produce identical integra.json
    // content to what live/ already has.
    await writeFile(join(devClone, ".branch-marker"), branchName);
    await writeFile(
      join(devClone, "integra.json"),
      JSON.stringify({ id: "val-int", entry: null, ...manifestOverrides })
    );
    sh("git add -A", devClone);
    sh(`git commit -q -m "on ${branchName}"`, devClone);
    sh(`git push -q origin ${branchName}`, devClone);
    await rm(devClone, { recursive: true, force: true });
  }

  // ── --env is never required ───────────────────────────────────────────────

  test("--branch does NOT require --env (validate never reads process.env)", async () => {
    await pushBranch("feature-noenv", {});
    // No .env exists anywhere in devCwd, home, or liveDir for this test —
    // if validate tried to read one, it would throw "env file not found".
    await expect(validate(["--branch", "feature-noenv"])).resolves.toBeUndefined();
  });

  test("plain validate() with no --branch also requires no --env", async () => {
    // Same property, against live/ directly via devCwd acting as the
    // integration directory (no --branch at all).
    await writeFile(join(devCwd, "integra.json"), JSON.stringify({ id: "val-int", entry: null }));
    for (const sub of ["connections", "maps", "processes", "resolvers"]) {
      await mkdir(join(devCwd, sub), { recursive: true });
    }
    await expect(validate([])).resolves.toBeUndefined();
  });

  // ── Validates the BRANCH's content, not live/'s ───────────────────────────

  test("validates the branch's own component files, not live/'s", async () => {
    await mkdir(join(liveDir, "connections"), { recursive: true });
    await writeFile(join(liveDir, "connections", "live-conn.json"), JSON.stringify({
      id: "live-conn", purpose: "read", request: { type: "GET", endpoint: "https://example.com" },
    }));
    sh("git add -A", liveDir);
    sh('git commit -q -m "add live connection"', liveDir);

    await pushBranch("feature-extra-conn", {});
    const devClone2 = join(xdgRoot, "dev-clone-feature-extra-conn-2");
    sh(`git clone -q ${liveDir} ${devClone2}`, xdgRoot);
    sh("git config user.email test@test.com", devClone2);
    sh("git config user.name test", devClone2);
    sh("git checkout -q feature-extra-conn", devClone2);
    await writeFile(join(devClone2, "connections", "branch-only-conn.json"), JSON.stringify({
      id: "branch-only-conn", purpose: "read", request: { type: "GET", endpoint: "https://example.com/b" },
    }));
    sh("git add -A", devClone2);
    sh('git commit -q -m "add branch-only connection"', devClone2);
    sh("git push -q origin feature-extra-conn", devClone2);

    const logs = [];
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(" "));
    try {
      await validate(["--branch", "feature-extra-conn"]);
    } finally {
      console.log = origLog;
    }

    // The branch has both connections (live's + its own) — 2 total.
    expect(logs.join("\n")).toContain("connections  (2)");
  });

  // ── Banner ─────────────────────────────────────────────────────────────────

  test("prints a banner naming the branch", async () => {
    await pushBranch("feature-banner", {});

    const logs = [];
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(" "));
    try {
      await validate(["--branch", "feature-banner"]);
    } finally {
      console.log = origLog;
    }

    expect(logs.join("\n")).toContain("feature-banner");
  });

  // ── Failure surfaces correctly ──────────────────────────────────────────────

  test("a branch with an invalid integra.json fails validation, not silently passes", async () => {
    await pushBranch("feature-bad-manifest", { id: undefined }); // missing required id

    await expect(validate(["--branch", "feature-bad-manifest"])).rejects.toThrow();
  });
});
