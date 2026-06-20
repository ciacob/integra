// Copyright (c) 2026 Claudius Tiberiu Iacob — Licensed under BSL 1.1. See LICENSE for details.
/**
 * packages/cli/test/init.test.js
 *
 * Tests for the init command — scaffolding behaviour and automatic
 * registration in registry.d/ when one exists in the cwd.
 */

import { mkdtemp, rm, mkdir, readFile, stat, access } from "fs/promises";
import { tmpdir } from "os";
import { join, resolve } from "path";

import { init } from "../src/commands/init.js";

describe("integra init", () => {
  let cwd;
  let originalCwd;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "integra-init-test-"));
    // Capture cwd before switching — use homedir as a safe fallback in case
    // a previous test suite left process.cwd() pointing at a deleted temp dir.
    try {
      originalCwd = process.cwd();
      // Verify it's still accessible; if not, fall back to tmpdir
      await stat(originalCwd);
    } catch {
      originalCwd = tmpdir();
    }
    process.chdir(cwd);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(cwd, { recursive: true, force: true });
  });

  // ── Scaffolding ───────────────────────────────────────────────────────────

  test("throws when no name is given", async () => {
    await expect(init([])).rejects.toThrow(/usage/i);
  });

  test("creates the integration directory", async () => {
    await init(["my-integration"]);
    await expect(stat(join(cwd, "my-integration"))).resolves.toBeDefined();
  });

  test("writes integra.json with the correct id", async () => {
    await init(["my-integration"]);
    const manifest = JSON.parse(await readFile(join(cwd, "my-integration", "integra.json"), "utf-8"));
    expect(manifest.id).toBe("my-integration");
    expect(manifest.entry).toBeNull();
  });

  test("writes .env.example", async () => {
    await init(["my-integration"]);
    await expect(access(join(cwd, "my-integration", ".env.example"))).resolves.toBeUndefined();
  });

  test("throws when the target directory already exists", async () => {
    await mkdir(join(cwd, "existing"));
    await expect(init(["existing"])).rejects.toThrow(/already exists/i);
  });

  // ── registry.d/ registration ──────────────────────────────────────────────

  test("does NOT create a registry.d/ entry when no registry.d/ exists in cwd", async () => {
    await init(["my-integration"]);
    await expect(stat(join(cwd, "registry.d"))).rejects.toThrow();
  });

  test("creates a registry.d/ entry when registry.d/ exists in cwd", async () => {
    await mkdir(join(cwd, "registry.d"));
    await init(["my-integration"]);

    const entryPath = join(cwd, "registry.d", "my-integration.registry.json");
    await expect(stat(entryPath)).resolves.toBeDefined();
  });

  test("registered entry has correct id, path, and enabled:true", async () => {
    await mkdir(join(cwd, "registry.d"));
    await init(["my-integration"]);

    const raw   = await readFile(join(cwd, "registry.d", "my-integration.registry.json"), "utf-8");
    const entry = JSON.parse(raw);
    expect(entry.id).toBe("my-integration");
    expect(entry.path).toBe("./my-integration");
    expect(entry.enabled).toBe(true);
  });

  test("skips registration gracefully when a registry.d/ entry already exists for that id", async () => {
    await mkdir(join(cwd, "registry.d"));
    // Pre-existing entry with custom description
    const existing   = { id: "my-pre-existing", path: "./my-pre-existing", description: "pre-existing" };
    const entryPath  = join(cwd, "registry.d", "my-pre-existing.registry.json");
    const { writeFile } = await import("fs/promises");
    await writeFile(entryPath, JSON.stringify(existing));

    // init should complete without throwing (the integration dir doesn't exist yet)
    await expect(init(["my-pre-existing"])).resolves.toBeUndefined();

    // The pre-existing registry entry must be untouched
    const raw   = await readFile(entryPath, "utf-8");
    const entry = JSON.parse(raw);
    expect(entry.description).toBe("pre-existing");
  });

  test("integration directory name with hyphens becomes the entry id unchanged", async () => {
    await mkdir(join(cwd, "registry.d"));
    await init(["sn-to-jira-v2"]);

    const raw   = await readFile(join(cwd, "registry.d", "sn-to-jira-v2.registry.json"), "utf-8");
    const entry = JSON.parse(raw);
    expect(entry.id).toBe("sn-to-jira-v2");
    expect(entry.path).toBe("./sn-to-jira-v2");
  });
});
