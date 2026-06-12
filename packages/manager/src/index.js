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

const [,, command, ...args] = process.argv;

const HELP = `
integra-manager — integration supervisor

Commands:
  integra-manager start [--env file] Start all enabled integrations.
                                     --env: env file to use (default: .env per integration).
                                     Behaviour depends on lifecycle (see below).
  integra-manager stop <id>          Stop an integration and any associated processes
  integra-manager restart <id>       Restart an integration (targets the right process per lifecycle)
  integra-manager status             Show all integrations — lifecycle, status, uptime, tc column
  integra-manager logs <id>          Tail integration logs
  integra-manager enable <id>        Enable an integration in the registry
  integra-manager disable <id>       Stop then disable an integration in the registry

Lifecycles (declared in integra.json, or derived from registry.json):
  (absent)    Run-once. Starts, executes entry process, exits.
  scheduled   TrafficController fires entry on cron schedule (schedule field in registry.json).
  listener    Long-lived Fastify HTTP server. Fires entry on each inbound request. autorestart: true.

Registry fields:
  id          Unique integration identifier
  path        Relative path to the integration directory
  enabled     true | false
  schedule    Cron expression — makes the integration "scheduled"  e.g. "*/5 * * * *"
  max_ttl     Seconds before TC forcibly kills a runaway scheduled integration

Run from the directory containing registry.json.
`;

async function main() {
  if (!command || command === "--help" || command === "-h") {
    console.log(HELP);
    process.exit(0);
  }

  const cwd = process.cwd();

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
