// Copyright (c) 2026 Claudius Tiberiu Iacob — Licensed under BSL 1.1. See LICENSE for details.
import { mkdtemp, rm } from "fs/promises";
import { tmpdir }      from "os";
import { join }        from "path";

import { loadRegistry, setEnabled } from "../src/registry.js";
import { publishEntry, readEntry }  from "../src/registryStorage.js";
import { checkout }                 from "../src/commands/checkout.js";
import { readLock }                 from "../src/lock.js";

describe("registry.js facade", () => {
  let cwd, stagingDir;

  beforeEach(async () => {
    cwd        = await mkdtemp(join(tmpdir(), "integra-facade-cwd-"));
    stagingDir = await mkdtemp(join(tmpdir(), "integra-facade-staging-"));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
    await rm(stagingDir, { recursive: true, force: true });
  });

  async function asUser(name, fn) {
    const prior = process.env.INTEGRA_USER;
    process.env.INTEGRA_USER = name;
    try { return await fn(); }
    finally {
      if (prior === undefined) delete process.env.INTEGRA_USER;
      else process.env.INTEGRA_USER = prior;
    }
  }

  // ── loadRegistry passthrough ────────────────────────────────────────────

  test("loadRegistry returns the flat array from registry.d/", async () => {
    await publishEntry(cwd, "a", { id: "a", path: "./a" });
    await publishEntry(cwd, "b", { id: "b", path: "./b" });

    const entries = await loadRegistry(cwd);
    expect(entries.map(e => e.id).sort()).toEqual(["a", "b"]);
  });

  // ── setEnabled — happy path ──────────────────────────────────────────────

  test("setEnabled flips the enabled flag and persists it", async () => {
    await publishEntry(cwd, "my-int", { id: "my-int", path: "./my-int", enabled: true });

    await asUser("alice", () => setEnabled("my-int", false, cwd, { now: 1000 }));

    const entry = await readEntry(cwd, "my-int");
    expect(entry.enabled).toBe(false);
  });

  test("setEnabled releases its internal lock after success", async () => {
    await publishEntry(cwd, "my-int", { id: "my-int", path: "./my-int", enabled: true });
    await asUser("alice", () => setEnabled("my-int", false, cwd, { now: 1000 }));
    expect(await readLock(cwd, "my-int")).toBeNull();
  });

  test("setEnabled throws clearly when the integration does not exist", async () => {
    await expect(asUser("alice", () => setEnabled("nonexistent", true, cwd, { now: 1000 })))
      .rejects.toThrow(/not found in registry/i);
  });

  test("setEnabled releases its lock even when the entry doesn't exist (no leaked lock on failure)", async () => {
    await expect(asUser("alice", () => setEnabled("nonexistent", true, cwd, { now: 1000 })))
      .rejects.toThrow();
    expect(await readLock(cwd, "nonexistent")).toBeNull();
  });

  // ── setEnabled — respects existing human locks ──────────────────────────

  test("setEnabled is rejected while another user holds a live checkout on the same id", async () => {
    await publishEntry(cwd, "contested", { id: "contested", path: "./contested" });
    await asUser("alice", () => checkout("contested", { cwd, stagingDir, now: 1000 }));

    await expect(asUser("bob", () => setEnabled("contested", false, cwd, { now: 1200 })))
      .rejects.toThrow(/checked out by "alice"/);
  });

  test("setEnabled does not corrupt the entry when blocked by another user's lock", async () => {
    await publishEntry(cwd, "contested", { id: "contested", path: "./contested", enabled: true });
    await asUser("alice", () => checkout("contested", { cwd, stagingDir, now: 1000 }));

    await expect(asUser("bob", () => setEnabled("contested", false, cwd, { now: 1200 })))
      .rejects.toThrow();

    const entry = await readEntry(cwd, "contested");
    expect(entry.enabled).toBe(true); // untouched
  });

  test("setEnabled succeeds once a blocking lock has expired", async () => {
    await publishEntry(cwd, "contested", { id: "contested", path: "./contested", enabled: true });
    await asUser("alice", () => checkout("contested", { cwd, stagingDir, now: 1000, ttlMs: 500 })); // expires 1500

    await asUser("bob", () => setEnabled("contested", false, cwd, { now: 5000 }));

    const entry = await readEntry(cwd, "contested");
    expect(entry.enabled).toBe(false);
  });
});
