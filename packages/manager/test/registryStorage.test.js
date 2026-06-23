// Copyright (c) 2026 Claudius Tiberiu Iacob — Licensed under BSL 1.1. See LICENSE for details.
import { mkdtemp, rm, mkdir, writeFile, readFile } from "fs/promises";
import { tmpdir } from "os";
import { join }   from "path";

import {
  loadEntries, readEntry, publishEntry, removeEntry,
  entryExists, validateEntry,
} from "../src/registryStorage.js";

describe("registryStorage", () => {
  let dir;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "integra-registry-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // ── loadEntries ───────────────────────────────────────────────────────────

  test("loadEntries throws a clear error when registry.d/ does not exist", async () => {
    await expect(loadEntries(dir)).rejects.toThrow(/no registry\.d/i);
  });

  test("loadEntries returns an empty array when registry.d/ exists but is empty", async () => {
    await mkdir(join(dir, "registry.d"));
    await expect(loadEntries(dir)).resolves.toEqual([]);
  });

  test("loadEntries returns all published entries", async () => {
    await mkdir(join(dir, "registry.d"));
    await writeFile(join(dir, "registry.d", "a.registry.json"), JSON.stringify({ id: "a", path: "./a" }));
    await writeFile(join(dir, "registry.d", "b.registry.json"), JSON.stringify({ id: "b", path: "./b" }));

    const entries = await loadEntries(dir);
    expect(entries).toHaveLength(2);
    expect(entries.map(e => e.id).sort()).toEqual(["a", "b"]);
  });

  test("loadEntries ignores non-matching files in the directory", async () => {
    await mkdir(join(dir, "registry.d"));
    await writeFile(join(dir, "registry.d", "a.registry.json"), JSON.stringify({ id: "a", path: "./a" }));
    await writeFile(join(dir, "registry.d", "README.md"), "not an entry");

    const entries = await loadEntries(dir);
    expect(entries).toHaveLength(1);
  });

  // ── readEntry ─────────────────────────────────────────────────────────────

  test("readEntry returns null for a non-existent id", async () => {
    await mkdir(join(dir, "registry.d"));
    expect(await readEntry(dir, "missing")).toBeNull();
  });

  test("readEntry returns parsed content for an existing id", async () => {
    await mkdir(join(dir, "registry.d"));
    await writeFile(join(dir, "registry.d", "a.registry.json"), JSON.stringify({ id: "a", path: "./a" }));
    const entry = await readEntry(dir, "a");
    expect(entry.id).toBe("a");
  });

  test("entryExists reflects presence correctly", async () => {
    await mkdir(join(dir, "registry.d"));
    expect(await entryExists(dir, "a")).toBe(false);
    await writeFile(join(dir, "registry.d", "a.registry.json"), JSON.stringify({ id: "a", path: "./a" }));
    expect(await entryExists(dir, "a")).toBe(true);
  });

  // ── validateEntry ─────────────────────────────────────────────────────────

  test("validateEntry accepts a minimal valid entry", async () => {
    await expect(validateEntry({ id: "a", path: "./a" })).resolves.toBeUndefined();
  });

  test("validateEntry rejects an entry missing required id", async () => {
    await expect(validateEntry({ path: "./a" })).rejects.toThrow();
  });

  test("validateEntry rejects an entry missing required path", async () => {
    await expect(validateEntry({ id: "a" })).rejects.toThrow();
  });

  test("validateEntry rejects unknown fields", async () => {
    await expect(validateEntry({ id: "a", path: "./a", bogus: true })).rejects.toThrow();
  });

  test("validateEntry accepts all documented optional fields", async () => {
    await expect(validateEntry({
      id: "a", path: "./a", enabled: true, description: "x",
      schedule: "*/5 * * * *", max_ttl: 60,
    })).resolves.toBeUndefined();
  });

  test("validateEntry rejects env_file — PM2-managed processes always use .env, no override", async () => {
    await expect(validateEntry({
      id: "a", path: "./a", env_file: ".env.dev",
    })).rejects.toThrow();
  });

  // ── publishEntry ──────────────────────────────────────────────────────────

  test("publishEntry writes a readable file", async () => {
    await publishEntry(dir, "a", { id: "a", path: "./a" });
    const entry = await readEntry(dir, "a");
    expect(entry.id).toBe("a");
  });

  test("publishEntry creates registry.d/ if it doesn't exist yet", async () => {
    await publishEntry(dir, "a", { id: "a", path: "./a" });
    expect(await entryExists(dir, "a")).toBe(true);
  });

  test("publishEntry rejects when content id does not match the target id", async () => {
    await expect(publishEntry(dir, "a", { id: "b", path: "./b" }))
      .rejects.toThrow(/declares id "b".*published as "a"/i);
  });

  test("publishEntry rejects invalid content (schema failure) without writing", async () => {
    await expect(publishEntry(dir, "a", { id: "a" /* missing path */ }))
      .rejects.toThrow();
    expect(await entryExists(dir, "a")).toBe(false);
  });

  test("publishEntry overwrites a previously published entry for the same id", async () => {
    await publishEntry(dir, "a", { id: "a", path: "./a", enabled: true });
    await publishEntry(dir, "a", { id: "a", path: "./a", enabled: false });
    const entry = await readEntry(dir, "a");
    expect(entry.enabled).toBe(false);
  });

  test("publishEntry does not leave a temp file behind on success", async () => {
    await publishEntry(dir, "a", { id: "a", path: "./a" });
    const { readdir } = await import("fs/promises");
    const files = await readdir(join(dir, "registry.d"));
    expect(files.every(f => !f.includes(".tmp_"))).toBe(true);
  });

  // ── removeEntry ───────────────────────────────────────────────────────────

  test("removeEntry deletes a published entry", async () => {
    await publishEntry(dir, "a", { id: "a", path: "./a" });
    await removeEntry(dir, "a");
    expect(await entryExists(dir, "a")).toBe(false);
  });

  test("removeEntry is a no-op (does not throw) when entry was already absent", async () => {
    await mkdir(join(dir, "registry.d"));
    await expect(removeEntry(dir, "nonexistent")).resolves.toBeUndefined();
  });
});
