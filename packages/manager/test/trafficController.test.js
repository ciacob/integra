/**
 * packages/manager/test/trafficController.test.js
 *
 * Unit tests for the TrafficController's pure decide() function.
 * No PM2, no filesystem, no network — entirely deterministic.
 */

import { decide } from "../src/trafficController.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const NOW = 1_700_000_000_000; // fixed "now" for all tests

function makeEntry(overrides = {}) {
  return { id: "test-integration", enabled: true, ...overrides };
}

function makePm2Process(status, startedMsAgo = 0) {
  return {
    name:    "test-integration",
    pm2_env: {
      status,
      pm_uptime: NOW - startedMsAgo,
    },
  };
}

// ── Not registered ────────────────────────────────────────────────────────────

describe("integration not registered in PM2", () => {
  test("returns start when pm2Process is null", () => {
    const result = decide(makeEntry(), null, NOW);
    expect(result.decision).toBe("start");
  });

  test("includes a reason", () => {
    const result = decide(makeEntry(), null, NOW);
    expect(result.reason).toBeTruthy();
  });
});

// ── Not online ────────────────────────────────────────────────────────────────

describe("integration registered but not online", () => {
  const nonOnlineStatuses = ["stopped", "stopping", "errored", "launching", "undefined"];

  test.each(nonOnlineStatuses)('returns start when status is "%s"', (status) => {
    const result = decide(makeEntry(), makePm2Process(status), NOW);
    expect(result.decision).toBe("start");
    expect(result.reason).toContain(status);
  });
});

// ── Online, no max_ttl ────────────────────────────────────────────────────────

describe("integration online, no max_ttl defined", () => {
  test("always stands down regardless of age", () => {
    const entry = makeEntry(); // no max_ttl
    const result = decide(entry, makePm2Process("online", 999_999_000), NOW);
    expect(result.decision).toBe("stand_down");
  });

  test("reason mentions no max_ttl", () => {
    const result = decide(makeEntry(), makePm2Process("online", 60_000), NOW);
    expect(result.reason).toMatch(/max_ttl/i);
  });
});

// ── Online, with max_ttl, within limit ───────────────────────────────────────

describe("integration online, within max_ttl", () => {
  test("stands down when age < max_ttl", () => {
    const entry  = makeEntry({ max_ttl: 300 });        // 300s limit
    const result = decide(entry, makePm2Process("online", 100_000), NOW); // 100s old
    expect(result.decision).toBe("stand_down");
  });

  test("stands down when age === max_ttl (boundary — not exceeded)", () => {
    const entry  = makeEntry({ max_ttl: 100 });
    const result = decide(entry, makePm2Process("online", 100_000), NOW); // exactly 100s
    expect(result.decision).toBe("stand_down");
  });

  test("includes age_seconds in result", () => {
    const entry  = makeEntry({ max_ttl: 300 });
    const result = decide(entry, makePm2Process("online", 60_000), NOW);
    expect(result.age_seconds).toBe(60);
  });
});

// ── Online, with max_ttl, exceeded ───────────────────────────────────────────

describe("integration online, max_ttl exceeded", () => {
  test("returns kill_and_restart when age > max_ttl", () => {
    const entry  = makeEntry({ max_ttl: 60 });           // 60s limit
    const result = decide(entry, makePm2Process("online", 120_000), NOW); // 120s old
    expect(result.decision).toBe("kill_and_restart");
  });

  test("age must strictly exceed max_ttl (age === max_ttl is stand_down)", () => {
    const entry = makeEntry({ max_ttl: 60 });
    const exact = decide(entry, makePm2Process("online", 60_000), NOW);
    expect(exact.decision).toBe("stand_down");

    const over = decide(entry, makePm2Process("online", 61_000), NOW);
    expect(over.decision).toBe("kill_and_restart");
  });

  test("includes age_seconds in result", () => {
    const entry  = makeEntry({ max_ttl: 60 });
    const result = decide(entry, makePm2Process("online", 120_000), NOW);
    expect(result.age_seconds).toBe(120);
  });

  test("reason includes both age and max_ttl", () => {
    const entry  = makeEntry({ max_ttl: 60 });
    const result = decide(entry, makePm2Process("online", 120_000), NOW);
    expect(result.reason).toContain("120");
    expect(result.reason).toContain("60");
  });
});

// ── Edge cases ────────────────────────────────────────────────────────────────

describe("edge cases", () => {
  test("pm_uptime missing from pm2_env treats as no max_ttl (stand_down)", () => {
    const entry   = makeEntry({ max_ttl: 60 });
    const process = { name: "x", pm2_env: { status: "online" } }; // no pm_uptime
    const result  = decide(entry, process, NOW);
    expect(result.decision).toBe("stand_down");
  });

  test("max_ttl: 0 means any running process is immediately eligible for restart", () => {
    const entry  = makeEntry({ max_ttl: 0 });
    const result = decide(entry, makePm2Process("online", 1_000), NOW); // 1 second old
    expect(result.decision).toBe("kill_and_restart");
  });

  test("decide is a pure function — calling it twice returns the same result", () => {
    const entry   = makeEntry({ max_ttl: 120 });
    const process = makePm2Process("online", 60_000);
    const r1      = decide(entry, process, NOW);
    const r2      = decide(entry, process, NOW);
    expect(r1).toEqual(r2);
  });

  test("decide does not mutate the entry argument", () => {
    const entry    = makeEntry({ max_ttl: 60 });
    const original = { ...entry };
    decide(entry, makePm2Process("online", 120_000), NOW);
    expect(entry).toEqual(original);
  });

  test("decide does not mutate the pm2Process argument", () => {
    const proc     = makePm2Process("online", 120_000);
    const original = JSON.parse(JSON.stringify(proc));
    decide(makeEntry({ max_ttl: 60 }), proc, NOW);
    expect(proc).toEqual(original);
  });
});
