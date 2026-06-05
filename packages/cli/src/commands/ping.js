/**
 * @integra/cli - commands/ping.js
 *
 * Fires the integration's no-op connection and reports whether the remote
 * system is reachable with the configured credentials.
 *
 * The implementor is responsible for providing a safe, side-effect-free
 * connection component named "no-op" in connections/no-op.json.
 * This command makes no assumptions about what is safe to call — it simply
 * runs whatever the no-op connection declares.
 *
 * Usage:
 *   integra ping
 *   integra ping --env .env.dev
 *
 * Exit codes:
 *   0  — HTTP response received (even a 4xx/5xx counts as "reachable")
 *   1  — network error, missing no-op, or misconfiguration
 */

import { resolve }    from "path";
import { existsSync } from "fs";
import { parseArgs }  from "../args.js";

const NO_OP_ID = "no-op";

export async function ping(argv) {
  const { flags }   = parseArgs(argv);
  const cwd         = process.cwd();

  // ── Env file ────────────────────────────────────────────────────────────────

  const envFileName = flags.env ?? ".env";
  const envFile     = resolve(cwd, envFileName);

  if (!existsSync(envFile)) {
    throw new Error(`Env file not found: ${envFile}`);
  }

  const { loadEnvFile, readManifest } = await import("@integra/engine");
  await loadEnvFile(envFile);

  // ── Load components ─────────────────────────────────────────────────────────

  const { load, collectResolverPaths } = await import("@integra/engine/loader");
  const { loadResolvers, resolve: resolveValue } = await import("@integra/engine/resolver");
  const { resolveAuthBlock }           = await import("@integra/engine/executor");
  const { createStorage }              = await import("@integra/engine/storage");

  const registry = await load(cwd);
  const conn     = registry.connections[NO_OP_ID];

  if (!conn) {
    throw new Error(
      `No no-op connection found.\n` +
      `Create connections/no-op.json with a safe, read-only request to verify connectivity.\n` +
      `Example:\n` +
      `  { "id": "no-op", "purpose": "read", "auth": { ... }, "request": { "type": "GET", "endpoint": "..." } }`
    );
  }

  // ── Build context ───────────────────────────────────────────────────────────

  const resolverPaths = collectResolverPaths(registry);
  const resolvers     = await loadResolvers(resolverPaths, cwd);
  const storage       = createStorage(cwd);

  const ctx = {
    env:       process.env,
    shared:    {},
    input:     {},
    output:    {},
    component: {},
    resolvers,
    meta:      { runId: "ping", processId: "ping", stepId: NO_OP_ID },
    logger:    { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    _shared:   { get: () => undefined, set: () => {}, all: () => ({}) },
    _storage:  storage,
  };

  // ── Resolve request ─────────────────────────────────────────────────────────

  const { request, auth } = conn;

  const endpoint = resolveValue(request.endpoint, ctx);
  const method   = request.type ?? "GET";
  const headers  = resolveValue(request.headers ?? {}, ctx);
  const query    = resolveValue(request.query   ?? {}, ctx);

  // Resolve auth — uses the same resolveAuthBlock as the executor,
  // so custom resolver fns are correctly invoked when present
  const resolvedAuth = auth ? resolveValue(auth, ctx) : null;
  let   authHeaders  = {};
  if (resolvedAuth) {
    authHeaders = await resolveAuthBlock(resolvedAuth, NO_OP_ID, ctx) ?? {};
  }

  // Build URL with query params
  const url = new URL(endpoint);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }

  const mergedHeaders = {
    "Content-Type": "application/json",
    ...authHeaders,
    ...headers,
  };

  // ── Report what we're about to do ──────────────────────────────────────────

  console.log(`\nPinging: ${conn.short_description ?? NO_OP_ID}`);
  if (flags.env) console.log(`Env:     ${envFileName}`);
  console.log(`\n  ${method} ${url}`);

  // Show auth header — mask the value
  if (mergedHeaders.Authorization) {
    const authDisplay = mergedHeaders.Authorization.replace(
      /^(Basic|Bearer)\s+\S+/,
      (_, scheme) => `${scheme} ****`
    );
    console.log(`  Authorization: ${authDisplay}`);
  }
  console.log();

  // ── Fire ────────────────────────────────────────────────────────────────────

  const t0 = Date.now();
  let res;

  try {
    res = await fetch(url.toString(), {
      method,
      headers: mergedHeaders,
      // No body — ping is never a write
    });
  } catch (err) {
    console.error(`  ✗ Network error: ${err.message}`);
    console.error(`    Check that ${url.hostname} is reachable and the URL is correct.`);
    process.exit(1);
  }

  const duration = Date.now() - t0;
  const ok       = res.status >= 200 && res.status < 300;

  if (ok) {
    console.log(`  ✓ HTTP ${res.status} — reachable (${duration}ms)\n`);
  } else {
    console.error(`  ✗ HTTP ${res.status} ${res.statusText} (${duration}ms)`);
    console.error(`    Credentials or endpoint may be incorrect.`);
    console.error(`    Check your env file: ${envFileName}\n`);
    process.exit(1);
  }
}
