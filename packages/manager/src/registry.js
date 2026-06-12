// Copyright (c) 2026 Claudius Tiberiu Iacob — Licensed under BSL 1.1. See LICENSE for details.
/**
 * @int3gra/manager - registry.js
 * Reads, validates, and writes the integration registry (registry.json).
 */

import { readFile, writeFile } from "fs/promises";
import { resolve }             from "path";
import { fileURLToPath }       from "url";
import Ajv                     from "ajv";

const __dirname      = resolve(fileURLToPath(import.meta.url), "..");
const REGISTRY_FILE  = "registry.json";
const SCHEMA_FILE    = resolve(__dirname, "../schemas/registry.schema.json");

async function loadRegistrySchema() {
  try {
    const raw = await readFile(SCHEMA_FILE, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null; // schema file absent — skip validation
  }
}

function validateRegistryData(data, schema) {
  if (!schema) return;
  const ajv      = new Ajv({ allErrors: true });
  const validate = ajv.compile(schema);
  if (!validate(data)) {
    const errors = validate.errors
      .map(e => `  ${e.instancePath || "(root)"} ${e.message}`)
      .join("\n");
    throw new Error(`registry.json validation failed:\n${errors}`);
  }
}

export async function loadRegistry(cwd = process.cwd()) {
  const path = resolve(cwd, REGISTRY_FILE);
  let raw, data;

  try {
    raw  = await readFile(path, "utf-8");
    data = JSON.parse(raw);
  } catch (err) {
    if (err.code === "ENOENT") {
      throw new Error(`No registry.json found at ${path}. Run 'integra-manager init' first.`);
    }
    throw err;
  }

  validateRegistryData(data, await loadRegistrySchema());
  return data.integrations ?? [];
}

export async function saveRegistry(integrations, cwd = process.cwd()) {
  const path = resolve(cwd, REGISTRY_FILE);
  const data = { integrations };
  validateRegistryData(data, await loadRegistrySchema());
  await writeFile(path, JSON.stringify(data, null, 2) + "\n");
}

export async function setEnabled(id, enabled, cwd = process.cwd()) {
  const integrations = await loadRegistry(cwd);
  const entry = integrations.find(i => i.id === id);
  if (!entry) throw new Error(`Integration not found in registry: ${id}`);
  entry.enabled = enabled;
  await saveRegistry(integrations, cwd);
  return entry;
}
