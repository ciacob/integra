// Copyright (c) 2026 Claudius Tiberiu Iacob — Licensed under BSL 1.1. See LICENSE for details.
/**
 * test/sync-process.test.js
 * Tests for the ServiceNow → Jira sync integration.
 *
 * Process-level tests use fixture files from test/fixtures/ — the same
 * files that `integra test` uses — so this suite and the CLI mock-test
 * runner exercise identical data and behaviour.
 *
 * Resolver unit tests use inline data (appropriate for pure function testing).
 *
 * Run from monorepo root: node --experimental-vm-modules node_modules/.bin/jest
 */

import { resolve as resolvePath } from "path";
import { readFile }               from "fs/promises";
import { fileURLToPath }          from "url";

const __dirname = resolvePath(fileURLToPath(import.meta.url), "..");
const CWD       = resolvePath(__dirname, "..");

// Set env before any engine imports
process.env.SN_BASE_URL      = "https://devXXXXX.service-now.com";
process.env.SN_USER          = "test-user";
process.env.SN_PASS          = "test-pass";
process.env.JIRA_BASE_URL    = "https://test-org.atlassian.net";
process.env.JIRA_USER        = "test@test.com";
process.env.JIRA_API_TOKEN   = "test-token";
process.env.JIRA_PROJECT_KEY = "OPS";
process.env.LOG_LEVEL        = "error";

// ── Fixture loading ───────────────────────────────────────────────────────────
// Fixtures live in test/fixtures/responses/ — the same files integra test uses.

async function loadFixture(name) {
  const raw = await readFile(resolvePath(CWD, "test/fixtures/responses", name), "utf-8");
  const { _mockStatus, ...body } = JSON.parse(raw);
  return { body, status: _mockStatus ?? 200 };
}

async function loadFixtureMap() {
  const raw = await readFile(resolvePath(CWD, "test/fixtures/.fixture-map.json"), "utf-8");
  return JSON.parse(raw);
}

/**
 * Builds a fetch mock that serves fixture files by URL — mirrors the logic
 * in `integra test` so process-level tests and CLI mock-tests are equivalent.
 */
async function buildFixtureFetch(overrides = {}) {
  const map          = await loadFixtureMap();
  const callLog      = [];

  globalThis.fetch = async (url, opts) => {
    callLog.push({ url, method: opts?.method ?? "GET", body: opts?.body });

    // Allow per-test overrides for error-path testing — prefix match
    const overrideEntry = Object.entries(overrides).find(([pattern]) => url.startsWith(pattern));
    if (overrideEntry) return overrideEntry[1](url, opts);

    // Find matching map entry by prefix
    const entry = Object.entries(map).find(([pattern]) => url.startsWith(pattern));
    if (!entry) throw new Error(`No fixture mapped for URL: ${url}`);

    const fixturePath = resolvePath(CWD, entry[1]);
    const raw         = await readFile(fixturePath, "utf-8");
    const { _mockStatus, ...body } = JSON.parse(raw);
    return {
      ok:   (_mockStatus ?? 200) < 400,
      status: _mockStatus ?? 200,
      json: async () => body,
    };
  };

  return {
    calls:    callLog,
    callsTo:  (urlFragment) => callLog.filter(c => c.url.includes(urlFragment)),
    restore:  () => { globalThis.fetch = undefined; },
  };
}

// ── Process-level tests ───────────────────────────────────────────────────────

describe("sync-incident-sn-to-jira (process)", () => {
  let boot;

  beforeAll(async () => {
    const mod = await import("@int3gra/engine");
    boot = mod.boot;
  });

  afterEach(() => { globalThis.fetch = undefined; });

  test("creates one Jira issue per ServiceNow incident", async () => {
    const { calls } = await buildFixtureFetch();

    const result = await boot(CWD, { processId: "sync-incident-sn-to-jira" });

    // Two incidents in the fixture → two Jira calls
    expect(calls.filter(c => c.url.includes("atlassian.net"))).toHaveLength(2);
    expect(result.shared.sn_incidents.result).toHaveLength(2);
  });

  test("maps SN priority 2 (High) to Jira High and priority 1 to Highest", async () => {
    const jiraPayloads = [];
    await buildFixtureFetch({
      [`${process.env.JIRA_BASE_URL.toLowerCase()}/rest/api/3/issue`]: async (url, opts) => {
        jiraPayloads.push(JSON.parse(opts.body));
        return { ok: true, status: 201, json: async () => ({ id: "1", key: "OPS-1" }) };
      },
    });

    await boot(CWD, { processId: "sync-incident-sn-to-jira" });

    // Fixture has priority-2 ("Printer on fire") and priority-1 ("VPN unreachable")
    const priorities = jiraPayloads.map(p => p.fields.priority.name);
    expect(priorities).toContain("High");
    expect(priorities).toContain("Highest");
  });

  test("handles empty incident list gracefully — no Jira calls", async () => {
    // Override the SN URL to return the empty fixture
    const emptyFixturePath = resolvePath(CWD, "test/fixtures/responses/sn-get-incidents-empty.json");
    const emptyRaw         = await readFile(emptyFixturePath, "utf-8");
    const { _mockStatus, ...emptyBody } = JSON.parse(emptyRaw);

    // Base URL — prefix matching in buildFixtureFetch handles the query params
    const snEmptyUrl = `${process.env.SN_BASE_URL.toLowerCase()}/api/now/table/incident`;
    const { calls } = await buildFixtureFetch({
      [snEmptyUrl]: async () => ({
        ok: true, status: 200, json: async () => emptyBody,
      }),
    });

    const result = await boot(CWD, { processId: "sync-incident-sn-to-jira" });

    expect(calls.filter(c => c.url.includes("atlassian.net"))).toHaveLength(0);
    expect(result).toBeDefined();
  });

  test("writes a structured run summary to shared space", async () => {
    await buildFixtureFetch();
    const result = await boot(CWD, { processId: "sync-incident-sn-to-jira" });

    const summary = result.shared.sync_result;
    expect(summary).toBeDefined();
    expect(summary.incidents_fetched).toBe(2);
    expect(summary.issues_created).toBe(2);
    expect(summary.issues_skipped).toBe(0);
    expect(summary.completed_at).toBeTruthy();
  });

  test("run summary reflects skipped incidents when a create call fails", async () => {
    let jiraCallCount = 0;

    await buildFixtureFetch({
      [`${process.env.JIRA_BASE_URL.toLowerCase()}/rest/api/3/issue`]: async () => {
        jiraCallCount++;
        // First call succeeds, second fails
        if (jiraCallCount === 1) {
          return { ok: true, status: 201, json: async () => ({ id: "1", key: "OPS-1" }) };
        }
        return { ok: false, status: 500, statusText: "Internal Server Error", json: async () => ({}) };
      },
    });

    const result  = await boot(CWD, { processId: "sync-incident-sn-to-jira" });
    const summary = result.shared.sync_result;

    expect(summary.incidents_fetched).toBe(2);
    expect(summary.issues_created).toBe(1);
    expect(summary.issues_skipped).toBe(1);
  });
});

// ── Resolver unit tests ───────────────────────────────────────────────────────
// These test pure functions directly with inline data — no fixtures needed.

describe("mapIncident (itsm-maps resolver)", () => {
  let mapIncident;

  beforeAll(async () => {
    const mod  = await import("../resolvers/itsm-maps.js");
    mapIncident = mod.mapIncident;
  });

  const makeCtx = () => ({
    env:     { JIRA_PROJECT_KEY: "OPS" },
    input:   {},
    output:  {},
    _shared: { set: () => {}, get: () => {} },
    logger:  { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    meta:    {},
  });

  test("maps priority 1 → Highest", () => {
    const result = mapIncident(makeCtx(), { sys_id: "a", number: "INC001", short_description: "Test", description: "Desc", priority: "1", category: "network" });
    expect(result.fields.priority.name).toBe("Highest");
  });

  test("maps priority 2 → High", () => {
    const result = mapIncident(makeCtx(), { short_description: "Test", priority: "2" });
    expect(result.fields.priority.name).toBe("High");
  });

  test("maps priority 5 → Lowest", () => {
    const result = mapIncident(makeCtx(), { short_description: "Low", priority: "5" });
    expect(result.fields.priority.name).toBe("Lowest");
  });

  test("defaults to Medium for unknown priority", () => {
    const result = mapIncident(makeCtx(), { short_description: "Test", priority: "99" });
    expect(result.fields.priority.name).toBe("Medium");
  });

  test("sets project key from env", () => {
    const result = mapIncident(makeCtx(), { short_description: "Test", priority: "3" });
    expect(result.fields.project.key).toBe("OPS");
  });

  test("carries original SN metadata", () => {
    const result = mapIncident(makeCtx(), { sys_id: "abc", number: "INC001", short_description: "Test", priority: "2" });
    expect(result.__sn_number).toBe("INC001");
    expect(result.__sn_sys_id).toBe("abc");
    expect(result.__sn_priority).toBe("2");
  });
});

describe("hasNextIncident (sync resolver)", () => {
  let hasNextIncident;

  beforeAll(async () => {
    const mod       = await import("../resolvers/sync.js");
    hasNextIncident = mod.hasNextIncident;
  });

  function makeCtx(queue) {
    const store = { "_sn_incident_queue": [...queue] };
    return {
      shared:  { ...store },
      _shared: { get: k => store[k], set: (k, v) => { store[k] = v; } },
      meta:    {},
      logger:  { info: () => {} },
    };
  }

  test("returns true and pops the first incident", () => {
    const ctx = makeCtx([{ number: "INC001" }, { number: "INC002" }]);
    expect(hasNextIncident(ctx)).toBe(true);
    expect(ctx._shared.get("current_sn_incident").number).toBe("INC001");
    expect(ctx._shared.get("_sn_incident_queue")).toHaveLength(1);
  });

  test("returns false when queue is empty", () => {
    const ctx = makeCtx([]);
    expect(hasNextIncident(ctx)).toBe(false);
  });

  test("drains the full queue in order", () => {
    const incidents = [{ number: "A" }, { number: "B" }, { number: "C" }];
    const ctx       = makeCtx(incidents);
    const seen      = [];
    while (hasNextIncident(ctx)) {
      seen.push(ctx._shared.get("current_sn_incident").number);
    }
    expect(seen).toEqual(["A", "B", "C"]);
  });
});

describe("isHighPriority (sync resolver)", () => {
  let isHighPriority;

  beforeAll(async () => {
    const mod      = await import("../resolvers/sync.js");
    isHighPriority = mod.isHighPriority;
  });

  const ctx = { input: {}, meta: {} };

  test("priority 1 is high", () => expect(isHighPriority(ctx, "1")).toBe(true));
  test("priority 2 is high", () => expect(isHighPriority(ctx, "2")).toBe(true));
  test("priority 3 is not high", () => expect(isHighPriority(ctx, "3")).toBe(false));
  test("priority 5 is not high", () => expect(isHighPriority(ctx, "5")).toBe(false));
});
