// Copyright (c) 2026 Claudius Tiberiu Iacob — Licensed under BSL 1.1. See LICENSE for details.
/**
 * @int3gra/manager - commands/logs.js
 * Tails the out.log for a given integration.
 */

import { createReadStream } from "fs";
import { resolve, join }    from "path";
import { loadRegistry }     from "../registry.js";

export async function createTailStream(id, cwd) {
  const integrations = await loadRegistry(cwd);
  const entry        = integrations.find(i => i.id === id);

  if (!entry) {
    throw new Error(`Integration not found in registry: ${id}`);
  }

  const logPath = join(resolve(cwd, entry.path), "logs", "out.log");

  console.log(`\nTailing logs for "${id}" — ${logPath}`);
  console.log(`(Ctrl+C to stop)\n`);

  // Simple tail: read existing content, then watch for changes
  const { watch } = await import("fs");
  const { createReadStream: crs } = await import("fs");

  let position = 0;

  function readNew() {
    const stream = crs(logPath, { start: position });
    stream.on("data", chunk => {
      position += chunk.length;
      process.stdout.write(chunk);
    });
    stream.on("error", () => {}); // file may not exist yet
  }

  readNew();
  watch(logPath, { persistent: true }, () => readNew());

  // Keep process alive
  await new Promise(() => {});
}
