#!/usr/bin/env node
// Copyright (c) 2026 Claudius Tiberiu Iacob — Licensed under BSL 1.1. See LICENSE for details.
/**
 * @int3gra/cli - index.js
 * Minimal command dispatcher. No framework needed.
 */

import { init }     from "./commands/init.js";
import { validate } from "./commands/validate.js";
import { run }      from "./commands/run.js";
import { test }     from "./commands/test.js";
import { ping }     from "./commands/ping.js";
import { setup }    from "./commands/setup.js";

const [,, command, ...args] = process.argv;

const commands = { init, validate, run, test, ping, setup };

if (!command || command === "--help" || command === "-h") {
  console.log(`
int3gra — integration engine CLI

Commands:
  integra setup                     One-off host provisioning. Run once, as root (sudo).
                                     Creates /opt/integra, integra's fixed home.
  integra init <name>              Scaffold a new integration environment
  integra validate                 Validate components and processes (no execution)
  integra run <process-id>         Execute a process in the current directory
  integra run <process-id> --env <file>  Run with a specific env file (default: .env)
  integra test                     Mock-test the integration using fixture files
  integra ping                     Fire the no-op connection and report reachability
  integra ping --con <id>[,<id>]   Ping specific connection(s) — comma-separated
  integra ping --env <file>        Ping with a specific env file

Options:
  --help, -h                       Show this help message
  `);
  process.exit(0);
}

const fn = commands[command];

if (!fn) {
  console.error(`Unknown command: ${command}`);
  console.error(`Run 'integra --help' for available commands.`);
  process.exit(1);
}

fn(args).catch(err => {
  console.error(`\n[integra] Error: ${err.message}`);
  if (process.env.LOG_LEVEL === "debug") console.error(err.stack);
  process.exit(1);
});
