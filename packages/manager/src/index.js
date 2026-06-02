#!/usr/bin/env node
/**
 * @integra/manager - index.js
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
  integra-manager start              Start all enabled integrations.
                                     Scheduled integrations register a TrafficController
                                     (TC) which fires them on their cron schedule.
                                     Unscheduled integrations start directly.
  integra-manager stop <id>          Stop a specific integration (and its TC if present)
  integra-manager restart <id>       Restart a specific integration (or its TC if scheduled)
  integra-manager status             Show status of all integrations (tc column = TC state)
  integra-manager logs <id>          Tail integration logs
  integra-manager enable <id>        Enable an integration in the registry
  integra-manager disable <id>       Disable an integration in the registry

Registry fields:
  id          Unique integration identifier
  path        Relative path to the integration directory
  enabled     true | false
  schedule    Optional cron expression  e.g. "*/5 * * * *"
  max_ttl     Optional max run time in seconds before TC forcibly restarts the integration

Run from the directory containing registry.json.
`;

async function main() {
  if (!command || command === "--help" || command === "-h") {
    console.log(HELP);
    process.exit(0);
  }

  const cwd = process.cwd();

  switch (command) {
    case "start":
      await startAll(cwd);
      console.log("✓ All enabled integrations started.");
      break;

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
