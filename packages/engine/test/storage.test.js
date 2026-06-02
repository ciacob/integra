/**
 * packages/engine/test/storage.test.js
 *
 * Unit tests for the storage layer.
 * Pure helper functions are tested without touching the filesystem.
 * The storage instance is tested with a temp directory.
 */

import { mkdtemp, rm }       from "fs/promises";
import { tmpdir }            from "os";
import { join }              from "path";
import {
  applySet,
  applyDelete,
  parseStoreFile,
  serialiseStore,
  readStoreFile,
  writeStoreFile,
  createStorage,
} from "../src/storage.js";

// ── Pure helpers ──────────────────────────────────────────────────────────────

describe("applySet", () => {
  test("adds a new key", () => {
    expect(applySet({}, "a", 1)).toEqual({ a: 1 });
  });

  test("overwrites an existing key", () => {
    expect(applySet({ a: 1 }, "a", 2)).toEqual({ a: 2 });
  });

  test("does not mutate the input", () => {
    const original = { a: 1 };
    applySet(original, "b", 2);
    expect(original).toEqual({ a: 1 });
  });

  test("preserves other keys", () => {
    expect(applySet({ a: 1, b: 2 }, "c", 3)).toEqual({ a: 1, b: 2, c: 3 });
  });
});

describe("applyDelete", () => {
  test("removes an existing key", () => {
    expect(applyDelete({ a: 1, b: 2 }, "a")).toEqual({ b: 2 });
  });

  test("is a no-op for a missing key", () => {
    expect(applyDelete({ a: 1 }, "b")).toEqual({ a: 1 });
  });

  test("does not mutate the input", () => {
    const original = { a: 1 };
    applyDelete(original, "a");
    expect(original).toEqual({ a: 1 });
  });
});

describe("parseStoreFile", () => {
  test("parses valid JSON object", () => {
    expect(parseStoreFile('{"a":1}')).toEqual({ a: 1 });
  });

  test("returns empty object for invalid JSON", () => {
    expect(parseStoreFile("not json")).toEqual({});
  });

  test("returns empty object for JSON array (not an object)", () => {
    expect(parseStoreFile("[1,2,3]")).toEqual({});
  });

  test("returns empty object for null JSON", () => {
    expect(parseStoreFile("null")).toEqual({});
  });

  test("returns empty object for empty string", () => {
    expect(parseStoreFile("")).toEqual({});
  });

  test("preserves nested objects", () => {
    const input = { token: { access_token: "abc", expires_in: 3600 } };
    expect(parseStoreFile(JSON.stringify(input))).toEqual(input);
  });
});

describe("serialiseStore", () => {
  test("produces valid JSON ending with newline", () => {
    const text = serialiseStore({ a: 1 });
    expect(() => JSON.parse(text)).not.toThrow();
    expect(text.endsWith("\n")).toBe(true);
  });

  test("round-trips with parseStoreFile", () => {
    const original = { token: { access_token: "xyz", expires_in: 3600 } };
    expect(parseStoreFile(serialiseStore(original))).toEqual(original);
  });
});

// ── Filesystem-backed store ───────────────────────────────────────────────────

describe("readStoreFile / writeStoreFile", () => {
  let tmpDir;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "integra-storage-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("readStoreFile returns empty object when file does not exist", async () => {
    const result = await readStoreFile(join(tmpDir, "nonexistent.json"));
    expect(result).toEqual({});
  });

  test("writeStoreFile creates file and readStoreFile reads it back", async () => {
    const path  = join(tmpDir, "store.json");
    const store = { token: { access_token: "abc" } };
    await writeStoreFile(path, store);
    expect(await readStoreFile(path)).toEqual(store);
  });

  test("writeStoreFile creates missing directories", async () => {
    const path = join(tmpDir, "nested", "deep", "store.json");
    await writeStoreFile(path, { a: 1 });
    expect(await readStoreFile(path)).toEqual({ a: 1 });
  });
});

describe("createStorage", () => {
  let tmpDir;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "integra-storage-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("get returns undefined for missing key", async () => {
    const s = createStorage(tmpDir);
    expect(await s.get("missing")).toBeUndefined();
  });

  test("set persists and get retrieves", async () => {
    const s = createStorage(tmpDir);
    await s.set("token", { access_token: "abc" });
    expect(await s.get("token")).toEqual({ access_token: "abc" });
  });

  test("persists across separate storage instances (same directory)", async () => {
    const s1 = createStorage(tmpDir);
    await s1.set("key", "value");

    const s2 = createStorage(tmpDir);
    expect(await s2.get("key")).toBe("value");
  });

  test("delete removes a key", async () => {
    const s = createStorage(tmpDir);
    await s.set("key", "value");
    await s.delete("key");
    expect(await s.get("key")).toBeUndefined();
  });

  test("has returns true for existing key", async () => {
    const s = createStorage(tmpDir);
    await s.set("k", 1);
    expect(await s.has("k")).toBe(true);
  });

  test("has returns false for missing key", async () => {
    const s = createStorage(tmpDir);
    expect(await s.has("missing")).toBe(false);
  });

  test("all returns a snapshot of the store", async () => {
    const s = createStorage(tmpDir);
    await s.set("a", 1);
    await s.set("b", 2);
    expect(await s.all()).toEqual({ a: 1, b: 2 });
  });

  test("all snapshot does not reflect subsequent mutations", async () => {
    const s       = createStorage(tmpDir);
    await s.set("a", 1);
    const snap    = await s.all();
    await s.set("b", 2);
    expect(snap).toEqual({ a: 1 });
  });
});
