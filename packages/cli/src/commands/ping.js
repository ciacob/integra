/**
 * @int3gra/cli - commands/ping.js
 *
 * Fires one or more connections and reports whether each remote system
 * is reachable with the configured credentials.
 *
 * Usage:
 *   integra ping                          # fires connections/no-op.json
 *   integra ping --con sn-get-incident    # fires a specific connection
 *   integra ping --con sn-get-incident,jira-create-issue  # fires multiple
 *   integra ping --env .env.dev           # with a specific env file
 *
 * When --con is absent, the fixed id "no-op" is used. The implementor is
 * responsible for providing connections that are safe to fire without a body.
 *
 * Connections run sequentially. Each is reported individually.
 * Exit code 0 only if all connections succeed.
 */

import { resolve }    from "path";
import { existsSync } from "fs";
import { parseArgs }  from "../args.js";

const NO_OP_ID = "no-op";

// ── Core: ping one connection ──────────────────────────────────────────────────

async function pingOne(conn, ctx, resolveValue, resolveAuthBlock) {
  const { request, auth } = conn;

  const endpoint     = resolveValue(request.endpoint, ctx);
  const method       = request.type ?? "GET";
  const headers      = resolveValue(request.headers ?? {}, ctx);
  const query        = resolveValue(request.query   ?? {}, ctx);
  const resolvedAuth = auth ? resolveValue(auth, ctx) : null;

  let authHeaders = {};
  if (resolvedAuth) {
    authHeaders = await resolveAuthBlock(resolvedAuth, conn.id, ctx) ?? {};
  }

  const url = new URL(endpoint);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }

  const mergedHeaders = { "Content-Type": "application/json", ...authHeaders, ...headers };

  // Display auth header — mask the credential value
  const authDisplay = mergedHeaders.Authorization
    ? mergedHeaders.Authorization.replace(/^(Basic|Bearer)\s+\S+/, (_, s) => `${s} ****`)
    : null;

  console.log(`  ${method} ${url}`);
  if (authDisplay) console.log(`  Authorization: ${authDisplay}`);

  const t0 = Date.now();
  let res;

  try {
    res = await fetch(url.toString(), { method, headers: mergedHeaders });
  } catch (err) {
    const duration = Date.now() - t0;
    console.error(`  ✗ Network error (${duration}ms): ${err.message}`);
    console.error(`    Check that ${url.hostname} is reachable and the URL is correct.\n`);
    return false;
  }

  const duration = Date.now() - t0;
  const ok       = res.status >= 200 && res.status < 300;

  if (ok) {
    console.log(`  ✓ HTTP ${res.status} — reachable (${duration}ms)\n`);
  } else {
    console.error(`  ✗ HTTP ${res.status} ${res.statusText} (${duration}ms)`);
    console.error(`    Credentials or endpoint may be incorrect.\n`);
  }

  return ok;
}

// ── Entry point ────────────────────────────────────────────────────────────────

export async function ping(argv) {
  const { flags } = parseArgs(argv);
  const cwd       = process.cwd();

  // ── Env file ────────────────────────────────────────────────────────────────

  const envFileName = flags.env ?? ".env";
  const envFile     = resolve(cwd, envFileName);

  if (!existsSync(envFile)) {
    throw new Error(`Env file not found: ${envFile}`);
  }

  const { loadEnvFile }               = await import("@int3gra/engine");
  const { load, collectResolverPaths } = await import("@int3gra/engine/loader");
  const { loadResolvers, resolve: resolveValue } = await import("@int3gra/engine/resolver");
  const { resolveAuthBlock }          = await import("@int3gra/engine/executor");
  const { createStorage }             = await import("@int3gra/engine/storage");

  await loadEnvFile(envFile);

  // ── Resolve connection ids ──────────────────────────────────────────────────

  const connIds = flags.con
    ? flags.con.split(",").map(s => s.trim()).filter(Boolean)
    : [NO_OP_ID];

  // ── Load registry and resolvers ─────────────────────────────────────────────

  const registry      = await load(cwd);
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
    meta:      { runId: "ping", processId: "ping", stepId: "ping" },
    logger:    { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    _shared:   { get: () => undefined, set: () => {}, all: () => ({}) },
    _storage:  storage,
  };

  // ── Validate all requested connections exist before firing any ──────────────

  const missing = connIds.filter(id => !registry.connections[id]);
  if (missing.length) {
    const noun = missing.length === 1 ? "connection" : "connections";
    throw new Error(
      `Unknown ${noun}: ${missing.join(", ")}\n` +
      `Available connections: ${Object.keys(registry.connections).join(", ") || "(none)"}\n` +
      (connIds.includes(NO_OP_ID)
        ? `Create connections/no-op.json with a safe, read-only request to verify connectivity.`
        : "")
    );
  }

  // ── Banner ──────────────────────────────────────────────────────────────────

  const noun = connIds.length === 1 ? "connection" : "connections";
  console.log(`\nPinging ${connIds.length} ${noun}${flags.env ? ` (env: ${envFileName})` : ""}:\n`);

  // ── Fire each connection in sequence ────────────────────────────────────────

  let allOk = true;

  for (const id of connIds) {
    const conn = registry.connections[id];
    console.log(`[ ${id} ] ${conn.short_description ?? ""}`);
    const ok = await pingOne(conn, ctx, resolveValue, resolveAuthBlock);
    if (!ok) allOk = false;
  }

  // ── Summary ─────────────────────────────────────────────────────────────────

  if (connIds.length > 1) {
    const passed = connIds.length - (allOk ? 0 : 1);
    if (allOk) {
      console.log(`✓ All ${connIds.length} connections reachable.\n`);
    } else {
      console.error(`✗ One or more connections failed — see details above.\n`);
    }
  }

  if (!allOk) process.exit(1);
}
