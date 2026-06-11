// Copyright (c) 2026 Claudius Tiberiu Iacob — Licensed under BSL 1.1. See LICENSE for details.
/**
 * @int3gra/engine - storage.js
 *
 * File-backed key/value store scoped to an integration instance.
 * Data is persisted to storage/store.json inside the integration directory.
 * Survives process restarts — intended for token storage and similar runtime state.
 *
 * The store is loaded once at boot and flushed to disk after every write.
 * All values must be JSON-serialisable.
 *
 * Pure helpers (readStoreFile, writeStoreFile, applySet, applyDelete)
 * are exported for unit testing without touching the filesystem.
 */

import { readFile, writeFile, mkdir } from "fs/promises";
import { resolve, dirname }           from "path";
import { logger }                     from "./logger.js";

const STORE_FILENAME = "store.json";

// ── Pure helpers (filesystem-free, fully testable) ────────────────────────────

/**
 * Returns a new store object with the key set to value.
 * Pure — does not mutate the input.
 */
export function applySet(store, key, value) {
  return { ...store, [key]: value };
}

/**
 * Returns a new store object with the key removed.
 * Pure — does not mutate the input.
 */
export function applyDelete(store, key) {
  const copy = { ...store };
  delete copy[key];
  return copy;
}

/**
 * Parses raw JSON text into a store object.
 * Returns an empty object on any parse failure rather than throwing.
 */
export function parseStoreFile(text) {
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
    return {};
  } catch {
    return {};
  }
}

/**
 * Serialises a store object to JSON text.
 * Pure — no side effects.
 */
export function serialiseStore(store) {
  return JSON.stringify(store, null, 2) + "\n";
}

// ── Filesystem I/O ────────────────────────────────────────────────────────────

/**
 * Reads the store file from disk.
 * Returns an empty object if the file does not exist.
 */
export async function readStoreFile(storePath) {
  try {
    const text = await readFile(storePath, "utf-8");
    return parseStoreFile(text);
  } catch (err) {
    if (err.code === "ENOENT") return {};
    throw err;
  }
}

/**
 * Writes the store object to disk, creating the directory if needed.
 */
export async function writeStoreFile(storePath, store) {
  await mkdir(dirname(storePath), { recursive: true });
  await writeFile(storePath, serialiseStore(store), "utf-8");
}

// ── Storage instance factory ──────────────────────────────────────────────────

/**
 * Creates a storage instance backed by a file at <cwd>/storage/store.json.
 *
 * The in-memory cache is loaded lazily on first access.
 * Every write flushes to disk immediately.
 *
 * API:
 *   await storage.get(key)           → value | undefined
 *   await storage.set(key, value)    → void
 *   await storage.delete(key)        → void
 *   await storage.all()              → { ...store }
 *   await storage.has(key)           → boolean
 */
export function createStorage(cwd) {
  const storePath = resolve(cwd, "storage", STORE_FILENAME);
  let   cache     = null;   // null = not yet loaded

  async function load() {
    if (cache === null) {
      cache = await readStoreFile(storePath);
      logger.debug("storage.loaded", { path: storePath, keys: Object.keys(cache).length });
    }
    return cache;
  }

  async function flush() {
    await writeStoreFile(storePath, cache);
    logger.debug("storage.flushed", { path: storePath });
  }

  return {
    async get(key) {
      const store = await load();
      return store[key];
    },

    async set(key, value) {
      await load();
      cache = applySet(cache, key, value);
      await flush();
    },

    async delete(key) {
      await load();
      cache = applyDelete(cache, key);
      await flush();
    },

    async all() {
      const store = await load();
      return { ...store };
    },

    async has(key) {
      const store = await load();
      return key in store;
    },
  };
}
