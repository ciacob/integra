/**
 * test/e2e-listener.test.js
 *
 * End-to-end test for the example-jira-sn listener integration.
 *
 * Unlike the unit tests in handle-jira-issue.test.js, this suite starts the
 * real Fastify server, fires genuine HTTP requests at it, and asserts on both
 * the HTTP response and the side effects (ServiceNow was called correctly).
 *
 * What is exercised end-to-end:
 *   - boot() starts Fastify on a real port
 *   - HMAC signature verification (correct and incorrect)
 *   - Payload schema validation (valid and invalid)
 *   - Full process execution (map → outbound SN connection)
 *   - http_response built by the process returned as the HTTP response body
 *   - /_health endpoint
 *   - Fastify shuts down cleanly after the tests
 *
 * The outbound ServiceNow call is mocked via globalThis.fetch.
 * Port 3101 is used to avoid clashing with a manually running listener on 3100.
 */

import { createHmac }    from "crypto";
import { readFile }      from "fs/promises";
import { resolve as resolvePath } from "path";
import { fileURLToPath } from "url";

const __dirname = resolvePath(fileURLToPath(import.meta.url), "..");
const CWD       = resolvePath(__dirname, "..");

// Port offset so this suite never conflicts with the default listener port
const E2E_PORT   = 3101;

// Preserve real fetch before any mocking — used by postWebhook to call the listener
const realFetch = globalThis.fetch;
const SECRET     = "e2e-test-secret";
const LISTEN_URL = `http://localhost:${E2E_PORT}`;

// Set env before any engine imports
process.env.SN_BASE_URL           = "https://devXXXXX.service-now.com";
process.env.SN_USER               = "test-user";
process.env.SN_PASS               = "test-pass";
process.env.JIRA_WEBHOOK_SECRET   = SECRET;
process.env.LOG_LEVEL             = "error";

// ── Helpers ───────────────────────────────────────────────────────────────────

async function loadFixture() {
  const raw = await readFile(
    resolvePath(CWD, "test/fixtures/jira-issue-created.json"),
    "utf-8"
  );
  return JSON.parse(raw);
}

/**
 * Signs a payload string with HMAC-SHA256 and returns the full header value.
 */
function sign(payloadStr, secret = SECRET) {
  return "sha256=" + createHmac("sha256", secret).update(payloadStr).digest("hex");
}

/**
 * Fires a signed POST to the listener. Returns the fetch Response.
 */
async function postWebhook(payload, options = {}) {
  const body      = JSON.stringify(payload);
  const signature = options.signature ?? sign(body);
  // Always use the real (pre-mock) fetch to call the listener
  const fetchFn   = options.fetchFn ?? realFetch;

  return fetchFn(`${LISTEN_URL}/hooks/jira`, {
    method:  "POST",
    headers: {
      "Content-Type":        "application/json",
      "X-Hub-Signature-256": signature,
      ...(options.extraHeaders ?? {}),
    },
    body,
  });
}

// ── Suite setup / teardown ────────────────────────────────────────────────────

describe("Listener E2E — example-jira-sn", () => {
  let fastify;
  let boot;


  beforeAll(async () => {
    const mod = await import("@integra/engine");
    boot = mod.boot;

    // Override the port so this suite doesn't clash with the default 3100
    // We patch the env that resolveEnvInObject reads when building httpServer config.
    // The simplest approach: temporarily monkey-patch integra.json's port via a
    // custom manifest override. Since boot() reads integra.json directly, we pass
    // a port-patched env value instead. The listener resolves {{...}} from env,
    // so we inject a dedicated env var and reference it in a copy of the manifest.
    //
    // Simpler approach: start with a modified env that the httpServer port reads from.
    // integra.json has a hardcoded port 3101 check — but we want to use E2E_PORT.
    // Easiest: just read the real manifest and patch it before calling startListener.
    //
    // Actually simplest: boot() accepts options, and we can pass a port override
    // by temporarily setting a dedicated env var that the httpServer.port references.
    // For now, we rely on the fact that integra.json has port 3100 and we use 3101
    // by passing a patched manifest. Let's use the cleanest path: pass options.port.
    //
    // The cleanest path given current boot() API: override JIRA_LISTENER_PORT env var
    // and reference it in a separate test integra.json. But that's too much friction.
    //
    // Instead: accept that boot() needs an options.port override for testing.
    // We add that in a minimal, non-breaking way below.

    fastify = await boot(CWD, { listenerPort: E2E_PORT });
  }, 15000);

  afterAll(async () => {
    if (fastify?.close) await fastify.close();
    globalThis.fetch = undefined;
  });

  // ── Health check ────────────────────────────────────────────────────────────

  test("/_health returns ok", async () => {
    const res  = await realFetch(`${LISTEN_URL}/_health`);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.integration).toBe("example-jira-sn");
  });

  // ── Authentication ──────────────────────────────────────────────────────────

  test("rejects request with missing signature — 401", async () => {
    const fixture = await loadFixture();
    const res = await realFetch(`${LISTEN_URL}/hooks/jira`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(fixture),
    });
    expect(res.status).toBe(401);
  });

  test("rejects request with wrong signature — 401", async () => {
    const fixture = await loadFixture();
    const res = await postWebhook(fixture, { signature: "sha256=deadbeef" + "0".repeat(56) });
    expect(res.status).toBe(401);
  });

  // ── Schema validation ───────────────────────────────────────────────────────

  test("rejects payload missing required fields — 400", async () => {
    // Missing both 'webhookEvent' and 'issue'
    const res = await postWebhook({ random: "data" });
    expect(res.status).toBe(400);
  });

  test("rejects payload missing issue.fields — 400", async () => {
    const res = await postWebhook({
      webhookEvent: "jira:issue_created",
      issue:        { id: "1", key: "OPS-1" },   // missing fields
    });
    expect(res.status).toBe(400);
  });

  // ── Happy path ──────────────────────────────────────────────────────────────

  test("processes a valid issue_created event and returns 200 with SN number", async () => {
    const fixture = await loadFixture();

    // Mock outbound SN call
    let snCallCount = 0;
    let snRequestBody;
    globalThis.fetch = async (url, opts) => {
      if (url.includes("service-now")) {
        snCallCount++;
        snRequestBody = JSON.parse(opts.body);
        return { ok: true, status: 201, json: async () => ({ result: { sys_id: "sys-abc", number: "INC9999" } }) };
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };

    const res  = await postWebhook(fixture);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.sn_number).toBe("INC9999");
    expect(snCallCount).toBe(1);
    expect(snRequestBody.short_description).toBe(fixture.issue.fields.summary);
  });

  test("maps Jira High priority to SN urgency 2 in the outbound payload", async () => {
    const fixture = await loadFixture();  // priority: High

    let snPayload;
    globalThis.fetch = async (url, opts) => {
      snPayload = JSON.parse(opts.body);
      return { ok: true, status: 201, json: async () => ({ result: { sys_id: "x", number: "INC1" } }) };
    };

    await postWebhook(fixture);
    expect(snPayload.urgency).toBe("2");
  });

  test("stores Jira issue key as correlation_id in SN payload", async () => {
    const fixture = await loadFixture();  // key: OPS-42

    let snPayload;
    globalThis.fetch = async (url, opts) => {
      snPayload = JSON.parse(opts.body);
      return { ok: true, status: 201, json: async () => ({ result: { sys_id: "x", number: "INC1" } }) };
    };

    await postWebhook(fixture);
    expect(snPayload.correlation_id).toBe("OPS-42");
  });

  // ── Unsupported event ───────────────────────────────────────────────────────

  test("acknowledges unsupported event without calling SN", async () => {
    const fixture = { ...await loadFixture(), webhookEvent: "jira:issue_deleted" };

    let snCalled = false;
    globalThis.fetch = async () => { snCalled = true; return {}; };

    const res  = await postWebhook(fixture);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("unsupported_event");
    expect(snCalled).toBe(false);
  });

  // ── Error path ──────────────────────────────────────────────────────────────

  test("returns 500 when SN call fails", async () => {
    const fixture = await loadFixture();

    globalThis.fetch = async () => ({
      ok:          false,
      status:      500,
      statusText:  "Internal Server Error",
      json:        async () => ({}),
    });

    const res = await postWebhook(fixture);
    expect(res.status).toBe(500);
  });
});
