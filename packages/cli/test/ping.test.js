// Copyright (c) 2026 Claudius Tiberiu Iacob — Licensed under BSL 1.1. See LICENSE for details.
/**
 * packages/cli/test/ping.test.js
 *
 * Tests for the ping command. --id and --branch are both mandatory — see
 * branchTarget.js — so every test here pushes its fixture connection(s)
 * as a branch into a real git repository (standing in for live/) and
 * pings that branch. Uses mocked fetch — no real network calls.
 *
 * integra's home is a literal constant (/opt/integra in production — see
 * @int3gra/manager's home.js) with no override mechanism by design, so
 * this suite mocks resolveIntegraHome/assertIntegraHomeExists to point at
 * a per-test tmpdir rather than touching the real path.
 */

import { jest } from "@jest/globals";
import { mkdtemp, rm, writeFile, mkdir } from "fs/promises";
import { tmpdir }   from "os";
import { join }     from "path";
import { execSync } from "child_process";

let mockHome;

jest.unstable_mockModule("@int3gra/manager/home", () => ({
  resolveIntegraHome:     () => mockHome,
  assertIntegraHomeExists: () => {},
}));

const { ping } = await import("../src/commands/ping.js");

function sh(cmd, dir) {
  return execSync(cmd, { cwd: dir, encoding: "utf-8" }).trim();
}

describe("integra ping", () => {
  let originalExit, exitCode;
  let home, liveDir, xdgRoot;
  let priorSweepDisableFlag;
  let branchCounter;

  beforeAll(() => {
    originalExit = process.exit;
    process.exit = (code) => { exitCode = code; throw new Error(`process.exit(${code})`); };

    // This suite exercises --branch end-to-end through the real ping()
    // command, which reaches @int3gra/manager's resolveArchive internally.
    // Disable the sweep-daemon lazy-start so this suite never starts a real
    // PM2-managed process.
    priorSweepDisableFlag = process.env.INTEGRA_TEST_NO_SWEEP_DAEMON;
    process.env.INTEGRA_TEST_NO_SWEEP_DAEMON = "1";
  });

  afterAll(() => {
    process.exit = originalExit;
    if (priorSweepDisableFlag === undefined) delete process.env.INTEGRA_TEST_NO_SWEEP_DAEMON;
    else process.env.INTEGRA_TEST_NO_SWEEP_DAEMON = priorSweepDisableFlag;
  });

  beforeEach(async () => {
    exitCode      = undefined;
    branchCounter = 0;
    globalThis.fetch = undefined;

    xdgRoot  = await mkdtemp(join(tmpdir(), "integra-home-mock-ping-"));
    mockHome = xdgRoot;
    home     = mockHome;

    liveDir = join(home, ".integrations", "ping-int", "live");
    sh(`mkdir -p ${liveDir}`, home);
    sh("git init -q", liveDir);
    sh("git config user.email test@test.com", liveDir);
    sh("git config user.name test", liveDir);
    await writeFile(join(liveDir, "integra.json"), JSON.stringify({ id: "ping-int", entry: "p" }));
    for (const sub of ["connections", "maps", "processes", "resolvers"]) {
      await mkdir(join(liveDir, sub), { recursive: true });
    }
    sh("git add -A", liveDir);
    sh('git commit -q -m "init"', liveDir);
    sh("git branch -M master", liveDir);

    await mkdir(join(home, "registry.d"), { recursive: true });
    await writeFile(
      join(home, "registry.d", "ping-int.registry.json"),
      JSON.stringify({ id: "ping-int", path: "./.integrations/ping-int/live", enabled: true })
    );
  });

  afterEach(async () => {
    globalThis.fetch = undefined;
    await rm(xdgRoot, { recursive: true, force: true });
  });

  /**
   * Pushes a fresh branch whose connections/ and .env are exactly what the
   * test needs, then returns the branch name to pass as --branch.
   * connFiles: { "filename.json": <object> }
   */
  async function pushBranch(connFiles, envContent = "MY_BASE_URL=https://example.com\nMY_USER=testuser\nMY_PASS=testpass\n") {
    const branchName = `feature-${++branchCounter}`;
    const devClone    = join(xdgRoot, `dev-clone-${branchName}`);
    sh(`git clone -q ${liveDir} ${devClone}`, xdgRoot);
    sh("git config user.email test@test.com", devClone);
    sh("git config user.name test", devClone);
    sh(`git checkout -q -b ${branchName}`, devClone);

    for (const [filename, content] of Object.entries(connFiles)) {
      await mkdir(join(devClone, "connections"), { recursive: true });
      await writeFile(join(devClone, "connections", filename), JSON.stringify(content));
    }
    await writeFile(join(devClone, ".env"), envContent);

    sh("git add -A", devClone);
    sh(`git commit -q -m "on ${branchName}"`, devClone);
    sh(`git push -q origin ${branchName}`, devClone);
    await rm(devClone, { recursive: true, force: true });
    return branchName;
  }

  function pingArgs(branch, ...rest) {
    return ["--id", "ping-int", "--branch", branch, "--env", ".env", ...rest];
  }

  // ── --id / --branch mandatory ─────────────────────────────────────────────

  test("throws when --id is missing", async () => {
    await expect(ping(["--branch", "x", "--env", ".env"])).rejects.toThrow(/--id/i);
  });

  test("throws when --branch is missing", async () => {
    await expect(ping(["--id", "ping-int", "--env", ".env"])).rejects.toThrow(/--branch/i);
  });

  test("--branch without --env throws before doing anything else", async () => {
    await expect(ping(["--id", "ping-int", "--branch", "any-branch"])).rejects.toThrow(/requires --env/i);
  });

  // ── Missing no-op ──────────────────────────────────────────────────────────

  test("throws with a clear message when no-op connection is absent", async () => {
    const branch = await pushBranch({});
    await expect(ping(pingArgs(branch))).rejects.toThrow("no-op");
  });

  // ── Network error ──────────────────────────────────────────────────────────

  test("exits 1 on network error (fetch throws)", async () => {
    const branch = await pushBranch({
      "no-op.json": { id: "no-op", purpose: "read", request: { type: "GET", endpoint: "https://example.com/api/test" } },
    });
    globalThis.fetch = async () => { throw new Error("ECONNREFUSED"); };

    await expect(ping(pingArgs(branch))).rejects.toThrow("process.exit(1)");
    expect(exitCode).toBe(1);
  });

  // ── HTTP 4xx ──────────────────────────────────────────────────────────────

  test("exits 1 on 401 Unauthorized", async () => {
    const branch = await pushBranch({
      "no-op.json": { id: "no-op", purpose: "read", request: { type: "GET", endpoint: "https://example.com/api/test" } },
    });
    globalThis.fetch = async () => ({ ok: false, status: 401, statusText: "Unauthorized" });

    await expect(ping(pingArgs(branch))).rejects.toThrow("process.exit(1)");
    expect(exitCode).toBe(1);
  });

  test("exits 1 on 403 Forbidden", async () => {
    const branch = await pushBranch({
      "no-op.json": { id: "no-op", purpose: "read", request: { type: "GET", endpoint: "https://example.com/api/test" } },
    });
    globalThis.fetch = async () => ({ ok: false, status: 403, statusText: "Forbidden" });

    await expect(ping(pingArgs(branch))).rejects.toThrow("process.exit(1)");
    expect(exitCode).toBe(1);
  });

  // ── HTTP 2xx ──────────────────────────────────────────────────────────────

  test("exits 0 on 200 OK", async () => {
    const branch = await pushBranch({
      "no-op.json": { id: "no-op", purpose: "read", request: { type: "GET", endpoint: "https://example.com/api/test" } },
    });
    globalThis.fetch = async () => ({ ok: true, status: 200, statusText: "OK" });

    await expect(ping(pingArgs(branch))).resolves.toBeUndefined();
    expect(exitCode).toBeUndefined();
  });

  test("exits 0 on 201 Created", async () => {
    const branch = await pushBranch({
      "no-op.json": { id: "no-op", purpose: "read", request: { type: "GET", endpoint: "https://example.com/api/test" } },
    });
    globalThis.fetch = async () => ({ ok: true, status: 201, statusText: "Created" });

    await expect(ping(pingArgs(branch))).resolves.toBeUndefined();
  });

  // ── Query params ──────────────────────────────────────────────────────────

  test("appends query params to the request URL", async () => {
    const branch = await pushBranch({
      "no-op.json": {
        id: "no-op", purpose: "read",
        request: { type: "GET", endpoint: "https://example.com/api/items", query: { limit: "1", fields: "id" } },
      },
    });

    let capturedUrl;
    globalThis.fetch = async (url) => { capturedUrl = url; return { ok: true, status: 200, statusText: "OK" }; };

    await ping(pingArgs(branch));

    expect(capturedUrl).toContain("limit=1");
    expect(capturedUrl).toContain("fields=id");
  });

  // ── Env placeholder resolution ────────────────────────────────────────────

  test("resolves {{env.*}} placeholders in endpoint from .env", async () => {
    const branch = await pushBranch({
      "no-op.json": {
        id: "no-op", purpose: "read",
        request: { type: "GET", endpoint: "{{env.MY_BASE_URL}}/api/test" },
      },
    });

    let capturedUrl;
    globalThis.fetch = async (url) => { capturedUrl = url; return { ok: true, status: 200, statusText: "OK" }; };

    await ping(pingArgs(branch));

    expect(capturedUrl).toContain("example.com/api/test");
  });

  // ── --con flag ───────────────────────────────────────────────────────────

  test("--con targets a specific named connection", async () => {
    const branch = await pushBranch({
      "sn-health.json": { id: "sn-health", purpose: "read", request: { type: "GET", endpoint: "https://example.com/api/health" } },
    });
    globalThis.fetch = async () => ({ ok: true, status: 200, statusText: "OK" });

    await expect(ping(pingArgs(branch, "--con", "sn-health"))).resolves.toBeUndefined();
  });

  test("throws with clear message when --con names an unknown connection", async () => {
    const branch = await pushBranch({
      "no-op.json": { id: "no-op", purpose: "read", request: { type: "GET", endpoint: "https://example.com/api/test" } },
    });

    await expect(ping(pingArgs(branch, "--con", "does-not-exist"))).rejects.toThrow("does-not-exist");
  });

  test("pings multiple connections when --con has comma-separated ids", async () => {
    const branch = await pushBranch({
      "conn-a.json": { id: "conn-a", purpose: "read", request: { type: "GET", endpoint: "https://example.com/a" } },
      "conn-b.json": { id: "conn-b", purpose: "read", request: { type: "GET", endpoint: "https://example.com/b" } },
    });

    const called = [];
    globalThis.fetch = async (url) => { called.push(url); return { ok: true, status: 200, statusText: "OK" }; };

    await expect(ping(pingArgs(branch, "--con", "conn-a,conn-b"))).resolves.toBeUndefined();
    expect(called).toHaveLength(2);
    expect(called.some(u => u.includes("/a"))).toBe(true);
    expect(called.some(u => u.includes("/b"))).toBe(true);
  });

  test("exits 1 if any connection in a multi-ping fails", async () => {
    const branch = await pushBranch({
      "conn-a.json": { id: "conn-a", purpose: "read", request: { type: "GET", endpoint: "https://example.com/a" } },
      "conn-b.json": { id: "conn-b", purpose: "read", request: { type: "GET", endpoint: "https://example.com/b" } },
    });

    let callCount = 0;
    globalThis.fetch = async () => {
      callCount++;
      return callCount === 1
        ? { ok: true,  status: 200, statusText: "OK" }
        : { ok: false, status: 401, statusText: "Unauthorized" };
    };

    await expect(ping(pingArgs(branch, "--con", "conn-a,conn-b"))).rejects.toThrow("process.exit(1)");
    expect(exitCode).toBe(1);
    expect(callCount).toBe(2);
  });

  // ── Branch isolation and banner ───────────────────────────────────────────

  test("--branch pings the BRANCH's no-op, not live's", async () => {
    await writeFile(join(liveDir, "connections", "no-op.json"), JSON.stringify({
      id: "no-op", purpose: "read", request: { type: "GET", endpoint: "https://example.com/live-noop" },
    }));
    sh("git add -A", liveDir);
    sh('git commit -q -m "add live no-op"', liveDir);

    const branch = await pushBranch({
      "no-op.json": { id: "no-op", purpose: "read", request: { type: "GET", endpoint: "https://example.com/branch-noop" } },
    });

    let calledUrl;
    globalThis.fetch = async (url) => { calledUrl = url; return { ok: true, status: 200, statusText: "OK" }; };

    await ping(pingArgs(branch));

    expect(calledUrl).toContain("branch-noop");
    expect(calledUrl).not.toContain("live-noop");
  });

  test("prints a banner naming the branch and the integration id", async () => {
    const branch = await pushBranch({
      "no-op.json": { id: "no-op", purpose: "read", request: { type: "GET", endpoint: "https://example.com/api/test" } },
    });
    globalThis.fetch = async () => ({ ok: true, status: 200, statusText: "OK" });

    const logs = [];
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(" "));
    try {
      await ping(pingArgs(branch));
    } finally {
      console.log = origLog;
    }

    const joined = logs.join("\n");
    expect(joined).toContain(branch);
    expect(joined).toContain("ping-int");
  });
});
