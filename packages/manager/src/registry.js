/**
 * @integra/manager - registry.js
 * Reads and writes the integration registry (registry.json).
 * The registry lives one level above all integration directories.
 */

import { readFile, writeFile } from "fs/promises";
import { resolve }             from "path";

const REGISTRY_FILE = "registry.json";

export async function loadRegistry(cwd = process.cwd()) {
  const path = resolve(cwd, REGISTRY_FILE);
  try {
    const raw = await readFile(path, "utf-8");
    const data = JSON.parse(raw);
    return data.integrations ?? [];
  } catch (err) {
    if (err.code === "ENOENT") {
      throw new Error(`No registry.json found at ${path}. Run 'integra-manager init' first.`);
    }
    throw err;
  }
}

export async function saveRegistry(integrations, cwd = process.cwd()) {
  const path = resolve(cwd, REGISTRY_FILE);
  await writeFile(path, JSON.stringify({ integrations }, null, 2) + "\n");
}

export async function setEnabled(id, enabled, cwd = process.cwd()) {
  const integrations = await loadRegistry(cwd);
  const entry = integrations.find(i => i.id === id);
  if (!entry) throw new Error(`Integration not found in registry: ${id}`);
  entry.enabled = enabled;
  await saveRegistry(integrations, cwd);
  return entry;
}
