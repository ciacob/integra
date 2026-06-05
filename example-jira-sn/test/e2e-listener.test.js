/**
 * test/e2e-listener.test.js
 *
 * End-to-end test for the example-jira-sn listener integration.
 * Starts the real Fastify server, fires genuine HTTP requests at it,
 * and asserts on both the HTTP response and side effects.
 *
 * Outbound SN calls are intercepted using fixture files from
 * test/fixtures/responses/ — the same files `integra test` uses.
 * Webhook payloads are loaded from test/fixtures/webhooks/.
 *
 * This suite exercises the full stack:
 *   HMAC verification → schema validation → process execution →
 *   outbound connection (fixture) → http_response → HTTP response body
 *
 * Port 3101 avoids clashing with a manually running listener on 3100.
 */

import { createHmac }             from "crypto";
import { readFile }               from "fs/promises";
import { resolve as resolvePath } from "path";
import { fileURLToPath }          from "url";

const __dirname  = resolvePath(fileURLToPath(import.meta.url), "..");
const CWD        = resolvePath(__dirname, "..");
const E2E_PORT   = 3101;
const SECRET     = "e2e-test-secret";
const LISTEN_URL = `http://localhost:${E2E_PORT}`;

// Preserve real fetch before any mocking
const realFetch = globalThis.fetch;

// Set env before any engine imports
process.env.SN_BASE_URL           = "https://devXXXXX.service-now.com";
process.env.SN_USER               = "test-user";
process.env.SN_PASS               = "test-pass";
process.env.JIRA_WEBHOOK_SECRET   = SECRET;
process.env.LOG_LEVEL             = "error";

// ── Fixture loading ───────────────────────────────────────────────────────────

async function loadWebhookFixture(name) {
  const raw = await readFile(resolvePath(CWD, "test/fixtures/webhooks", name), "utf-8");
  return JSON.parse(raw);
}

async function loadResponseFixture(name) {
  const raw = await readFile(resolvePath(CWD, "test/fixtures/responses", name), "utf-8");
  const { _mockStatus, ...body } = JSON.parse(raw);
  return { body, status: _mockStatus ?? 200 };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sign(payloadStr, secret = SECRET) {
  return "sha256=" + createHmac("sha256", secret).update(payloadStr).digest("hex");
}

async function postWebhook(payload, options = {}) {
  const body      = JSON.stringify(payload);
  const signature = options.signature ?? sign(body);
  return realFetch(`${LISTEN_URL}/hooks/jira`, {
    method:  "POST",
    headers: {
      "Content-Type":        "application/json",
      "X-Hub-Signature-256": signature,
      ...(options.extraHeaders ?? {}),
    },
    body,
  });
}

/**
 * Installs a fetch mock that serves the SN response fixture.
 * Optionally accepts overrides for error-path testing.
 */
async function mockSnFetch(override = null) {
  const { body, status } = await loadResponseFixture("sn-create-incident-201.json");
  globalThis.fetch = async (url, opts) => {
    if (override) return override(url, opts);
    return { ok: status < 400, status, json: async () => body };
  };
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe("Listener E2E — example-jira-sn", () => {
  let fastify;
  let boot;

  beforeAll(async () => {
    const mod = await import("@integra/engine");
    boot      = mod.boot;
    fastify   = await boot(CWD, { listenerPort: E2E_PORT });
  }, 15000);

  afterAll(async () => {
    if (fastify?.close) await fastify.close();
    globalThis.fetch = undefined;
  });

  afterEach(() => {
    globalThis.fetch = undefined;
  });

  // ── Health check ──────────────────────────────────────────────────────────

  test("/_health returns ok", async () => {
    const res  = await realFetch(`${LISTEN_URL}/_health`);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.integration).toBe("example-jira-sn");
  });

  // ── Authentication ────────────────────────────────────────────────────────

  test("rejects request with missing signature — 401", async () => {
    const payload = await loadWebhookFixture("jira-issue-created.json");
    const res = await realFetch(`${LISTEN_URL}/hooks/jira`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(payload),
    });
    expect(res.status).toBe(401);
  });

  test("rejects request with wrong signature — 401", async () => {
    const payload = await loadWebhookFixture("jira-issue-created.json");
    const res = await postWebhook(payload, { signature: "sha256=deadbeef" + "0".repeat(56) });
    expect(res.status).toBe(401);
  });

  // ── Schema validation ─────────────────────────────────────────────────────

  test("rejects payload missing required fields — 400", async () => {
    const res = await postWebhook({ random: "data" });
    expect(res.status).toBe(400);
  });

  test("rejects payload missing issue.fields — 400", async () => {
    const res = await postWebhook({
      webhookEvent: "jira:issue_created",
      issue:        { id: "1", key: "OPS-1" },
    });
    expect(res.status).toBe(400);
  });

  // ── Happy path ────────────────────────────────────────────────────────────

  test("processes a valid issue_created event and returns 200 with SN number", async () => {
    const payload = await loadWebhookFixture("jira-issue-created.json");
    await mockSnFetch();

    const res  = await postWebhook(payload);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    // The fixture returns INC0099001
    expect(body.sn_number).toBe("INC0099001");
  });

  test("summary contains the Jira issue summary as SN short_description", async () => {
    const payload    = await loadWebhookFixture("jira-issue-created.json");
    let   snPayload;
    globalThis.fetch = async (url, opts) => {
      snPayload = JSON.parse(opts.body);
      const { body, status } = await loadResponseFixture("sn-create-incident-201.json");
      return { ok: true, status, json: async () => body };
    };

    await postWebhook(payload);
    expect(snPayload.short_description).toBe(payload.issue.fields.summary);
  });

  test("maps Jira High priority to SN urgency 2", async () => {
    const payload    = await loadWebhookFixture("jira-issue-created.json");  // priority: High
    let   snPayload;
    globalThis.fetch = async (url, opts) => {
      snPayload = JSON.parse(opts.body);
      const { body, status } = await loadResponseFixture("sn-create-incident-201.json");
      return { ok: true, status, json: async () => body };
    };

    await postWebhook(payload);
    expect(snPayload.urgency).toBe("2");
  });

  test("stores Jira issue key as correlation_id", async () => {
    const payload    = await loadWebhookFixture("jira-issue-created.json");  // key: OPS-42
    let   snPayload;
    globalThis.fetch = async (url, opts) => {
      snPayload = JSON.parse(opts.body);
      const { body, status } = await loadResponseFixture("sn-create-incident-201.json");
      return { ok: true, status, json: async () => body };
    };

    await postWebhook(payload);
    expect(snPayload.correlation_id).toBe("OPS-42");
  });

  // ── Unsupported event ─────────────────────────────────────────────────────

  test("acknowledges unsupported event without calling SN", async () => {
    const payload = {
      ...await loadWebhookFixture("jira-issue-created.json"),
      webhookEvent: "jira:issue_deleted",
    };

    let snCalled = false;
    globalThis.fetch = async () => { snCalled = true; return {}; };

    const res  = await postWebhook(payload);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("unsupported_event");
    expect(snCalled).toBe(false);
  });

  // ── Error path ────────────────────────────────────────────────────────────

  test("returns 500 when SN call fails", async () => {
    const payload = await loadWebhookFixture("jira-issue-created.json");
    await mockSnFetch(async () => ({
      ok:         false,
      status:     500,
      statusText: "Internal Server Error",
      json:       async () => ({}),
    }));

    const res = await postWebhook(payload);
    expect(res.status).toBe(500);
  });
});
