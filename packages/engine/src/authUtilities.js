import { createRequire } from "module";
const require = createRequire(import.meta.url);

/**
 * @integra/engine - authUtilities.js
 *
 * Pure, tested utility functions for authentication.
 * Used internally by the engine for the three supported auth types,
 * and exported for connector authors to import and use directly.
 *
 * Design principles:
 *   - Every function is pure or clearly marked as having side effects
 *   - Functions that perform I/O (token fetch, storage) accept their
 *     dependencies as arguments so they can be injected in tests
 *   - No global state — callers own the token records they pass in
 *
 * Supported auth types:
 *   basic                      HTTP Basic Auth
 *   api_key                    Single header API key
 *   oauth2_client_credentials  OAuth 2.0 client credentials flow
 *   custom                     Deferred entirely to a resolver function
 */

// ── Basic Auth ────────────────────────────────────────────────────────────────

/**
 * Builds an HTTP Basic Auth header value from a username and password.
 * Pure.
 *
 * @param {string} user
 * @param {string} pass
 * @returns {string}  "Basic <base64(user:pass)>"
 */
export function buildBasicAuthHeader(user, pass) {
  if (!user || !pass) throw new Error("buildBasicAuthHeader: user and pass are required");
  const token = Buffer.from(`${user}:${pass}`).toString("base64");
  return `Basic ${token}`;
}

// ── API Key ───────────────────────────────────────────────────────────────────

/**
 * Builds a single-header API key entry.
 * Returns { [headerName]: value } ready to be merged into request headers.
 * Pure.
 *
 * @param {string} headerName  e.g. "X-API-Key", "Authorization"
 * @param {string} value       the key value
 * @returns {object}
 */
export function buildApiKeyHeader(headerName, value) {
  if (!headerName) throw new Error("buildApiKeyHeader: headerName is required");
  if (!value)      throw new Error("buildApiKeyHeader: value is required");
  return { [headerName]: value };
}

/**
 * Builds a Bearer token Authorization header value.
 * Pure.
 *
 * @param {string} token
 * @returns {string}  "Bearer <token>"
 */
export function buildBearerHeader(token) {
  if (!token) throw new Error("buildBearerHeader: token is required");
  return `Bearer ${token}`;
}

// ── OAuth 2.0 Client Credentials ─────────────────────────────────────────────

/**
 * Checks whether a stored token record is expired (or close to expiring).
 * Pure — injectable clock via nowMs.
 *
 * @param {object} tokenRecord     { access_token, expires_in, obtained_at }
 * @param {number} bufferSeconds   how many seconds before true expiry to treat as expired
 * @param {number} [nowMs]         current time in ms — defaults to Date.now()
 * @returns {boolean}
 */
export function isTokenExpired(tokenRecord, bufferSeconds = 60, nowMs = Date.now()) {
  if (!tokenRecord || !tokenRecord.access_token) return true;

  const { expires_in, obtained_at } = tokenRecord;

  // No expiry info — treat as expired to be safe
  if (!expires_in || !obtained_at) return true;

  const expiresAtMs = obtained_at + (expires_in - bufferSeconds) * 1000;
  return nowMs >= expiresAtMs;
}

/**
 * Fetches a new OAuth 2.0 client credentials token from the given token URL.
 * Returns a token record with obtained_at set to nowMs (injectable for testing).
 *
 * Has a side effect: makes an HTTP request.
 * Injectable fetchFn for testing.
 *
 * @param {object}   params
 * @param {string}   params.token_url
 * @param {string}   params.client_id
 * @param {string}   params.client_secret
 * @param {string}   [params.scope]
 * @param {function} [fetchFn]    injectable fetch — defaults to global fetch
 * @param {number}   [nowMs]      injectable timestamp — defaults to Date.now()
 * @returns {Promise<{ access_token, token_type, expires_in, obtained_at, scope? }>}
 */
export async function fetchClientCredentialsToken(params, fetchFn = fetch, nowMs = Date.now()) {
  const { token_url, client_id, client_secret, scope } = params;

  if (!token_url)     throw new Error("fetchClientCredentialsToken: token_url is required");
  if (!client_id)     throw new Error("fetchClientCredentialsToken: client_id is required");
  if (!client_secret) throw new Error("fetchClientCredentialsToken: client_secret is required");

  const body = new URLSearchParams({
    grant_type:    "client_credentials",
    client_id,
    client_secret,
    ...(scope ? { scope } : {}),
  });

  const res = await fetchFn(token_url, {
    method:  "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body:    body.toString(),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`OAuth token request failed: HTTP ${res.status} — ${text}`);
  }

  const data = await res.json();

  if (!data.access_token) {
    throw new Error("OAuth token response missing access_token");
  }

  return {
    access_token: data.access_token,
    token_type:   data.token_type   ?? "Bearer",
    expires_in:   data.expires_in   ?? null,
    scope:        data.scope        ?? scope ?? null,
    obtained_at:  nowMs,
  };
}

/**
 * Returns a valid access token, fetching a new one if the stored record
 * is missing, expired, or close to expiring.
 *
 * This is the primary entry point for most connectors using OAuth CC.
 *
 * @param {object}   params          OAuth params (token_url, client_id, client_secret, scope)
 * @param {number}   bufferSeconds   seconds before expiry to pre-emptively refresh
 * @param {object}   storage         { get(key), set(key, value) } — a storage instance
 * @param {string}   storageKey      key under which to persist the token record
 * @param {function} [fetchFn]       injectable fetch
 * @param {number}   [nowMs]         injectable timestamp
 * @returns {Promise<string>}        a valid access_token string
 */
export async function getOrRefreshToken(
  params,
  bufferSeconds = 60,
  storage,
  storageKey,
  fetchFn = fetch,
  nowMs = Date.now()
) {
  const existing = await storage.get(storageKey);

  if (!isTokenExpired(existing, bufferSeconds, nowMs)) {
    return existing.access_token;
  }

  const fresh = await fetchClientCredentialsToken(params, fetchFn, nowMs);
  await storage.set(storageKey, fresh);
  return fresh.access_token;
}


// ── Inbound HMAC verification ─────────────────────────────────────────────────

/**
 * Verifies an HMAC signature sent by an inbound webhook caller.
 * Pure — injectable crypto module for testing.
 *
 * @param {string|Buffer} payload      raw request body (before JSON parsing)
 * @param {string}        signature    the value of the signature header
 *                                     may be prefixed with "sha256=" etc.
 * @param {string}        secret       the shared secret
 * @param {string}        [algorithm]  default "sha256"
 * @param {object}        [cryptoMod]  injectable — defaults to Node's crypto module
 * @returns {boolean}
 */
export function verifyHmacSignature(payload, signature, secret, algorithm = "sha256", cryptoMod = null) {
  if (!payload)   throw new Error("verifyHmacSignature: payload is required");
  if (!signature) throw new Error("verifyHmacSignature: signature is required");
  if (!secret)    throw new Error("verifyHmacSignature: secret is required");

  const { createHmac, timingSafeEqual } = cryptoMod ?? require("crypto");

  // Strip any "sha256=" style prefix (e.g. "sha256=abc123" -> "abc123")
  const rawSig = signature.includes("=") ? signature.split("=").slice(1).join("=") : signature;

  const hmac = createHmac(algorithm, secret);
  hmac.update(typeof payload === "string" ? payload : Buffer.from(payload));
  const digest   = hmac.digest("hex");

  // Use fixed-length buffers for timing-safe comparison
  const expected = Buffer.from(digest, "hex");
  const received = Buffer.from(rawSig, "hex");

  if (expected.length !== received.length) return false;
  return timingSafeEqual(expected, received);
}

// ── Auth block resolution (used by the engine internally) ─────────────────────

/**
 * Resolves an auth block from a connection component into a header object.
 * Called by the executor before each HTTP request.
 *
 * For basic and api_key types — purely synchronous computation.
 * For oauth2_client_credentials — fetches/refreshes token as needed.
 * For custom — returns null; the caller should use the resolver fn instead.
 *
 * @param {object}   auth       the resolved auth block from the connection component
 * @param {object}   storage    a storage instance (from createStorage)
 * @param {string}   connId     connection id — used as storage key prefix
 * @param {function} [fetchFn]  injectable fetch
 * @param {number}   [nowMs]    injectable timestamp
 * @returns {Promise<object|null>}  header object to merge, or null for custom
 */
export async function resolveAuthHeaders(auth, storage, connId, fetchFn = fetch, nowMs = Date.now()) {
  if (!auth || !auth.type) return {};

  switch (auth.type) {
    case "basic":
      return {
        Authorization: buildBasicAuthHeader(auth.user, auth.pass),
      };

    case "api_key":
      return buildApiKeyHeader(auth.header ?? "X-API-Key", auth.value);

    case "bearer":
      return {
        Authorization: buildBearerHeader(auth.token),
      };

    case "oauth2_client_credentials": {
      const storageKey = `auth_token:${connId}`;
      const token      = await getOrRefreshToken(
        {
          token_url:     auth.token_url,
          client_id:     auth.client_id,
          client_secret: auth.client_secret,
          scope:         auth.scope ?? null,
        },
        auth.token_buffer ?? 60,
        storage,
        storageKey,
        fetchFn,
        nowMs
      );
      return { Authorization: buildBearerHeader(token) };
    }

    case "custom":
      // Engine defers to resolver fn — caller handles this case
      return null;

    default:
      throw new Error(`Unsupported auth type: "${auth.type}"`);
  }
}
