#!/usr/bin/env node
// Copyright (c) 2026 Claudius Tiberiu Iacob — Licensed under BSL 1.1. See LICENSE for details.
/**
 * @int3gra/cli - index.js
 * Minimal command dispatcher. No framework needed.
 */

import { init }      from "./commands/init.js";
import { duplicate } from "./commands/duplicate.js";
import { validate }  from "./commands/validate.js";
import { run }       from "./commands/run.js";
import { test }      from "./commands/test.js";
import { ping }      from "./commands/ping.js";
import { setup }     from "./commands/setup.js";

const [,, command, ...args] = process.argv;

const commands = { init, duplicate, validate, run, test, ping, setup };

if (!command || command === "--help" || command === "-h") {
  console.log(`
int3gra — integration engine CLI

Commands:
  integra setup                     One-off host provisioning. Run once, as root (sudo).
                                     Creates /opt/integra, integra's fixed home.
  integra init <path>               Scaffold a new integration; <path>'s last segment becomes its id
  integra duplicate <path> --id <source-id> --branch <name>
                                     Fork a new integration from another's pushed branch — independent
                                     history, own live/; <path>'s last segment becomes the new id
  integra validate --id <id> --branch <name>
                                     Validate components and processes for a pushed branch (no execution)
  integra run <process-id> --id <id> --branch <name> [--env <file>]
                                     Execute a process for real, against a pushed branch (default env: .env)
  integra test --id <id> --branch <name>
                                     Mock-test a pushed branch using fixture files (no real calls)
  integra ping --id <id> --branch <name> [--env <file>]
                                     Fire the no-op connection and report reachability
  integra ping --id <id> --branch <name> --con <id>[,<id>]
                                     Ping specific connection(s) — comma-separated

--id and --branch are mandatory on validate/run/test/ping — there is no
mode that operates on live/ directly, or on whatever's locally checked
out. Push a branch into live/ first, then verify it. See the root
README's "Git-backed deploy" section for the full model.

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
