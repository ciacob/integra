#!/usr/bin/env node
/**
 * @integra/cli - index.js
 * Minimal command dispatcher. No framework needed.
 */

import { init }     from "./commands/init.js";
import { validate } from "./commands/validate.js";
import { run }      from "./commands/run.js";

const [,, command, ...args] = process.argv;

const commands = { init, validate, run };

if (!command || command === "--help" || command === "-h") {
  console.log(`
integra — integration engine CLI

Commands:
  integra init <name>              Scaffold a new integration environment
  integra validate                 Validate components and processes (no execution)
  integra run <process-id>         Execute a process in the current directory

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
