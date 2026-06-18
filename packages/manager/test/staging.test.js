// Copyright (c) 2026 Claudius Tiberiu Iacob — Licensed under BSL 1.1. See LICENSE for details.
import { mkdtemp, rm, readFile, writeFile, stat } from "fs/promises";
import { tmpdir } from "os";
import { join }   from "path";

import { seedStagingFile, readStagingFile, stagingFilePath, defaultStagingDir } from "../src/staging.js";

describe("staging.js", () => {
  let dir;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "integra-staging-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // ── defaultStagingDir ─────────────────────────────────────────────────────

  test("defaultStagingDir respects INTEGRA_STAGING_DIR override", () => {
    const prior = process.env.INTEGRA_STAGING_DIR;
    process.env.INTEGRA_STAGING_DIR = "/tmp/custom-staging";
    expect(defaultStagingDir()).toBe("/tmp/custom-staging");
    if (prior === undefined) delete process.env.INTEGRA_STAGING_DIR;
    else process.env.INTEGRA_STAGING_DIR = prior;
  });

  test("defaultStagingDir falls back to ~/integra without override", () => {
    const prior = process.env.INTEGRA_STAGING_DIR;
    delete process.env.INTEGRA_STAGING_DIR;
    expect(defaultStagingDir()).toMatch(/integra$/);
    if (prior !== undefined) process.env.INTEGRA_STAGING_DIR = prior;
  });

  // ── seedStagingFile ───────────────────────────────────────────────────────

  test("seedStagingFile writes content as pretty JSON", async () => {
    const path = await seedStagingFile(dir, "my-id", { id: "my-id", path: "./my-id" }, 1000);
    const raw  = await readFile(path, "utf-8");
    expect(JSON.parse(raw)).toEqual({ id: "my-id", path: "./my-id" });
  });

  test("seedStagingFile creates the staging directory if absent", async () => {
    const nested = join(dir, "nested", "deeper");
    await seedStagingFile(nested, "my-id", { id: "my-id", path: "./x" }, 1000);
    const path = stagingFilePath(nested, "my-id");
    await expect(stat(path)).resolves.toBeDefined();
  });

  test("seedStagingFile archives a pre-existing staging file rather than overwriting silently", async () => {
    const path = stagingFilePath(dir, "my-id");
    await writeFile(path, JSON.stringify({ id: "my-id", path: "./old" }));

    await seedStagingFile(dir, "my-id", { id: "my-id", path: "./new" }, 5_000_000);

    // Fresh content at the canonical path
    const fresh = JSON.parse(await readFile(path, "utf-8"));
    expect(fresh.path).toBe("./new");

    // Old content preserved under an archived name
    const archivedPath = `${path}.old_5000`;
    const archived = JSON.parse(await readFile(archivedPath, "utf-8"));
    expect(archived.path).toBe("./old");
  });

  // ── readStagingFile ───────────────────────────────────────────────────────

  test("readStagingFile parses valid JSON", async () => {
    const path = await seedStagingFile(dir, "x", { id: "x", path: "./x" }, 1000);
    const data = await readStagingFile(path);
    expect(data.id).toBe("x");
  });

  test("readStagingFile throws a descriptive error for a missing file", async () => {
    await expect(readStagingFile(join(dir, "nonexistent.registry.json")))
      .rejects.toThrow(/staging file not found.*checkout/is);
  });

  test("readStagingFile throws a descriptive error for malformed JSON", async () => {
    const path = join(dir, "broken.registry.json");
    await writeFile(path, "{not valid json");
    await expect(readStagingFile(path)).rejects.toThrow(/not valid json/i);
  });
});
