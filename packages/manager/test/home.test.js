// Copyright (c) 2026 Claudius Tiberiu Iacob — Licensed under BSL 1.1. See LICENSE for details.
/**
 * packages/manager/test/home.test.js
 *
 * home.js's home is a literal constant (/opt/integra) with no override
 * mechanism by design — see home.js's own docstring. These tests never
 * touch that real path; they exercise assertIntegraHomeExists,
 * readHomeConfig, and writeHomeConfig with an explicit `home` argument,
 * which those functions already support as ordinary parameters (distinct
 * from resolveIntegraHome, which takes none and is not meant to be
 * redirected anywhere, including in tests).
 */

import { mkdtemp, rm, writeFile, mkdir } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { resolveIntegraHome, assertIntegraHomeExists,
         readHomeConfig, writeHomeConfig } from "../src/home.js";

describe("resolveIntegraHome", () => {
  test("returns the fixed /opt/integra constant", () => {
    expect(resolveIntegraHome()).toBe("/opt/integra");
  });

  test("returns the same value on repeated calls", () => {
    expect(resolveIntegraHome()).toBe(resolveIntegraHome());
  });
});

describe("assertIntegraHomeExists", () => {
  let dir;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  test("does not throw when the given path exists and is a directory", async () => {
    dir = await mkdtemp(join(tmpdir(), "integra-home-test-"));
    expect(() => assertIntegraHomeExists(dir)).not.toThrow();
  });

  test("throws a clear, actionable error when the given path does not exist", () => {
    const missing = join(tmpdir(), "integra-definitely-does-not-exist-12345");
    expect(() => assertIntegraHomeExists(missing)).toThrow(/run `integra setup` as sudo/i);
  });

  test("throws when the given path exists but is a file, not a directory", async () => {
    dir = await mkdtemp(join(tmpdir(), "integra-home-test-"));
    const filePath = join(dir, "not-a-directory");
    await writeFile(filePath, "");
    expect(() => assertIntegraHomeExists(filePath)).toThrow(/run `integra setup` as sudo/i);
  });
});

describe("readHomeConfig / writeHomeConfig", () => {
  let dir;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  test("readHomeConfig returns null when config.json doesn't exist yet", async () => {
    dir = await mkdtemp(join(tmpdir(), "integra-home-test-"));
    await expect(readHomeConfig(dir)).resolves.toBeNull();
  });

  test("writeHomeConfig creates the directory and writes config.json", async () => {
    dir = join(await mkdtemp(join(tmpdir(), "integra-home-test-")), "nested", "home");
    await writeHomeConfig({ foo: "bar" }, dir);
    await expect(readHomeConfig(dir)).resolves.toEqual({ foo: "bar" });
  });

  test("writeHomeConfig followed by readHomeConfig round-trips an empty config", async () => {
    dir = await mkdtemp(join(tmpdir(), "integra-home-test-"));
    await writeHomeConfig({}, dir);
    await expect(readHomeConfig(dir)).resolves.toEqual({});
  });
});
