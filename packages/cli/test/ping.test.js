// Copyright (c) 2026 Claudius Tiberiu Iacob — Licensed under BSL 1.1. See LICENSE for details.
/**
 * packages/cli/test/ping.test.js
 *
 * Tests for the ping command.
 * Uses mocked fetch — no real network calls.
 */

import { resolve as resolvePath } from "path";
import { fileURLToPath }          from "url";
import { mkdtemp, rm, writeFile,
         mkdir }                  from "fs/promises";
import { tmpdir }                 from "os";
import { join }                   from "path";

const __dirname = resolvePath(fileURLToPath(import.meta.url), "..");

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Creates a minimal integration directory with a no-op connection
 * and an .env file so ping() can run without touching real files.
 */
async function makeIntegrationDir(noOpConn = null) {
  const dir = await mkdtemp(join(tmpdir(), "integra-ping-test-"));

  // Write integra.json
  await writeFile(join(dir, "integra.json"), JSON.stringify({
    id: "test-ping-integration", entry: "test-process",
  }));

  // Write .env
  await writeFile(join(dir, ".env"), [
    "MY_BASE_URL=https://example.com",
    "MY_USER=testuser",
    "MY_PASS=testpass",
  ].join("\n"));

  // Create connections/ dir
  await mkdir(join(dir, "connections"), { recursive: true });

  if (noOpConn) {
    await writeFile(
      join(dir, "connections/no-op.json"),
      JSON.stringify(noOpConn)
    );
  }

  // Create empty maps/ processes/ resolvers/ so load() doesn't warn
  for (const sub of ["maps", "processes", "resolvers"]) {
    await mkdir(join(dir, sub), { recursive: true });
  }

  return dir;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("integra ping", () => {
  let dir;
  let ping;
  let originalExit;
  let exitCode;

  let originalCwd;

  beforeAll(async () => {
    const mod = await import("../src/commands/ping.js");
    ping = mod.ping;
    originalCwd = process.cwd();

    // Capture process.exit calls
    originalExit = process.exit;
    process.exit = (code) => { exitCode = code; throw new Error(`process.exit(${code})`); };
  });

  afterAll(() => {
    process.exit = originalExit;
    process.chdir(originalCwd);
  });

  beforeEach(() => {
    exitCode = undefined;
    globalThis.fetch = undefined;
  });

  afterEach(async () => {
    globalThis.fetch = undefined;
    if (dir) {
      // Restore cwd before deleting dir to avoid leaving process in a deleted dir
      process.chdir(originalCwd);
      await rm(dir, { recursive: true, force: true });
      dir = null;
    }
  });

  // ── Missing no-op ──────────────────────────────────────────────────────────

  test("throws with a clear message when no-op connection is absent", async () => {
    dir = await makeIntegrationDir(null);
    process.chdir(dir);

    await expect(ping([])).rejects.toThrow("no-op");
  });

  // ── Network error ──────────────────────────────────────────────────────────

  test("exits 1 on network error (fetch throws)", async () => {
    dir = await makeIntegrationDir({
      id: "no-op",
      purpose: "read",
      request: { type: "GET", endpoint: "https://example.com/api/test" },
    });
    process.chdir(dir);

    globalThis.fetch = async () => { throw new Error("ECONNREFUSED"); };

    await expect(ping([])).rejects.toThrow("process.exit(1)");
    expect(exitCode).toBe(1);
  });

  // ── HTTP 4xx ──────────────────────────────────────────────────────────────

  test("exits 1 on 401 Unauthorized", async () => {
    dir = await makeIntegrationDir({
      id: "no-op",
      purpose: "read",
      request: { type: "GET", endpoint: "https://example.com/api/test" },
    });
    process.chdir(dir);

    globalThis.fetch = async () => ({
      ok: false, status: 401, statusText: "Unauthorized",
    });

    await expect(ping([])).rejects.toThrow("process.exit(1)");
    expect(exitCode).toBe(1);
  });

  test("exits 1 on 403 Forbidden", async () => {
    dir = await makeIntegrationDir({
      id: "no-op",
      purpose: "read",
      request: { type: "GET", endpoint: "https://example.com/api/test" },
    });
    process.chdir(dir);

    globalThis.fetch = async () => ({
      ok: false, status: 403, statusText: "Forbidden",
    });

    await expect(ping([])).rejects.toThrow("process.exit(1)");
    expect(exitCode).toBe(1);
  });

  // ── HTTP 2xx ──────────────────────────────────────────────────────────────

  test("exits 0 on 200 OK", async () => {
    dir = await makeIntegrationDir({
      id: "no-op",
      purpose: "read",
      request: { type: "GET", endpoint: "https://example.com/api/test" },
    });
    process.chdir(dir);

    globalThis.fetch = async () => ({ ok: true, status: 200, statusText: "OK" });

    // Should complete without throwing
    await expect(ping([])).resolves.toBeUndefined();
    expect(exitCode).toBeUndefined();
  });

  test("exits 0 on 201 Created", async () => {
    dir = await makeIntegrationDir({
      id: "no-op",
      purpose: "read",
      request: { type: "GET", endpoint: "https://example.com/api/test" },
    });
    process.chdir(dir);

    globalThis.fetch = async () => ({ ok: true, status: 201, statusText: "Created" });

    await expect(ping([])).resolves.toBeUndefined();
  });

  // ── Query params ──────────────────────────────────────────────────────────

  test("appends query params to the request URL", async () => {
    dir = await makeIntegrationDir({
      id: "no-op",
      purpose: "read",
      request: {
        type:     "GET",
        endpoint: "https://example.com/api/items",
        query:    { limit: "1", fields: "id" },
      },
    });
    process.chdir(dir);

    let capturedUrl;
    globalThis.fetch = async (url) => {
      capturedUrl = url;
      return { ok: true, status: 200, statusText: "OK" };
    };

    await ping([]);

    expect(capturedUrl).toContain("limit=1");
    expect(capturedUrl).toContain("fields=id");
  });

  // ── Env placeholder resolution ────────────────────────────────────────────

  test("resolves {{env.*}} placeholders in endpoint from .env", async () => {
    dir = await makeIntegrationDir({
      id: "no-op",
      purpose: "read",
      request: {
        type:     "GET",
        endpoint: "{{env.MY_BASE_URL}}/api/test",
      },
    });
    process.chdir(dir);

    let capturedUrl;
    globalThis.fetch = async (url) => {
      capturedUrl = url;
      return { ok: true, status: 200, statusText: "OK" };
    };

    await ping([]);

    expect(capturedUrl).toContain("example.com/api/test");
  });
  // ── --con flag ───────────────────────────────────────────────────────────

  test("--con targets a specific named connection", async () => {
    dir = await makeIntegrationDir({
      id: "sn-health",
      purpose: "read",
      request: { type: "GET", endpoint: "https://example.com/api/health" },
    });
    // Rename no-op.json to sn-health.json
    const { rename } = await import("fs/promises");
    await rename(join(dir, "connections/no-op.json"), join(dir, "connections/sn-health.json"));
    process.chdir(dir);

    globalThis.fetch = async () => ({ ok: true, status: 200, statusText: "OK" });

    await expect(ping(["--con", "sn-health"])).resolves.toBeUndefined();
  });

  test("throws with clear message when --con names an unknown connection", async () => {
    dir = await makeIntegrationDir({
      id: "no-op",
      purpose: "read",
      request: { type: "GET", endpoint: "https://example.com/api/test" },
    });
    process.chdir(dir);

    await expect(ping(["--con", "does-not-exist"])).rejects.toThrow("does-not-exist");
  });

  test("pings multiple connections when --con has comma-separated ids", async () => {
    dir = await makeIntegrationDir(null);
    const { writeFile: wf } = await import("fs/promises");

    // Write two connection files
    await wf(join(dir, "connections/conn-a.json"), JSON.stringify({
      id: "conn-a", purpose: "read",
      request: { type: "GET", endpoint: "https://example.com/a" },
    }));
    await wf(join(dir, "connections/conn-b.json"), JSON.stringify({
      id: "conn-b", purpose: "read",
      request: { type: "GET", endpoint: "https://example.com/b" },
    }));
    process.chdir(dir);

    const called = [];
    globalThis.fetch = async (url) => {
      called.push(url);
      return { ok: true, status: 200, statusText: "OK" };
    };

    await expect(ping(["--con", "conn-a,conn-b"])).resolves.toBeUndefined();
    expect(called).toHaveLength(2);
    expect(called.some(u => u.includes("/a"))).toBe(true);
    expect(called.some(u => u.includes("/b"))).toBe(true);
  });

  test("exits 1 if any connection in a multi-ping fails", async () => {
    dir = await makeIntegrationDir(null);
    const { writeFile: wf } = await import("fs/promises");

    await wf(join(dir, "connections/conn-a.json"), JSON.stringify({
      id: "conn-a", purpose: "read",
      request: { type: "GET", endpoint: "https://example.com/a" },
    }));
    await wf(join(dir, "connections/conn-b.json"), JSON.stringify({
      id: "conn-b", purpose: "read",
      request: { type: "GET", endpoint: "https://example.com/b" },
    }));
    process.chdir(dir);

    let callCount = 0;
    globalThis.fetch = async () => {
      callCount++;
      // First succeeds, second fails
      return callCount === 1
        ? { ok: true,  status: 200, statusText: "OK" }
        : { ok: false, status: 401, statusText: "Unauthorized" };
    };

    await expect(ping(["--con", "conn-a,conn-b"])).rejects.toThrow("process.exit(1)");
    expect(exitCode).toBe(1);
    // Both connections were still attempted
    expect(callCount).toBe(2);
  });
});