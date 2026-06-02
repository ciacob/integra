/**
 * test/sync-process.test.js
 * Tests for the ServiceNow → Jira sync integration.
 * Uses mocked fetch — no live credentials required.
 *
 * Run from monorepo root: node --experimental-vm-modules node_modules/.bin/jest
 */

import { resolve as resolvePath } from "path";
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

// ── Fixtures ────────────────────────────────────────────────────────────────

const SN_TWO_INCIDENTS = {
  result: [
    {
      sys_id: "abc", number: "INC001",
      short_description: "Printer on fire", description: "3rd floor",
      state: "1", priority: "2", category: "hardware",
      assigned_to: "john", opened_at: "2026-01-01",
    },
    {
      sys_id: "def", number: "INC002",
      short_description: "VPN down", description: "Since 8am",
      state: "2", priority: "1", category: "network",
      assigned_to: "jane", opened_at: "2026-01-01",
    },
  ],
};

const SN_EMPTY = { result: [] };

// ── Helpers ──────────────────────────────────────────────────────────────────

function mockFetch(snFixture) {
  let jiraCallCount = 0;
  const jiraCreated = [];

  global.fetch = async (url, opts) => {
    if (url.includes("service-now.com")) {
      return { ok: true, status: 200, json: async () => snFixture };
    }
    if (url.includes("atlassian.net")) {
      jiraCallCount++;
      const body = opts?.body ? JSON.parse(opts.body) : {};
      jiraCreated.push({ key: `OPS-${jiraCallCount}`, summary: body?.fields?.summary, priority: body?.fields?.priority?.name });
      return { ok: true, status: 201, json: async () => ({ id: `1000${jiraCallCount}`, key: `OPS-${jiraCallCount}` }) };
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  return { getCount: () => jiraCallCount, getCreated: () => jiraCreated };
}

// ── Process-level tests ───────────────────────────────────────────────────────

describe("sync-incident-sn-to-jira (process)", () => {
  let boot;

  beforeAll(async () => {
    const mod = await import("@integra/engine");
    boot = mod.boot;
  });

  afterEach(() => { global.fetch = undefined; });

  test("creates one Jira issue per ServiceNow incident", async () => {
    const { getCount, getCreated } = mockFetch(SN_TWO_INCIDENTS);

    const result = await boot(CWD, { processId: "sync-incident-sn-to-jira" });

    expect(getCount()).toBe(2);
    expect(result.shared.sn_incidents.result).toHaveLength(2);

    const summaries = getCreated().map(i => i.summary);
    expect(summaries).toContain("Printer on fire");
    expect(summaries).toContain("VPN down");
  });

  test("maps SN priority 1 to Jira Highest", async () => {
    const { getCreated } = mockFetch(SN_TWO_INCIDENTS);
    await boot(CWD, { processId: "sync-incident-sn-to-jira" });

    const vpn = getCreated().find(i => i.summary === "VPN down");
    expect(vpn?.priority).toBe("Highest");
  });

  test("maps SN priority 2 to Jira High", async () => {
    const { getCreated } = mockFetch(SN_TWO_INCIDENTS);
    await boot(CWD, { processId: "sync-incident-sn-to-jira" });

    const printer = getCreated().find(i => i.summary === "Printer on fire");
    expect(printer?.priority).toBe("High");
  });

  test("handles empty incident list gracefully — no Jira calls", async () => {
    const { getCount } = mockFetch(SN_EMPTY);
    const result = await boot(CWD, { processId: "sync-incident-sn-to-jira" });

    expect(getCount()).toBe(0);
    expect(result).toBeDefined();
  });

  test("writes a structured run summary to shared space", async () => {
    mockFetch(SN_TWO_INCIDENTS);
    const result = await boot(CWD, { processId: "sync-incident-sn-to-jira" });

    const summary = result.shared.sync_result;
    expect(summary).toBeDefined();
    expect(summary.incidents_fetched).toBe(2);
    expect(summary.issues_created).toBe(2);
    expect(summary.issues_skipped).toBe(0);
    expect(summary.completed_at).toBeTruthy();
  });

  test("run summary reflects skipped incidents when create errors are swallowed", async () => {
    let callCount = 0;
    global.fetch = async (url, opts) => {
      if (url.includes("service-now.com")) {
        return { ok: true, status: 200, json: async () => SN_TWO_INCIDENTS };
      }
      callCount++;
      // First Jira call succeeds, second fails
      if (callCount === 1) {
        return { ok: true, status: 201, json: async () => ({ id: "1", key: "OPS-1" }) };
      }
      return { ok: false, status: 500, statusText: "Internal Server Error",
               json: async () => ({}) };
    };

    const result = await boot(CWD, { processId: "sync-incident-sn-to-jira" });
    const summary = result.shared.sync_result;

    expect(summary.incidents_fetched).toBe(2);
    // One created, one errored (handleCreateError swallows it)
    expect(summary.issues_created).toBe(1);
    expect(summary.issues_skipped).toBe(1);
  });
});

// ── Resolver unit tests ───────────────────────────────────────────────────────

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
