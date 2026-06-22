// Copyright (c) 2026 Claudius Tiberiu Iacob — Licensed under BSL 1.1. See LICENSE for details.
import { mkdtemp, rm, mkdir, writeFile, stat, utimes } from "fs/promises";
import { tmpdir } from "os";
import { join }   from "path";

import { sweepOnce, SWEEP_THRESHOLD_MS } from "../src/sweep.js";

describe("sweepOnce", () => {
  let cwd;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "integra-sweep-test-"));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  async function makeArchiveFolder(id, sha, fileMtimeMs) {
    const dir = join(cwd, ".integrations", id, "tests", sha);
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, "integra.json");
    await writeFile(filePath, "{}");
    if (fileMtimeMs !== undefined) {
      const t = fileMtimeMs / 1000;
      await utimes(filePath, t, t);
    }
    return dir;
  }

  // ── No .integrations/ at all ────────────────────────────────────────────────

  test("returns cleanly with nothing to do when .integrations/ doesn't exist", async () => {
    const result = await sweepOnce(cwd);
    expect(result).toEqual({ removed: [], remaining: 0, nothingLeftToSweep: true });
  });

  // ── Threshold behaviour ──────────────────────────────────────────────────────

  test("removes a folder whose newest file is older than the threshold", async () => {
    const now = 10_000_000;
    const dir = await makeArchiveFolder("my-int", "sha1", now - SWEEP_THRESHOLD_MS - 1000);

    const result = await sweepOnce(cwd, { now });

    expect(result.removed).toEqual([dir]);
    await expect(stat(dir)).rejects.toThrow();
  });

  test("keeps a folder whose newest file is within the threshold", async () => {
    const now = 10_000_000;
    const dir = await makeArchiveFolder("my-int", "sha1", now - 1000); // 1 second old

    const result = await sweepOnce(cwd, { now });

    expect(result.removed).toEqual([]);
    await expect(stat(dir)).resolves.toBeDefined();
  });

  test("a folder exactly at the threshold boundary is removed (inclusive)", async () => {
    const now = 10_000_000;
    const dir = await makeArchiveFolder("my-int", "sha1", now - SWEEP_THRESHOLD_MS);

    const result = await sweepOnce(cwd, { now });
    expect(result.removed).toEqual([dir]);
  });

  test("custom thresholdMs is respected (test override, not the production constant)", async () => {
    const now = 10_000_000;
    const dir = await makeArchiveFolder("my-int", "sha1", now - 5000);

    // With a tiny custom threshold, this folder is now stale
    const result = await sweepOnce(cwd, { now, thresholdMs: 1000 });
    expect(result.removed).toEqual([dir]);
  });

  // ── Recursive mtime — judged by newest file, not folder mtime or oldest file ─

  test("judges a folder by its NEWEST file, not its oldest", async () => {
    const now = 10_000_000;
    const dir = join(cwd, ".integrations", "my-int", "tests", "sha1");
    await mkdir(dir, { recursive: true });

    const oldFile = join(dir, "old.json");
    const newFile = join(dir, "new.json");
    await writeFile(oldFile, "{}");
    await writeFile(newFile, "{}");

    const oldT = (now - SWEEP_THRESHOLD_MS - 5000) / 1000;
    const newT = (now - 1000) / 1000; // recently touched
    await utimes(oldFile, oldT, oldT);
    await utimes(newFile, newT, newT);

    const result = await sweepOnce(cwd, { now });

    // Newest file is recent, so the folder must be kept despite the old file
    expect(result.removed).toEqual([]);
    await expect(stat(dir)).resolves.toBeDefined();
  });

  test("walks nested subdirectories, not just the top level", async () => {
    const now = 10_000_000;
    const dir = join(cwd, ".integrations", "my-int", "tests", "sha1");
    const nested = join(dir, "connections", "deep");
    await mkdir(nested, { recursive: true });

    const topFile    = join(dir, "integra.json");
    const nestedFile = join(nested, "x.json");
    await writeFile(topFile, "{}");
    await writeFile(nestedFile, "{}");

    const oldT = (now - SWEEP_THRESHOLD_MS - 5000) / 1000;
    const newT = (now - 1000) / 1000;
    await utimes(topFile, oldT, oldT);
    await utimes(nestedFile, newT, newT); // the recent file is deeply nested

    const result = await sweepOnce(cwd, { now });

    // Must be kept — the nested file is recent, even though the top-level one is old
    expect(result.removed).toEqual([]);
  });

  // ── Empty folders ────────────────────────────────────────────────────────────

  test("a folder with zero files is judged stale regardless of its own creation time", async () => {
    const now = 10_000_000;
    const dir = join(cwd, ".integrations", "my-int", "tests", "sha-empty");
    await mkdir(dir, { recursive: true }); // no files inside at all

    const result = await sweepOnce(cwd, { now });

    expect(result.removed).toEqual([dir]);
  });

  // ── Multiple integrations and folders ────────────────────────────────────────

  test("sweeps across multiple integrations independently", async () => {
    const now = 10_000_000;
    const staleDir = await makeArchiveFolder("int-a", "sha1", now - SWEEP_THRESHOLD_MS - 1000);
    const freshDir = await makeArchiveFolder("int-b", "sha2", now - 1000);

    const result = await sweepOnce(cwd, { now });

    expect(result.removed).toEqual([staleDir]);
    await expect(stat(freshDir)).resolves.toBeDefined();
  });

  test("removes multiple stale folders within the same integration", async () => {
    const now = 10_000_000;
    const stale1 = await makeArchiveFolder("my-int", "sha1", now - SWEEP_THRESHOLD_MS - 1000);
    const stale2 = await makeArchiveFolder("my-int", "sha2", now - SWEEP_THRESHOLD_MS - 2000);

    const result = await sweepOnce(cwd, { now });

    expect(result.removed.sort()).toEqual([stale1, stale2].sort());
  });

  // ── nothingLeftToSweep ────────────────────────────────────────────────────────

  test("nothingLeftToSweep is true after removing the only stale folder", async () => {
    const now = 10_000_000;
    await makeArchiveFolder("my-int", "sha1", now - SWEEP_THRESHOLD_MS - 1000);

    const result = await sweepOnce(cwd, { now });
    expect(result.nothingLeftToSweep).toBe(true);
  });

  test("nothingLeftToSweep is false when a fresh folder remains", async () => {
    const now = 10_000_000;
    await makeArchiveFolder("my-int", "sha1", now - 1000);

    const result = await sweepOnce(cwd, { now });
    expect(result.nothingLeftToSweep).toBe(false);
    expect(result.remaining).toBe(1);
  });

  test("nothingLeftToSweep accounts for folders across ALL integrations, not just one", async () => {
    const now = 10_000_000;
    await makeArchiveFolder("int-a", "sha1", now - SWEEP_THRESHOLD_MS - 1000); // will be removed
    await makeArchiveFolder("int-b", "sha2", now - 1000);                      // stays fresh

    const result = await sweepOnce(cwd, { now });
    expect(result.nothingLeftToSweep).toBe(false);
  });
});
