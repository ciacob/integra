/**
 * packages/engine/test/authUtilities.test.js
 *
 * Unit tests for authUtilities.js.
 * All I/O dependencies (fetch, storage, time) are injected — no real network calls.
 */

import {
  buildBasicAuthHeader,
  buildApiKeyHeader,
  buildBearerHeader,
  isTokenExpired,
  fetchClientCredentialsToken,
  getOrRefreshToken,
  resolveAuthHeaders,
} from "../src/authUtilities.js";

// ── buildBasicAuthHeader ──────────────────────────────────────────────────────

describe("buildBasicAuthHeader", () => {
  test("produces correct Base64 encoding", () => {
    const result = buildBasicAuthHeader("admin", "secret");
    const decoded = Buffer.from(result.replace("Basic ", ""), "base64").toString("utf-8");
    expect(decoded).toBe("admin:secret");
  });

  test("starts with 'Basic '", () => {
    expect(buildBasicAuthHeader("u", "p").startsWith("Basic ")).toBe(true);
  });

  test("handles special characters in password", () => {
    const result  = buildBasicAuthHeader("user", "p@$$w0rd!");
    const decoded = Buffer.from(result.replace("Basic ", ""), "base64").toString("utf-8");
    expect(decoded).toBe("user:p@$$w0rd!");
  });

  test("throws when user is missing", () => {
    expect(() => buildBasicAuthHeader("", "pass")).toThrow();
  });

  test("throws when pass is missing", () => {
    expect(() => buildBasicAuthHeader("user", "")).toThrow();
  });
});

// ── buildApiKeyHeader ─────────────────────────────────────────────────────────

describe("buildApiKeyHeader", () => {
  test("returns object with given header name and value", () => {
    expect(buildApiKeyHeader("X-API-Key", "my-key")).toEqual({ "X-API-Key": "my-key" });
  });

  test("works with Authorization header name", () => {
    expect(buildApiKeyHeader("Authorization", "ApiKey abc123")).toEqual({
      Authorization: "ApiKey abc123",
    });
  });

  test("throws when headerName is missing", () => {
    expect(() => buildApiKeyHeader("", "value")).toThrow();
  });

  test("throws when value is missing", () => {
    expect(() => buildApiKeyHeader("X-API-Key", "")).toThrow();
  });
});

// ── buildBearerHeader ─────────────────────────────────────────────────────────

describe("buildBearerHeader", () => {
  test("produces 'Bearer <token>'", () => {
    expect(buildBearerHeader("mytoken")).toBe("Bearer mytoken");
  });

  test("throws when token is missing", () => {
    expect(() => buildBearerHeader("")).toThrow();
  });
});

// ── isTokenExpired ────────────────────────────────────────────────────────────

describe("isTokenExpired", () => {
  const NOW = 1_700_000_000_000;

  test("returns true for null tokenRecord", () => {
    expect(isTokenExpired(null, 60, NOW)).toBe(true);
  });

  test("returns true when access_token is missing", () => {
    expect(isTokenExpired({ expires_in: 3600, obtained_at: NOW }, 60, NOW)).toBe(true);
  });

  test("returns true when expires_in is missing", () => {
    expect(isTokenExpired({ access_token: "t", obtained_at: NOW }, 60, NOW)).toBe(true);
  });

  test("returns true when obtained_at is missing", () => {
    expect(isTokenExpired({ access_token: "t", expires_in: 3600 }, 60, NOW)).toBe(true);
  });

  test("returns false for a fresh token within buffer", () => {
    const record = { access_token: "t", expires_in: 3600, obtained_at: NOW };
    // Token is brand new — expires in 3600s, buffer is 60s → 3540s remaining
    expect(isTokenExpired(record, 60, NOW)).toBe(false);
  });

  test("returns true when token is past expiry (ignoring buffer)", () => {
    const record = { access_token: "t", expires_in: 3600, obtained_at: NOW - 4000_000 };
    // Obtained 4000s ago, expires_in 3600s → already expired
    expect(isTokenExpired(record, 60, NOW)).toBe(true);
  });

  test("returns true when token is within buffer window", () => {
    // Buffer is 60s. Token expires in exactly 60s from now → should refresh.
    const obtainedAt = NOW - (3600 - 60) * 1000;
    const record     = { access_token: "t", expires_in: 3600, obtained_at: obtainedAt };
    expect(isTokenExpired(record, 60, NOW)).toBe(true);
  });

  test("returns false when token is just outside buffer window", () => {
    // Token expires in 61s → 1s outside buffer → still valid
    const obtainedAt = NOW - (3600 - 61) * 1000;
    const record     = { access_token: "t", expires_in: 3600, obtained_at: obtainedAt };
    expect(isTokenExpired(record, 60, NOW)).toBe(false);
  });

  test("buffer defaults to 60 seconds", () => {
    // Same as the 60s buffer test above but without explicit buffer arg
    const obtainedAt = NOW - (3600 - 60) * 1000;
    const record     = { access_token: "t", expires_in: 3600, obtained_at: obtainedAt };
    expect(isTokenExpired(record)).toBe(true);  // no nowMs → uses Date.now()... skip
    // Test with explicit NOW instead
    expect(isTokenExpired(record, undefined, NOW)).toBe(true);
  });
});

// ── fetchClientCredentialsToken ───────────────────────────────────────────────

describe("fetchClientCredentialsToken", () => {
  const PARAMS = {
    token_url:     "https://auth.example.com/token",
    client_id:     "my-client",
    client_secret: "my-secret",
  };
  const NOW = 1_700_000_000_000;

  function mockFetch(responseBody, status = 200) {
    return async () => ({
      ok:   status >= 200 && status < 300,
      status,
      json: async () => responseBody,
      text: async () => JSON.stringify(responseBody),
    });
  }

  test("returns token record with obtained_at set to nowMs", async () => {
    const fetchFn = mockFetch({ access_token: "tok", token_type: "Bearer", expires_in: 3600 });
    const result  = await fetchClientCredentialsToken(PARAMS, fetchFn, NOW);

    expect(result.access_token).toBe("tok");
    expect(result.obtained_at).toBe(NOW);
    expect(result.expires_in).toBe(3600);
    expect(result.token_type).toBe("Bearer");
  });

  test("sends correct grant_type in request body", async () => {
    let capturedBody;
    const fetchFn = async (url, opts) => {
      capturedBody = opts.body;
      return { ok: true, status: 200, json: async () => ({ access_token: "t", expires_in: 3600 }) };
    };

    await fetchClientCredentialsToken(PARAMS, fetchFn, NOW);
    expect(capturedBody).toContain("grant_type=client_credentials");
    expect(capturedBody).toContain("client_id=my-client");
    expect(capturedBody).toContain("client_secret=my-secret");
  });

  test("includes scope in request body when provided", async () => {
    let capturedBody;
    const fetchFn = async (url, opts) => {
      capturedBody = opts.body;
      return { ok: true, status: 200, json: async () => ({ access_token: "t", expires_in: 3600 }) };
    };

    await fetchClientCredentialsToken({ ...PARAMS, scope: "read write" }, fetchFn, NOW);
    expect(capturedBody).toContain("scope=read+write");
  });

  test("throws on non-ok HTTP response", async () => {
    const fetchFn = mockFetch({ error: "invalid_client" }, 401);
    await expect(fetchClientCredentialsToken(PARAMS, fetchFn, NOW)).rejects.toThrow("401");
  });

  test("throws when access_token is missing from response", async () => {
    const fetchFn = mockFetch({ token_type: "Bearer" });
    await expect(fetchClientCredentialsToken(PARAMS, fetchFn, NOW)).rejects.toThrow("access_token");
  });

  test("throws when token_url is missing", async () => {
    await expect(
      fetchClientCredentialsToken({ client_id: "a", client_secret: "b" }, mockFetch({}), NOW)
    ).rejects.toThrow("token_url");
  });

  test("defaults token_type to Bearer when not in response", async () => {
    const fetchFn = mockFetch({ access_token: "t", expires_in: 3600 });
    const result  = await fetchClientCredentialsToken(PARAMS, fetchFn, NOW);
    expect(result.token_type).toBe("Bearer");
  });
});

// ── getOrRefreshToken ─────────────────────────────────────────────────────────

describe("getOrRefreshToken", () => {
  const PARAMS = {
    token_url:     "https://auth.example.com/token",
    client_id:     "id",
    client_secret: "secret",
  };
  const NOW     = 1_700_000_000_000;
  const STORAGE_KEY = "auth_token:my-conn";

  function makeStorage(initial = {}) {
    const store = { ...initial };
    return {
      get:    async (k) => store[k],
      set:    async (k, v) => { store[k] = v; },
      delete: async (k) => { delete store[k]; },
      _store: store,
    };
  }

  function mockFetch(token = "fresh-token") {
    return async () => ({
      ok:   true,
      status: 200,
      json: async () => ({ access_token: token, expires_in: 3600, token_type: "Bearer" }),
    });
  }

  test("fetches a new token when storage is empty", async () => {
    const storage = makeStorage();
    const token   = await getOrRefreshToken(PARAMS, 60, storage, STORAGE_KEY, mockFetch(), NOW);
    expect(token).toBe("fresh-token");
  });

  test("persists the new token in storage", async () => {
    const storage = makeStorage();
    await getOrRefreshToken(PARAMS, 60, storage, STORAGE_KEY, mockFetch(), NOW);
    expect(storage._store[STORAGE_KEY]?.access_token).toBe("fresh-token");
  });

  test("returns cached token when still valid", async () => {
    const cachedRecord = { access_token: "cached-token", expires_in: 3600, obtained_at: NOW };
    const storage      = makeStorage({ [STORAGE_KEY]: cachedRecord });
    let   fetchCalled  = false;
    const fetchFn      = async () => { fetchCalled = true; return {}; };

    const token = await getOrRefreshToken(PARAMS, 60, storage, STORAGE_KEY, fetchFn, NOW);
    expect(token).toBe("cached-token");
    expect(fetchCalled).toBe(false);
  });

  test("refreshes when cached token is within buffer window", async () => {
    // Token expires in exactly the buffer period — should refresh
    const obtainedAt   = NOW - (3600 - 60) * 1000;
    const cachedRecord = { access_token: "old-token", expires_in: 3600, obtained_at: obtainedAt };
    const storage      = makeStorage({ [STORAGE_KEY]: cachedRecord });

    const token = await getOrRefreshToken(PARAMS, 60, storage, STORAGE_KEY, mockFetch("new-token"), NOW);
    expect(token).toBe("new-token");
  });

  test("refreshes when cached token has no expiry info", async () => {
    const cachedRecord = { access_token: "no-expiry-token" };
    const storage      = makeStorage({ [STORAGE_KEY]: cachedRecord });

    const token = await getOrRefreshToken(PARAMS, 60, storage, STORAGE_KEY, mockFetch("refreshed"), NOW);
    expect(token).toBe("refreshed");
  });
});

// ── resolveAuthHeaders ────────────────────────────────────────────────────────

describe("resolveAuthHeaders", () => {
  const NOW = 1_700_000_000_000;

  function makeStorage(initial = {}) {
    const store = { ...initial };
    return {
      get:    async (k) => store[k],
      set:    async (k, v) => { store[k] = v; },
      delete: async (k) => { delete store[k]; },
    };
  }

  function mockOAuthFetch(token = "oauth-token") {
    return async () => ({
      ok:   true,
      status: 200,
      json: async () => ({ access_token: token, expires_in: 3600, token_type: "Bearer" }),
    });
  }

  test("returns empty object for null auth", async () => {
    expect(await resolveAuthHeaders(null, makeStorage(), "conn")).toEqual({});
  });

  test("returns empty object for undefined auth", async () => {
    expect(await resolveAuthHeaders(undefined, makeStorage(), "conn")).toEqual({});
  });

  test("basic: returns Authorization header", async () => {
    const result = await resolveAuthHeaders(
      { type: "basic", user: "admin", pass: "secret" },
      makeStorage(), "conn"
    );
    expect(result.Authorization).toMatch(/^Basic /);
    const decoded = Buffer.from(result.Authorization.replace("Basic ", ""), "base64").toString();
    expect(decoded).toBe("admin:secret");
  });

  test("api_key: returns named header", async () => {
    const result = await resolveAuthHeaders(
      { type: "api_key", header: "X-API-Key", value: "mykey" },
      makeStorage(), "conn"
    );
    expect(result["X-API-Key"]).toBe("mykey");
  });

  test("bearer: returns Authorization header", async () => {
    const result = await resolveAuthHeaders(
      { type: "bearer", token: "mytoken" },
      makeStorage(), "conn"
    );
    expect(result.Authorization).toBe("Bearer mytoken");
  });

  test("oauth2_client_credentials: returns Bearer header with fetched token", async () => {
    const result = await resolveAuthHeaders(
      {
        type:          "oauth2_client_credentials",
        token_url:     "https://auth.example.com/token",
        client_id:     "id",
        client_secret: "secret",
      },
      makeStorage(),
      "my-conn",
      mockOAuthFetch("oauth-token"),
      NOW
    );
    expect(result.Authorization).toBe("Bearer oauth-token");
  });

  test("oauth2_client_credentials: uses cached token without fetching", async () => {
    const stored   = { access_token: "cached", expires_in: 3600, obtained_at: NOW };
    const storage  = makeStorage({ "auth_token:conn": stored });
    let   fetched  = false;
    const fetchFn  = async () => { fetched = true; };

    await resolveAuthHeaders(
      { type: "oauth2_client_credentials", token_url: "x", client_id: "y", client_secret: "z" },
      storage, "conn", fetchFn, NOW
    );
    expect(fetched).toBe(false);
  });

  test("custom: returns null (caller handles)", async () => {
    const result = await resolveAuthHeaders(
      { type: "custom", resolver: "{{fn:myAuth}}" },
      makeStorage(), "conn"
    );
    expect(result).toBeNull();
  });

  test("unknown type throws", async () => {
    await expect(
      resolveAuthHeaders({ type: "magic" }, makeStorage(), "conn")
    ).rejects.toThrow("Unsupported auth type");
  });
});
