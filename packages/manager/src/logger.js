/**
 * @int3gra/manager - logger.js
 * Structured logger for the manager process itself.
 * Same format as the engine logger for a coherent log stream.
 */

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLevel = LEVELS[process.env.LOG_LEVEL ?? "info"] ?? 1;

function log(level, event, fields = {}) {
  if (LEVELS[level] < currentLevel) return;
  const entry = {
    ts: new Date().toISOString(),
    level,
    source: "manager",
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
