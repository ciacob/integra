#!/usr/bin/env node
// Copyright (c) 2026 Claudius Tiberiu Iacob — Licensed under BSL 1.1. See LICENSE for details.
/**
 * @int3gra/manager - index.js
 * CLI entry point for the integration manager.
 */

import { startAll, stopOne, restartOne, statusAll,
         enableIntegration, disableIntegration }  from "./manager.js";
import { readFile }                                from "fs/promises";
import { resolve }                                 from "path";
import { createTailStream }                        from "./commands/logs.js";
import { checkout }                                from "./commands/checkout.js";
import { publish }                                 from "./commands/publish.js";
import { uncheckout }                               from "./commands/uncheckout.js";
import { deleteEntry }                              from "./commands/delete.js";
import { duplicate }                                from "./commands/duplicate.js";
import { deploy }                                   from "./commands/deploy.js";
import { undeploy }                                 from "./commands/undeploy.js";
import { deployHistory }                            from "./commands/deployHistory.js";
import { resolveIntegraHome, assertIntegraHomeExists } from "./home.js";

const [,, command, ...args] = process.argv;

const HELP = `
integra-manager — integration supervisor

Runtime commands:
  integra-manager start [--env file] Start all enabled integrations.
                                     --env: env file to use (default: .env per integration).
                                     Behaviour depends on lifecycle (see below).
  integra-manager stop <id>          Stop an integration and any associated processes
  integra-manager restart <id>       Restart an integration (targets the right process per lifecycle)
  integra-manager status             Show all integrations — lifecycle, status, uptime, tc column
  integra-manager logs <id>          Tail integration logs
  integra-manager enable <id>        Enable an integration (acquires/releases its own lock)
  integra-manager disable <id>       Stop then disable an integration (acquires/releases its own lock)

Registry commands (registry.d/ — never hand-edit these files):
  integra-manager checkout <id>      Lock <id> and seed a staging file from its current
                                     live content. Refuses if <id> isn't already registered —
                                     use 'integra init <path>' to register a new integration.
  integra-manager publish <id> [file] Validate and publish your staged edits live. Releases the lock.
                                     [file] defaults to the staging copy from checkout.
  integra-manager uncheckout <id>    Release your lock without publishing.
  integra-manager delete <id> [--purge]  Remove a published entry. --purge also deletes its folder.
  integra-manager duplicate <id> <new-id>  Lock <new-id>, seed it from <id>, copy the integration folder.

Git-backed deploy commands (see README "Git-backed deploy" for the full model):
  integra-manager deploy <id> --branch <name>  Fast-forward live/ to a local branch already
                                     pushed into it, tag, restart. Refuses (live/ untouched)
                                     if it doesn't fast-forward cleanly.
  integra-manager undeploy <id>      Roll back live/ to the deploy before the current one, restart.
  integra-manager deploy-history <id> [-n <count>]  List recent deploys (default 10).

Lifecycles (declared in integra.json, or derived from the registry entry):
  (absent)    Run-once. Starts, executes entry process, exits.
  scheduled   TrafficController fires entry on cron schedule (schedule field in the registry entry).
  listener    Long-lived Fastify HTTP server. Fires entry on each inbound request. autorestart: true.

Registry entry fields:
  id          Unique integration identifier — must match the filename and the integration's own integra.json
  path        Relative path to the integration directory
  enabled     true | false
  schedule    Cron expression — makes the integration "scheduled"  e.g. "*/5 * * * *"
  max_ttl     Seconds before TC forcibly kills a runaway scheduled integration
  env_file    Relative path to a non-default env file

Every command resolves integra's one fixed home (/opt/integra) automatically
— there is no need to run this from any particular directory. The home
must already exist on this host; run `integra setup` (as root) once,
before the first command, if it doesn't.
`;

async function main() {
  if (!command || command === "--help" || command === "-h") {
    console.log(HELP);
    process.exit(0);
  }

  // Every command operates against integra's one fixed home (/opt/integra,
  // see home.js) — never against whatever directory the command happens
  // to be invoked from. This is what lets integra-manager (and --branch,
  // in @int3gra/cli) be run from anywhere on the host, with no "cd to
  // where registry.d/ lives" step. The home must already exist — there
  // is no automatic creation anymore; `integra setup` is the one and only
  // provisioning step, and it must be run by hand, once, as root.
  assertIntegraHomeExists();
  const cwd = resolveIntegraHome();

  switch (command) {
    case "start": {
      // Parse optional --env flag: integra-manager start --env .env.dev
      const envFlag = args.find((a, i) => a === "--env" && args[i + 1]);
      const envFile = envFlag ? args[args.indexOf("--env") + 1] : null;
      await startAll(cwd, envFile);
      console.log("✓ All enabled integrations started.");
      break;
    }

    case "stop":
      if (!args[0]) throw new Error("Usage: integra-manager stop <id>");
      await stopOne(args[0], cwd);
      console.log(`✓ Stopped: ${args[0]}`);
      break;

    case "restart":
      if (!args[0]) throw new Error("Usage: integra-manager restart <id>");
      await restartOne(args[0], cwd);
      console.log(`✓ Restarted: ${args[0]}`);
      break;

    case "status": {
      const rows = await statusAll(cwd);
      if (!rows.length) {
        console.log("No known integrations are running.");
      } else {
        console.log("\nIntegration Status:\n");
        console.table(rows);
      }
      break;
    }

    case "logs":
      if (!args[0]) throw new Error("Usage: integra-manager logs <id>");
      await createTailStream(args[0], cwd);
      break;

    case "enable":
      if (!args[0]) throw new Error("Usage: integra-manager enable <id>");
      await enableIntegration(args[0], cwd);
      console.log(`✓ Enabled: ${args[0]}`);
      break;

    case "disable":
      if (!args[0]) throw new Error("Usage: integra-manager disable <id>");
      await disableIntegration(args[0], cwd);
      console.log(`✓ Disabled: ${args[0]}`);
      break;

    case "checkout": {
      if (!args[0]) throw new Error("Usage: integra-manager checkout <id>");
      const result = await checkout(args[0], { cwd });
      console.log(`✓ Checked out: ${result.id}${result.isNew ? " (new)" : ""}`);
      console.log(`  Staging file: ${result.stagingPath}`);
      console.log(`  Lock expires: ${new Date(result.lockExpiresAt).toLocaleString()}`);
      break;
    }

    case "publish": {
      if (!args[0]) throw new Error("Usage: integra-manager publish <id> [file]");
      const result = await publish(args[0], args[1], { cwd });
      console.log(`✓ Published: ${result.id}`);
      console.log(`  From: ${result.path}`);
      break;
    }

    case "uncheckout": {
      if (!args[0]) throw new Error("Usage: integra-manager uncheckout <id>");
      await uncheckout(args[0], { cwd });
      console.log(`✓ Released checkout: ${args[0]}`);
      break;
    }

    case "delete": {
      if (!args[0]) throw new Error("Usage: integra-manager delete <id> [--purge]");
      const purge = args.includes("--purge");
      const result = await deleteEntry(args[0], { cwd, purge });
      console.log(`✓ Deleted: ${result.id}`);
      if (result.purgedPath) console.log(`  Purged: ${result.purgedPath}`);
      break;
    }

    case "duplicate": {
      if (!args[0] || !args[1]) throw new Error("Usage: integra-manager duplicate <id> <new-id>");
      const result = await duplicate(args[0], args[1], { cwd });
      console.log(`✓ Duplicated "${args[0]}" → "${result.id}"`);
      console.log(`  Staging file: ${result.stagingPath}`);
      console.log(`  Integration dir: ${result.integrationDir}`);
      console.log(`  Remember to edit and 'publish ${result.id}' when ready.`);
      break;
    }

    case "deploy": {
      const branchIdx = args.indexOf("--branch");
      const branch    = branchIdx >= 0 ? args[branchIdx + 1] : null;
      if (!args[0] || !branch) throw new Error("Usage: integra-manager deploy <id> --branch <name>");
      const result = await deploy(args[0], branch, { cwd });
      console.log(`✓ Deployed "${result.branch}" to "${result.id}" as ${result.tag}`);
      console.log(`  ${result.headBefore.slice(0, 12)} → ${result.headAfter.slice(0, 12)}`);
      console.log(`  Restarted.`);
      break;
    }

    case "undeploy": {
      if (!args[0]) throw new Error("Usage: integra-manager undeploy <id>");
      const result = await undeploy(args[0], { cwd });
      console.log(`✓ Rolled back "${result.id}" to ${result.tag}`);
      console.log(`  ${result.headBefore.slice(0, 12)} → ${result.headAfter.slice(0, 12)}`);
      console.log(`  Restarted.`);
      break;
    }

    case "deploy-history": {
      if (!args[0]) throw new Error("Usage: integra-manager deploy-history <id> [-n <count>]");
      const nIdx = args.indexOf("-n");
      const n    = nIdx >= 0 ? parseInt(args[nIdx + 1], 10) : 10;
      const entries = await deployHistory(args[0], { cwd, n });
      if (entries.length === 0) {
        console.log(`No deploys recorded for "${args[0]}".`);
      } else {
        console.log(`Deploy history for "${args[0]}":\n`);
        for (const e of entries) {
          console.log(`  ${e.tag}  ${e.sha}  branch=${e.branch ?? "?"}  by=${e.by ?? "?"}  at=${e.at ?? "?"}`);
        }
      }
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      console.error(`Run 'integra-manager --help' for available commands.`);
      process.exit(1);
  }
}

main().catch(err => {
  console.error(`\n[integra-manager] Error: ${err.message}`);
  if (process.env.LOG_LEVEL === "debug") console.error(err.stack);
  process.exit(1);
});
