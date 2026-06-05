/**
 * test/handle-jira-issue.test.js
 *
 * Tests for the Jira → ServiceNow inbound integration.
 * Uses mocked fetch — no live credentials required.
 * The listener is not started — processes are exercised directly via boot().
 */

import { resolve as resolvePath } from "path";
import { fileURLToPath }          from "url";
import { readFile }               from "fs/promises";

const __dirname = resolvePath(fileURLToPath(import.meta.url), "..");
const CWD       = resolvePath(__dirname, "..");

// Set env before imports
process.env.SN_BASE_URL           = "https://devXXXXX.service-now.com";
process.env.SN_USER               = "test-user";
process.env.SN_PASS               = "test-pass";
process.env.JIRA_WEBHOOK_SECRET   = "test-secret";
process.env.LOG_LEVEL             = "error";

// ── Helpers ───────────────────────────────────────────────────────────────────

async function loadFixture() {
  const raw = await readFile(
    resolvePath(CWD, "test/fixtures/jira-issue-created.json"),
    "utf-8"
  );
  return JSON.parse(raw);
}

function mockFetch(snResponse = { result: { sys_id: "abc123", number: "INC0010001" } }) {
  let calls = 0;
  globalThis.fetch = async (url, opts) => {
    calls++;
    return {
      ok:     true,
      status: 201,
      json:   async () => snResponse,
    };
  };
  return { getCalls: () => calls };
}

// ── Resolver unit tests ───────────────────────────────────────────────────────

describe("mapJiraToSn (itsm-maps resolver)", () => {
  let mapJiraToSn, extractAtlassianText;

  beforeAll(async () => {
    const mod         = await import("../resolvers/itsm-maps.js");
    mapJiraToSn       = mod.mapJiraToSn;
    extractAtlassianText = mod.extractAtlassianText;
  });

  const makeCtx = () => ({
    input:   {},
    output:  {},
    _shared: { set: () => {}, get: () => {} },
    logger:  { info: () => {}, warn: () => {}, error: () => {} },
    meta:    {},
  });

  test("maps summary to short_description", async () => {
    const fixture = await loadFixture();
    const result  = mapJiraToSn(makeCtx(), fixture.issue);
    expect(result.short_description).toBe(fixture.issue.fields.summary);
  });

  test("maps Jira High priority to SN urgency 2", async () => {
    const fixture = await loadFixture();
    const result  = mapJiraToSn(makeCtx(), fixture.issue);
    expect(result.urgency).toBe("2");
  });

  test("maps Bug issuetype to software category", async () => {
    const fixture = await loadFixture();
    const result  = mapJiraToSn(makeCtx(), fixture.issue);
    expect(result.category).toBe("software");
  });

  test("stores Jira key as correlation_id", async () => {
    const fixture = await loadFixture();
    const result  = mapJiraToSn(makeCtx(), fixture.issue);
    expect(result.correlation_id).toBe("OPS-42");
  });

  test("defaults urgency to 3 for unknown priority", () => {
    const issue = { key: "OPS-1", fields: { summary: "Test", issuetype: { name: "Bug" }, priority: { name: "Whatever" } } };
    const result = mapJiraToSn(makeCtx(), issue);
    expect(result.urgency).toBe("3");
  });
});

describe("extractAtlassianText", () => {
  let extractAtlassianText;

  beforeAll(async () => {
    const mod = await import("../resolvers/itsm-maps.js");
    extractAtlassianText = mod.extractAtlassianText;
  });

  test("extracts text from ADF paragraph node", () => {
    const adf = {
      type: "doc",
      content: [{
        type: "paragraph",
        content: [{ type: "text", text: "Hello world" }]
      }]
    };
    expect(extractAtlassianText(adf)).toBe("Hello world");
  });

  test("extracts and joins text from multiple paragraphs", () => {
    const adf = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "First." }] },
        { type: "paragraph", content: [{ type: "text", text: "Second." }] },
      ]
    };
    expect(extractAtlassianText(adf)).toContain("First.");
    expect(extractAtlassianText(adf)).toContain("Second.");
  });

  test("returns null for null input", () => {
    expect(extractAtlassianText(null)).toBeNull();
  });

  test("handles plain string passthrough", () => {
    expect(extractAtlassianText("plain text")).toBe("plain text");
  });
});

describe("isSupportedEvent (handler resolver)", () => {
  let isSupportedEvent;

  beforeAll(async () => {
    const mod = await import("../resolvers/handler.js");
    isSupportedEvent = mod.isSupportedEvent;
  });

  const ctx = { input: {}, meta: {}, logger: { warn: () => {} } };

  test("returns true for jira:issue_created", () => {
    expect(isSupportedEvent(ctx, "jira:issue_created")).toBe(true);
  });

  test("returns true for jira:issue_updated", () => {
    expect(isSupportedEvent(ctx, "jira:issue_updated")).toBe(true);
  });

  test("returns false for jira:issue_deleted", () => {
    expect(isSupportedEvent(ctx, "jira:issue_deleted")).toBe(false);
  });

  test("returns false for unknown events", () => {
    expect(isSupportedEvent(ctx, "something:unknown")).toBe(false);
  });
});

// ── Process-level tests ───────────────────────────────────────────────────────

describe("handle-jira-issue (process)", () => {
  let boot;

  beforeAll(async () => {
    const mod = await import("@int3gra/engine");
    boot = mod.boot;
  });

  afterEach(() => { globalThis.fetch = undefined; });

  test("creates a ServiceNow incident from a Jira issue-created event", async () => {
    const fixture      = await loadFixture();
    const { getCalls } = mockFetch();

    const result = await boot(CWD, {
      processId:     "handle-jira-issue",
      inputOverride: { payload: fixture, query: {}, headers: {} },
    });

    expect(getCalls()).toBe(1);
    expect(result.shared.sn_created_incident).toBeDefined();
    expect(result.shared.sn_created_incident.result.number).toBe("INC0010001");
  });

  test("maps Jira summary to SN short_description", async () => {
    const fixture = await loadFixture();
    mockFetch();

    const result = await boot(CWD, {
      processId:     "handle-jira-issue",
      inputOverride: { payload: fixture, query: {}, headers: {} },
    });

    expect(result.shared.sn_incident_payload.short_description)
      .toBe(fixture.issue.fields.summary);
  });

  test("builds an http_response in shared space", async () => {
    const fixture = await loadFixture();
    mockFetch();

    const result = await boot(CWD, {
      processId:     "handle-jira-issue",
      inputOverride: { payload: fixture, query: {}, headers: {} },
    });

    expect(result.shared.http_response).toBeDefined();
    expect(result.shared.http_response.body.ok).toBe(true);
    expect(result.shared.http_response.body.sn_number).toBe("INC0010001");
  });

  test("skips SN create for unsupported event type", async () => {
    const fixture     = await loadFixture();
    const { getCalls } = mockFetch();
    fixture.webhookEvent = "jira:issue_deleted";

    const result = await boot(CWD, {
      processId:     "handle-jira-issue",
      inputOverride: { payload: fixture, query: {}, headers: {} },
    });

    expect(getCalls()).toBe(0);
    expect(result.shared.http_response.body.ok).toBe(false);
    expect(result.shared.http_response.body.reason).toBe("unsupported_event");
  });

  test("http_response reflects correlation_id from Jira key", async () => {
    const fixture = await loadFixture();
    mockFetch();

    const result = await boot(CWD, {
      processId:     "handle-jira-issue",
      inputOverride: { payload: fixture, query: {}, headers: {} },
    });

    expect(result.shared.sn_incident_payload.correlation_id).toBe("OPS-42");
  });
});
