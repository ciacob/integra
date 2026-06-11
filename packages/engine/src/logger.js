// Copyright (c) 2026 Claudius Tiberiu Iacob — Licensed under BSL 1.1. See LICENSE for details.
/**
 * @int3gra/engine - logger.js
 * Structured, newline-delimited JSON logger.
 * Writes to stdout. Level controlled by LOG_LEVEL env var.
 * Default level: info. Available: debug, info, warn, error.
 */

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLevel = LEVELS[process.env.LOG_LEVEL ?? "info"] ?? 1;

function log(level, event, fields = {}) {
  if (LEVELS[level] < currentLevel) return;

  const entry = {
    ts: new Date().toISOString(),
    level,
    event,
    ...fields,
  };

  process.stdout.write(JSON.stringify(entry) + "\n");
}

export const logger = {
  debug: (event, fields) => log("debug", event, fields),
  info:  (event, fields) => log("info",  event, fields),
  warn:  (event, fields) => log("warn",  event, fields),
  error: (event, fields) => log("error", event, fields),
};
