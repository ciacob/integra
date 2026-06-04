/**
 * packages/engine/test/listener.test.js
 *
 * Unit tests for listener.js pure helpers and authUtilities.verifyHmacSignature.
 * No Fastify server is started — only the pure functions are tested.
 */

import {
  resolveEnvPlaceholders,
  resolveEnvInObject,
  verifyInboundAuth,
  buildRequestInput,
} from "../src/listener.js";

import {
  verifyHmacSignature,
} from "../src/authUtilities.js";

import { createHmac } from "crypto";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeHmacSignature(payload, secret, algorithm = "sha256") {
  const hmac = createHmac(algorithm, secret);
  hmac.update(payload);
  return hmac.digest("hex");
}

// ── resolveEnvPlaceholders ────────────────────────────────────────────────────

describe("resolveEnvPlaceholders", () => {
  const env = { HOST: "example.com", PORT: "3000", SECRET: "mysecret" };

  test("replaces a single placeholder", () => {
    expect(resolveEnvPlaceholders("{{env.HOST}}", env)).toBe("example.com");
  });

  test("replaces multiple placeholders in one string", () => {
    expect(resolveEnvPlaceholders("{{env.HOST}}:{{env.PORT}}", env)).toBe("example.com:3000");
  });

  test("leaves non-placeholder strings unchanged", () => {
    expect(resolveEnvPlaceholders("/hooks/jira", env)).toBe("/hooks/jira");
  });

  test("replaces missing env key with empty string", () => {
    expect(resolveEnvPlaceholders("{{env.MISSING}}", env)).toBe("");
  });

  test("passes non-string values through unchanged", () => {
    expect(resolveEnvPlaceholders(3000, env)).toBe(3000);
    expect(resolveEnvPlaceholders(null, env)).toBeNull();
  });
});

// ── resolveEnvInObject ────────────────────────────────────────────────────────

describe("resolveEnvInObject", () => {
  const env = { PORT: "3000", SECRET: "s3cr3t", PATH: "/hooks" };

  test("resolves placeholders in a flat object", () => {
    const result = resolveEnvInObject({ port: "{{env.PORT}}", path: "{{env.PATH}}" }, env);
    expect(result).toEqual({ port: "3000", path: "/hooks" });
  });

  test("resolves placeholders in nested objects", () => {
    const result = resolveEnvInObject(
      { auth: { secret: "{{env.SECRET}}" } }, env
    );
    expect(result.auth.secret).toBe("s3cr3t");
  });

  test("passes numeric values through unchanged", () => {
    const result = resolveEnvInObject({ port: 3000 }, env);
    expect(result.port).toBe(3000);
  });

  test("does not mutate the input object", () => {
    const input    = { port: "{{env.PORT}}" };
    const original = { ...input };
    resolveEnvInObject(input, env);
    expect(input).toEqual(original);
  });

  test("returns null/undefined gracefully", () => {
    expect(resolveEnvInObject(null, env)).toBeNull();
    expect(resolveEnvInObject(undefined, env)).toBeUndefined();
  });
});

// ── verifyHmacSignature ───────────────────────────────────────────────────────

describe("verifyHmacSignature", () => {
  const SECRET  = "webhook-secret";
  const PAYLOAD = "hello world";

  test("returns true for a valid signature", () => {
    const sig = makeHmacSignature(PAYLOAD, SECRET);
    expect(verifyHmacSignature(PAYLOAD, sig, SECRET)).toBe(true);
  });

  test("returns true when signature has sha256= prefix", () => {
    const sig = "sha256=" + makeHmacSignature(PAYLOAD, SECRET);
    expect(verifyHmacSignature(PAYLOAD, sig, SECRET)).toBe(true);
  });

  test("returns false for a wrong secret", () => {
    const sig = makeHmacSignature(PAYLOAD, "wrong-secret");
    expect(verifyHmacSignature(PAYLOAD, sig, SECRET)).toBe(false);
  });

  test("returns false for a tampered payload", () => {
    const sig = makeHmacSignature(PAYLOAD, SECRET);
    expect(verifyHmacSignature("tampered payload", sig, SECRET)).toBe(false);
  });

  test("throws for empty signature string", () => {
    // Empty string fails the required-arg check before any comparison
    expect(() => verifyHmacSignature(PAYLOAD, "", SECRET)).toThrow();
  });

  test("accepts Buffer payload", () => {
    const buf = Buffer.from(PAYLOAD, "utf-8");
    const sig = makeHmacSignature(buf, SECRET);
    expect(verifyHmacSignature(buf, sig, SECRET)).toBe(true);
  });

  test("works with sha1 algorithm", () => {
    const sig = makeHmacSignature(PAYLOAD, SECRET, "sha1");
    expect(verifyHmacSignature(PAYLOAD, sig, SECRET, "sha1")).toBe(true);
  });

  test("uses injectable crypto module", () => {
    const calls   = [];
    const fakeCrypto = {
      createHmac: (alg, key) => {
        calls.push({ alg, key });
        return createHmac(alg, key); // real implementation
      },
      timingSafeEqual: (a, b) => a.equals(b),
    };
    const sig = makeHmacSignature(PAYLOAD, SECRET);
    verifyHmacSignature(PAYLOAD, sig, SECRET, "sha256", fakeCrypto);
    expect(calls[0].alg).toBe("sha256");
    expect(calls[0].key).toBe(SECRET);
  });

  test("throws when payload is missing", () => {
    expect(() => verifyHmacSignature("", "sig", SECRET)).toThrow("payload");
  });

  test("throws when signature is missing", () => {
    expect(() => verifyHmacSignature(PAYLOAD, "", SECRET)).toThrow();
  });

  test("throws when secret is missing", () => {
    expect(() => verifyHmacSignature(PAYLOAD, "sig", "")).toThrow("secret");
  });
});

// ── verifyInboundAuth ─────────────────────────────────────────────────────────

describe("verifyInboundAuth", () => {
  const SECRET  = "webhook-secret";
  const PAYLOAD = Buffer.from("test body");

  test("returns true when auth config is null (trust all)", () => {
    expect(verifyInboundAuth(null, PAYLOAD, {})).toBe(true);
  });

  test("returns true when auth config has no type", () => {
    expect(verifyInboundAuth({}, PAYLOAD, {})).toBe(true);
  });

  describe("hmac", () => {
    test("returns true for valid signature in correct header", () => {
      const sig     = makeHmacSignature(PAYLOAD, SECRET);
      const headers = { "x-hub-signature-256": sig };
      expect(verifyInboundAuth({ type: "hmac", secret: SECRET }, PAYLOAD, headers)).toBe(true);
    });

    test("returns false when signature header is absent", () => {
      expect(verifyInboundAuth({ type: "hmac", secret: SECRET }, PAYLOAD, {})).toBe(false);
    });

    test("returns false for wrong signature", () => {
      const headers = { "x-hub-signature-256": "badsignature00000000000000000000000000000000000000000000000000000000" };
      expect(verifyInboundAuth({ type: "hmac", secret: SECRET }, PAYLOAD, headers)).toBe(false);
    });

    test("uses custom header name when specified", () => {
      const sig     = makeHmacSignature(PAYLOAD, SECRET);
      const headers = { "x-my-signature": sig };
      expect(
        verifyInboundAuth({ type: "hmac", secret: SECRET, header: "X-My-Signature" }, PAYLOAD, headers)
      ).toBe(true);
    });
  });

  describe("bearer_token", () => {
    test("returns true for matching bearer token", () => {
      const headers = { authorization: "Bearer my-secret-token" };
      expect(verifyInboundAuth({ type: "bearer_token", token: "my-secret-token" }, PAYLOAD, headers)).toBe(true);
    });

    test("returns false for wrong token", () => {
      const headers = { authorization: "Bearer wrong-token" };
      expect(verifyInboundAuth({ type: "bearer_token", token: "my-secret-token" }, PAYLOAD, headers)).toBe(false);
    });

    test("returns false when Authorization header is absent", () => {
      expect(verifyInboundAuth({ type: "bearer_token", token: "my-secret-token" }, PAYLOAD, {})).toBe(false);
    });
  });

  test("throws for unknown auth type", () => {
    expect(() => verifyInboundAuth({ type: "magic" }, PAYLOAD, {})).toThrow("Unsupported inbound auth type");
  });
});

// ── buildRequestInput ────────────────────────────────────────────────────────

describe("buildRequestInput", () => {
  function makeRequest(overrides = {}) {
    return {
      body:    { issue: { id: "INC-1", summary: "Test" } },
      query:   { token: "abc", event: "issue_created" },
      headers: { "x-event-type": "issue_created", "content-type": "application/json" },
      rawBody: Buffer.from('{"issue":{"id":"INC-1"}}'),
      ...overrides,
    };
  }

  test("includes payload from request.body", () => {
    const input = buildRequestInput(makeRequest());
    expect(input.payload).toEqual({ issue: { id: "INC-1", summary: "Test" } });
  });

  test("includes query params from request.query", () => {
    const input = buildRequestInput(makeRequest());
    expect(input.query.token).toBe("abc");
    expect(input.query.event).toBe("issue_created");
  });

  test("includes headers from request.headers", () => {
    const input = buildRequestInput(makeRequest());
    expect(input.headers["x-event-type"]).toBe("issue_created");
  });

  test("includes rawBody from request.rawBody", () => {
    const input = buildRequestInput(makeRequest());
    expect(Buffer.isBuffer(input.rawBody)).toBe(true);
  });

  test("defaults to empty object for missing query", () => {
    const input = buildRequestInput(makeRequest({ query: undefined }));
    expect(input.query).toEqual({});
  });

  test("defaults to null for missing body", () => {
    const input = buildRequestInput(makeRequest({ body: undefined }));
    expect(input.payload).toBeNull();
  });

  test("defaults to null for missing rawBody", () => {
    const input = buildRequestInput(makeRequest({ rawBody: undefined }));
    expect(input.rawBody).toBeNull();
  });

  test("does not mutate the request object", () => {
    const req      = makeRequest();
    const origBody = req.body;
    buildRequestInput(req);
    expect(req.body).toBe(origBody);
  });

  test("query and payload are independently accessible", () => {
    const req = makeRequest({
      body:  { eventType: "created" },
      query: { source: "webhook" },
    });
    const input = buildRequestInput(req);
    expect(input.payload.eventType).toBe("created");
    expect(input.query.source).toBe("webhook");
  });
});

// ── resolveLifecycle (from descriptor.js) ────────────────────────────────────

describe("resolveLifecycle", () => {
  let resolveLifecycle;

  beforeAll(async () => {
    const mod      = await import("../../../packages/manager/src/descriptor.js");
    resolveLifecycle = mod.resolveLifecycle;
  });

  test("returns 'scheduled' when registry entry has schedule field", () => {
    expect(resolveLifecycle({ schedule: "*/5 * * * *" }, {})).toBe("scheduled");
  });

  test("returns 'listener' when integra.json declares it", () => {
    expect(resolveLifecycle({}, { lifecycle: "listener" })).toBe("listener");
  });

  test("schedule takes precedence over listener in manifest", () => {
    expect(resolveLifecycle({ schedule: "*/5 * * * *" }, { lifecycle: "listener" })).toBe("scheduled");
  });

  test("returns 'run-once' when neither schedule nor listener", () => {
    expect(resolveLifecycle({}, {})).toBe("run-once");
  });

  test("returns 'run-once' for empty manifest", () => {
    expect(resolveLifecycle({}, null)).toBe("run-once");
  });
});
