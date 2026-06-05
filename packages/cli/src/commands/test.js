/**
 * @integra/cli - commands/test.js
 *
 * Mock-test runner for integra integrations.
 * No real HTTP calls are ever made — all outbound connections are intercepted
 * and answered with fixture files, all inbound webhooks are fired from fixtures.
 *
 * Usage:
 *   integra test
 *
 * Note: --env is intentionally NOT supported here. integra test never consults
 * credentials or real endpoints — everything is mocked. If your process reads
 * env vars for non-credential purposes (e.g. project keys used in mapping),
 * those should be represented in your fixture data instead.
 *
 * Lifecycle detection:
 *   listener  → start real Fastify, fire each webhooks/ fixture at it, collect results
 *   otherwise → run entry process with responses/ fixtures intercepting outbound calls
 *
 * Fixture resolution:
 *   One response fixture    → used for all outbound calls
 *   Multiple fixtures       → .fixture-map.json required (URL → filename)
 *   No response fixtures    → error (outbound integration must have at least one)
 *   No webhook fixtures     → error (listener integration must have at least one)
 */

import { readdir, readFile }        from "fs/promises";
import { resolve, join, basename }  from "path";
import { existsSync }               from "fs";
import { createHmac }               from "crypto";

const FIXTURES_DIR    = "test/fixtures";
const WEBHOOKS_DIR    = "test/fixtures/webhooks";
const RESPONSES_DIR   = "test/fixtures/responses";
const DISABLED_DIR    = "test/fixtures/.disabled";
const FIXTURE_MAP     = "test/fixtures/.fixture-map.json";

// ── Pure helpers ───────────────────────────────────────────────────────────────

async function listFixtures(dir) {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter(e => e.isFile() && e.name !== ".gitkeep")
      .map(e => join(dir, e.name));
  } catch {
    return [];
  }
}

async function loadFixtureMap(cwd) {
  const mapPath = resolve(cwd, FIXTURE_MAP);
  if (!existsSync(mapPath)) return null;
  try {
    const raw = await readFile(mapPath, "utf-8");
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`.fixture-map.json is not valid JSON: ${err.message}`);
  }
}

export function resolveResponseFixture(url, fixtureMap, responseFiles, existsFn = existsSync) {
  if (responseFiles.length === 0) {
    throw new Error(
      `No response fixtures found in ${RESPONSES_DIR}.\n` +
      `Add at least one .json file there before running integra test.`
    );
  }

  if (responseFiles.length === 1) {
    return responseFiles[0];
  }

  if (!fixtureMap) {
    throw new Error(
      `Multiple response fixtures found but no .fixture-map.json.\n` +
      `Create ${FIXTURE_MAP} to map each outbound URL to its fixture file.`
    );
  }

  const match = Object.entries(fixtureMap).find(([pattern]) => url.startsWith(pattern));

  if (!match) {
    throw new Error(
      `No fixture mapped for URL: ${url}\n` +
      `Add an entry to .fixture-map.json for this URL.`
    );
  }

  const fixturePath = resolve(process.cwd(), match[1]);
  if (!existsFn(fixturePath)) {
    throw new Error(
      `.fixture-map.json references "${match[1]}" but the file does not exist.`
    );
  }

  return fixturePath;
}

function buildMockFetch(fixtureMap, responseFiles, cwd) {
  return async (url, opts) => {
    const fixturePath = resolveResponseFixture(url, fixtureMap, responseFiles.map(f => resolve(cwd, f)));
    const raw         = await readFile(fixturePath, "utf-8");
    const body        = JSON.parse(raw);

    console.log(`  [mock] ${opts?.method ?? "GET"} ${url}`);
    console.log(`         → ${basename(fixturePath)}`);

    return {
      ok:      (body._mockStatus ?? 200) < 400,
      status:  body._mockStatus ?? 200,
      json:    async () => { const { _mockStatus, ...rest } = body; return rest; },
      text:    async () => raw,
      arrayBuffer: async () => Buffer.from(raw).buffer,
      headers: new Headers(body._mockHeaders ?? {}),
    };
  };
}

// ── Outbound test runner ───────────────────────────────────────────────────────

async function runOutboundTest(cwd) {
  const { boot, readManifest } = await import("@integra/engine");

  const manifest       = await readManifest(cwd);
  const entryProcessId = manifest.entry;
  if (!entryProcessId) throw new Error("No entry process defined in integra.json");

  const responseFiles = await listFixtures(resolve(cwd, RESPONSES_DIR));
  const fixtureMap    = await loadFixtureMap(cwd);

  if (responseFiles.length === 0) {
    throw new Error(
      `No response fixtures found.\n` +
      `Add at least one .json file to ${RESPONSES_DIR}/ before running integra test.`
    );
  }

  console.log(`\n  Response fixtures: ${responseFiles.length}`);
  responseFiles.forEach(f => console.log(`    ${basename(f)}`));
  if (fixtureMap) {
    console.log(`  Fixture map: .fixture-map.json (${Object.keys(fixtureMap).length} entries)`);
  }
  console.log();

  const realFetch  = globalThis.fetch;
  globalThis.fetch = buildMockFetch(fixtureMap, responseFiles, cwd);

  try {
    const result = await boot(cwd, { processId: entryProcessId });
    console.log(`\n  ✓ Process completed.`);
    if (process.env.LOG_LEVEL === "debug") {
      console.log("\n  Shared space:");
      console.log(JSON.stringify(result.shared, null, 2));
    }
    return { ok: true };
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ── Inbound (listener) test runner ────────────────────────────────────────────

async function runListenerTest(cwd) {
  const { boot, readManifest } = await import("@integra/engine");

  const manifest      = await readManifest(cwd);
  const webhookFiles  = await listFixtures(resolve(cwd, WEBHOOKS_DIR));
  const responseFiles = await listFixtures(resolve(cwd, RESPONSES_DIR));
  const fixtureMap    = await loadFixtureMap(cwd);

  if (webhookFiles.length === 0) {
    throw new Error(
      `No webhook fixtures found.\n` +
      `Add at least one .json file to ${WEBHOOKS_DIR}/ before running integra test.`
    );
  }

  const hasOutbound = responseFiles.length > 0;

  console.log(`\n  Webhook fixtures : ${webhookFiles.length}`);
  webhookFiles.forEach(f => console.log(`    ${basename(f)}`));
  if (hasOutbound) {
    console.log(`  Response fixtures: ${responseFiles.length}`);
    responseFiles.forEach(f => console.log(`    ${basename(f)}`));
  }
  console.log();

  const realFetch  = globalThis.fetch;
  if (hasOutbound) {
    globalThis.fetch = buildMockFetch(fixtureMap, responseFiles, cwd);
  }

  const TEST_PORT = (manifest.httpServer?.port ?? 3100) + 1000;

  let fastify;
  try {
    fastify = await boot(cwd, { listenerPort: TEST_PORT });

    const secret    = manifest.httpServer?.auth?.secret
      ? manifest.httpServer.auth.secret.replace(/\{\{env\.([^}]+)\}\}/, (_, k) => process.env[k] ?? "")
      : null;
    const path      = manifest.httpServer?.path ?? "/";
    const listenUrl = `http://localhost:${TEST_PORT}${path}`;
    const results   = [];

    for (const fixturePath of webhookFiles) {
      const name    = basename(fixturePath);
      const raw     = await readFile(fixturePath, "utf-8");
      const headers = { "Content-Type": "application/json" };
      if (secret) {
        headers["X-Hub-Signature-256"] =
          "sha256=" + createHmac("sha256", secret).update(raw).digest("hex");
      }

      console.log(`  → Firing: ${name}`);

      const res     = await realFetch(listenUrl, { method: "POST", headers, body: raw });
      const resText = await res.text();
      let   resBody;
      try { resBody = JSON.parse(resText); } catch { resBody = resText; }

      const ok = res.status >= 200 && res.status < 300;
      console.log(`    ${ok ? "✓" : "✗"} HTTP ${res.status}`);
      if (!ok || process.env.LOG_LEVEL === "debug") {
        console.log(`    ${JSON.stringify(resBody)}`);
      }

      results.push({ fixture: name, status: res.status, ok, body: resBody });
    }

    const failed = results.filter(r => !r.ok);
    if (failed.length) {
      console.log(`\n  ✗ ${failed.length} webhook(s) returned non-2xx responses.`);
      return { ok: false, results };
    }

    console.log(`\n  ✓ All ${results.length} webhook(s) processed successfully.`);
    return { ok: true, results };

  } finally {
    if (fastify?.close) await fastify.close();
    globalThis.fetch = realFetch;
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────

export async function test(argv) {
  const cwd = process.cwd();

  const { readManifest } = await import("@integra/engine");
  const manifest  = await readManifest(cwd);
  const lifecycle = manifest.lifecycle ?? null;

  console.log(`\nMock-testing integration: ${manifest.id ?? cwd}`);

  if (lifecycle === "listener") {
    const result = await runListenerTest(cwd);
    if (!result.ok) process.exit(1);
  } else {
    const result = await runOutboundTest(cwd);
    if (!result.ok) process.exit(1);
  }
}
