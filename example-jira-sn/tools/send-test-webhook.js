#!/usr/bin/env node
// Copyright (c) 2026 Claudius Tiberiu Iacob — Licensed under BSL 1.1. See LICENSE for details.
/**
 * tools/send-test-webhook.js
 *
 * Fires a realistic Jira issue-created webhook at the local listener.
 * Signs the payload with HMAC-SHA256 using the secret from .env.
 *
 * Usage:
 *   node tools/send-test-webhook.js
 *   node tools/send-test-webhook.js --event jira:issue_updated
 *   node tools/send-test-webhook.js --port 3100 --secret my-secret
 *
 * The listener must be running first:
 *   integra run handle-jira-issue   (from the example-jira-sn directory)
 *   — or —
 *   integra-manager start           (from the registry directory)
 */

import { createHmac }  from "crypto";
import { readFile }    from "fs/promises";
import { resolve }     from "path";
import { fileURLToPath } from "url";

const __dirname = resolve(fileURLToPath(import.meta.url), "..");

// ── Argument parsing ──────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      args[argv[i].slice(2)] = argv[i + 1] ?? true;
      i++;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

// ── Load .env manually (no dotenv dependency) ─────────────────────────────────

async function loadEnv(dir) {
  try {
    const raw = await readFile(resolve(dir, ".env"), "utf-8");
    const env = {};
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx < 0) continue;
      const key   = trimmed.slice(0, eqIdx).trim();
      const value = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
      env[key] = value;
    }
    return env;
  } catch {
    return {};
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const envDir = resolve(__dirname, "..");
  const env    = await loadEnv(envDir);

  const secret = args.secret ?? env.JIRA_WEBHOOK_SECRET ?? "change-me-to-a-strong-secret";
  const port   = args.port   ?? 3100;
  const host   = args.host   ?? "localhost";
  const path   = args.path   ?? "/hooks/jira";
  const event  = args.event  ?? "jira:issue_created";

  // Load base fixture
  const fixturePath = resolve(__dirname, "../test/fixtures/jira-issue-created.json");
  const fixture     = JSON.parse(await readFile(fixturePath, "utf-8"));

  // Override event type if requested
  fixture.webhookEvent            = event;
  fixture.issue_event_type_name   = event.replace("jira:", "");
  fixture.timestamp               = Date.now();

  const body      = JSON.stringify(fixture, null, 2);
  const signature = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
  const url       = `http://${host}:${port}${path}`;

  console.log(`\nSending ${event} to ${url}`);
  console.log(`Signature: ${signature.slice(0, 30)}...`);

  let res;
  try {
    res = await fetch(url, {
      method:  "POST",
      headers: {
        "Content-Type":          "application/json",
        "X-Hub-Signature-256":   signature,
        "X-Atlassian-Token":     "no-check",
        "User-Agent":            "Atlassian-Webhook-Testing-Tool/1.0",
      },
      body,
    });
  } catch (err) {
    console.error(`\n✗ Could not connect to ${url}`);
    console.error(`  Is the listener running? (integra run handle-jira-issue)`);
    console.error(`  Error: ${err.message}`);
    process.exit(1);
  }

  const responseText = await res.text();
  let   responseBody;
  try { responseBody = JSON.parse(responseText); } catch { responseBody = responseText; }

  console.log(`\nResponse: ${res.status} ${res.statusText}`);
  console.log(JSON.stringify(responseBody, null, 2));

  if (res.ok) {
    console.log("\n✓ Webhook delivered and processed successfully.\n");
  } else {
    console.log("\n✗ Listener returned an error — check integration logs.\n");
    process.exit(1);
  }
}

main().catch(err => {
  console.error(`\nFatal: ${err.message}`);
  process.exit(1);
});
