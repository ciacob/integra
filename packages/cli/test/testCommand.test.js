// Copyright (c) 2026 Claudius Tiberiu Iacob — Licensed under BSL 1.1. See LICENSE for details.
/**
 * packages/cli/test/testCommand.test.js
 *
 * Unit tests for the pure helpers in the test command.
 * No filesystem, no network, no engine.
 */

import { resolveResponseFixture } from "../src/commands/test.js";

// ── resolveResponseFixture ────────────────────────────────────────────────────

describe("resolveResponseFixture", () => {
  const ONE_FILE    = ["/fixtures/responses/single.json"];
  const TWO_FILES   = ["/fixtures/responses/a.json", "/fixtures/responses/b.json"];
  const URL_SN      = "https://devXXXXX.service-now.com/api/now/table/incident";
  const URL_JIRA    = "https://org.atlassian.net/rest/api/3/issue";

  // Injectable exists function — always returns true for unit tests
  const existsAlways = () => true;
  // Injectable exists function — always returns false (simulates missing file)
  const existsNever  = () => false;

  // ── Single fixture ──────────────────────────────────────────────────────────

  test("returns the single file for any URL when only one fixture exists", () => {
    expect(resolveResponseFixture(URL_SN, null, ONE_FILE)).toBe(ONE_FILE[0]);
  });

  test("returns the single file even when a map is provided", () => {
    const map = { [URL_SN]: "/fixtures/responses/other.json" };
    expect(resolveResponseFixture(URL_SN, map, ONE_FILE)).toBe(ONE_FILE[0]);
  });

  // ── No fixtures ─────────────────────────────────────────────────────────────

  test("throws when no fixture files exist", () => {
    expect(() => resolveResponseFixture(URL_SN, null, []))
      .toThrow("No response fixtures found");
  });

  // ── Multiple fixtures, no map ───────────────────────────────────────────────

  test("throws when multiple fixtures exist but no map", () => {
    expect(() => resolveResponseFixture(URL_SN, null, TWO_FILES))
      .toThrow(".fixture-map.json");
  });

  // ── Multiple fixtures with map ──────────────────────────────────────────────

  test("returns the mapped file for a matching URL", () => {
    const map = { [URL_SN]: "/fixtures/responses/a.json" };
    expect(resolveResponseFixture(URL_SN, map, TWO_FILES, existsAlways))
      .toBe("/fixtures/responses/a.json");
  });

  test("supports prefix matching — longer URL path matches base URL key", () => {
    const baseUrl = "https://devXXXXX.service-now.com/api/now/table/incident";
    const fullUrl = "https://devXXXXX.service-now.com/api/now/table/incident?sysparm_limit=10";
    const map     = { [baseUrl]: "/fixtures/responses/a.json" };
    expect(resolveResponseFixture(fullUrl, map, TWO_FILES, existsAlways))
      .toBe("/fixtures/responses/a.json");
  });

  test("throws with the unmatched URL when no map entry exists", () => {
    const map = { [URL_SN]: "/fixtures/responses/a.json" };
    expect(() => resolveResponseFixture(URL_JIRA, map, TWO_FILES, existsAlways))
      .toThrow(URL_JIRA);
  });

  test("throws when mapped file does not exist on disk", () => {
    const map = { [URL_SN]: "/nonexistent/path/fixture.json" };
    expect(() => resolveResponseFixture(URL_SN, map, TWO_FILES, existsNever))
      .toThrow("does not exist");
  });

  test("error message names the missing file", () => {
    const map = { [URL_SN]: "/nonexistent/fixture.json" };
    let msg = "";
    try { resolveResponseFixture(URL_SN, map, TWO_FILES, existsNever); } catch (e) { msg = e.message; }
    expect(msg).toContain("fixture.json");
  });

  test("first matching entry in map wins (order-sensitive)", () => {
    // Both keys would prefix-match the URL, but first wins
    const map = {
      "https://devXXXXX.service-now.com/api/now/table/incident": "/fixtures/responses/a.json",
      "https://devXXXXX.service-now.com/api/now":                "/fixtures/responses/b.json",
    };
    expect(resolveResponseFixture(URL_SN, map, TWO_FILES, existsAlways))
      .toBe("/fixtures/responses/a.json");
  });
});

// ── test() entry point with --branch ───────────────────────────────────────────
// First end-to-end exercise of the test() entry point in this file — the
// suite above only ever tested the pure resolveResponseFixture helper.
// Uses a real git manager-root structure, same pattern as ping --branch.

describe("integra test --branch", () => {
  let runTestCommand;
  let originalExit, exitCode;
  let originalCwd, home, liveDir, devCwd, xdgRoot;
  let priorSweepDisableFlag, priorXdgDataHome;

  async function sh(cmd, dir) {
    const { execSync } = await import("child_process");
    return execSync(cmd, { cwd: dir, encoding: "utf-8" }).trim();
  }

  beforeAll(async () => {
    const mod = await import("../src/commands/test.js");
    runTestCommand = mod.test;
    originalExit = process.exit;
    process.exit = (code) => { exitCode = code; throw new Error(`process.exit(${code})`); };

    // This suite exercises --branch end-to-end through the real test()
    // command, which reaches @int3gra/manager's resolveArchive internally.
    // Disable the sweep-daemon lazy-start for the same reason ping --branch
    // and branchTarget.test.js do — never start a real PM2 process from a
    // unit test.
    priorSweepDisableFlag = process.env.INTEGRA_TEST_NO_SWEEP_DAEMON;
    process.env.INTEGRA_TEST_NO_SWEEP_DAEMON = "1";
  });

  afterAll(() => {
    process.exit = originalExit;
    if (priorSweepDisableFlag === undefined) delete process.env.INTEGRA_TEST_NO_SWEEP_DAEMON;
    else process.env.INTEGRA_TEST_NO_SWEEP_DAEMON = priorSweepDisableFlag;
  });

  beforeEach(async () => {
    const { mkdtemp, writeFile, mkdir } = await import("fs/promises");
    const { tmpdir } = await import("os");
    const { join }   = await import("path");

    originalCwd = process.cwd();

    // Isolate integra's resolved home per test via XDG_DATA_HOME.
    xdgRoot = await mkdtemp(join(tmpdir(), "integra-xdg-test-"));
    priorXdgDataHome = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = xdgRoot;

    const { resolveIntegraHome, writeHomeConfig } = await import("@int3gra/manager/home");
    home = resolveIntegraHome();
    await writeHomeConfig({}, home);

    liveDir   = join(home, ".integrations", "tb-int", "live");
    // The directory the command is invoked from — deliberately unrelated
    // to home, to prove --branch doesn't require being inside it.
    devCwd    = await mkdtemp(join(tmpdir(), "integra-test-devcwd-"));

    // liveDir IS the repository — no separate bare remote.
    await sh(`mkdir -p ${liveDir}`, home);
    await sh("git init -q", liveDir);
    await sh("git config user.email test@test.com", liveDir);
    await sh("git config user.name test", liveDir);

    // live/'s own integra.json: an outbound, run-once integration with NO
    // entry process — this is deliberate, so a test against live/ itself
    // (no --branch) would fail fast, distinguishing "ran against live" from
    // "ran against the branch" if the --branch wiring were ever broken.
    await writeFile(join(liveDir, "integra.json"), JSON.stringify({ id: "tb-int", entry: null }));
    await mkdir(join(liveDir, "test", "fixtures", "responses"), { recursive: true });
    for (const sub of ["connections", "maps", "processes", "resolvers"]) {
      await mkdir(join(liveDir, sub), { recursive: true });
    }
    await sh("git add -A", liveDir);
    await sh('git commit -q -m "init"', liveDir);
    await sh("git branch -M master", liveDir);

    await mkdir(join(home, "registry.d"), { recursive: true });
    await writeFile(
      join(home, "registry.d", "tb-int.registry.json"),
      JSON.stringify({ id: "tb-int", path: "./.integrations/tb-int/live", enabled: true })
    );

    // devCwd needs its own integra.json (test --branch reads cwd's own
    // manifest to learn the id) — same deliberately-no-entry-process shape
    // as live/'s, for the same fail-fast-if-wiring-is-broken reason.
    await writeFile(join(devCwd, "integra.json"), JSON.stringify({ id: "tb-int", entry: null }));
    process.chdir(devCwd);
  });

  afterEach(async () => {
    const { rm } = await import("fs/promises");
    process.chdir(originalCwd);
    // xdgRoot contains home/.integrations/.../live AND any dev clones created
    // inside it — removing xdgRoot covers both in one pass.
    await rm(xdgRoot, { recursive: true, force: true });
    await rm(devCwd, { recursive: true, force: true });
    if (priorXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = priorXdgDataHome;
    globalThis.fetch = undefined;
  });

  test("--branch does NOT require --env (test never uses real credentials)", async () => {
    const { writeFile, mkdir } = await import("fs/promises");
    const { join } = await import("path");

    // Push a branch with a real entry process + a trivial fixture so the
    // run can actually complete.
    const devClone = join(xdgRoot, "dev-clone-feature-mocktest");
    await sh(`git clone -q ${liveDir} ${devClone}`, xdgRoot);
    await sh("git config user.email test@test.com", devClone);
    await sh("git config user.name test", devClone);
    await sh("git checkout -q -b feature-mocktest", devClone);

    await writeFile(join(devClone, "integra.json"), JSON.stringify({ id: "tb-int", entry: "noop-process" }));
    await mkdir(join(devClone, "processes"), { recursive: true });
    await writeFile(join(devClone, "processes", "noop-process.json"), JSON.stringify({
      id: "noop-process", flow: { steps: [] },
    }));
    await mkdir(join(devClone, "test", "fixtures", "responses"), { recursive: true });
    await writeFile(join(devClone, "test", "fixtures", "responses", "x.json"), JSON.stringify({ ok: true }));

    await sh("git add -A", devClone);
    await sh('git commit -q -m "mocktest branch"', devClone);
    await sh("git push -q origin feature-mocktest", devClone);

    // No --env given at all — must not throw on that account.
    await expect(runTestCommand(["--branch", "feature-mocktest"])).resolves.toBeUndefined();
  });

  test("--branch banner is printed and names the branch", async () => {
    const { writeFile, mkdir } = await import("fs/promises");
    const { join } = await import("path");

    const devClone = join(xdgRoot, "dev-clone-feature-banner2");
    await sh(`git clone -q ${liveDir} ${devClone}`, xdgRoot);
    await sh("git config user.email test@test.com", devClone);
    await sh("git config user.name test", devClone);
    await sh("git checkout -q -b feature-banner2", devClone);
    await writeFile(join(devClone, "integra.json"), JSON.stringify({ id: "tb-int", entry: "noop-process" }));
    await mkdir(join(devClone, "processes"), { recursive: true });
    await writeFile(join(devClone, "processes", "noop-process.json"), JSON.stringify({
      id: "noop-process", flow: { steps: [] },
    }));
    await mkdir(join(devClone, "test", "fixtures", "responses"), { recursive: true });
    await writeFile(join(devClone, "test", "fixtures", "responses", "x.json"), JSON.stringify({ ok: true }));
    await sh("git add -A", devClone);
    await sh('git commit -q -m "banner test branch"', devClone);
    await sh("git push -q origin feature-banner2", devClone);

    const logs = [];
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(" "));
    try {
      await runTestCommand(["--branch", "feature-banner2"]);
    } finally {
      console.log = origLog;
    }

    expect(logs.join("\n")).toContain("feature-banner2");
  });
});
