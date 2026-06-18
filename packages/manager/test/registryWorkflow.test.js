// Copyright (c) 2026 Claudius Tiberiu Iacob — Licensed under BSL 1.1. See LICENSE for details.
import { mkdtemp, rm, mkdir, writeFile, readFile, stat } from "fs/promises";
import { tmpdir } from "os";
import { join }   from "path";

import { checkout }    from "../src/commands/checkout.js";
import { publish }     from "../src/commands/publish.js";
import { uncheckout }  from "../src/commands/uncheckout.js";
import { deleteEntry } from "../src/commands/delete.js";
import { duplicate }   from "../src/commands/duplicate.js";
import { readEntry, entryExists, publishEntry } from "../src/registryStorage.js";
import { readLock } from "../src/lock.js";

describe("registry.d workflow — checkout / publish / delete / duplicate / uncheckout", () => {
  let cwd, stagingDir;

  beforeEach(async () => {
    cwd        = await mkdtemp(join(tmpdir(), "integra-cwd-"));
    stagingDir = await mkdtemp(join(tmpdir(), "integra-staging-"));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
    await rm(stagingDir, { recursive: true, force: true });
  });

  function alice(opts = {}) { return { cwd, stagingDir, now: 1000, ...opts }; }
  function bob(opts = {})   { return { cwd, stagingDir, now: 1000, ...opts }; }

  async function asUser(name, fn) {
    const prior = process.env.INTEGRA_USER;
    process.env.INTEGRA_USER = name;
    try { return await fn(); }
    finally {
      if (prior === undefined) delete process.env.INTEGRA_USER;
      else process.env.INTEGRA_USER = prior;
    }
  }

  // ── Happy path: checkout → edit → publish (new integration) ───────────────

  test("checkout on a brand-new id seeds a minimal template", async () => {
    const result = await asUser("alice", () => checkout("new-int", alice()));
    expect(result.isNew).toBe(true);

    const staged = JSON.parse(await readFile(result.stagingPath, "utf-8"));
    expect(staged.id).toBe("new-int");
    expect(staged.path).toBe("./new-int");
  });

  test("full new-integration lifecycle: checkout, edit, publish", async () => {
    const co = await asUser("alice", () => checkout("new-int", alice()));

    // Simulate the user editing the staged file
    const staged = JSON.parse(await readFile(co.stagingPath, "utf-8"));
    staged.description = "My new integration";
    staged.enabled = true;
    await writeFile(co.stagingPath, JSON.stringify(staged, null, 2));

    await asUser("alice", () => publish("new-int", undefined, alice()));

    const live = await readEntry(cwd, "new-int");
    expect(live.description).toBe("My new integration");
  });

  test("publish releases the lock on success", async () => {
    await asUser("alice", () => checkout("new-int", alice()));
    await asUser("alice", () => publish("new-int", undefined, alice({ now: 1500 })));
    expect(await readLock(cwd, "new-int")).toBeNull();
  });

  test("checkout on an existing id seeds from its live content", async () => {
    await publishEntry(cwd, "existing", { id: "existing", path: "./existing", description: "original" });

    const result = await asUser("alice", () => checkout("existing", alice()));
    expect(result.isNew).toBe(false);

    const staged = JSON.parse(await readFile(result.stagingPath, "utf-8"));
    expect(staged.description).toBe("original");
  });

  // ── Lock contention between two users ──────────────────────────────────────

  test("bob cannot checkout an id alice has already checked out", async () => {
    await asUser("alice", () => checkout("contested", alice()));

    await expect(asUser("bob", () => checkout("contested", bob({ now: 1200 }))))
      .rejects.toThrow(/already checked out by "alice"/);
  });

  test("bob cannot publish against alice's lock even with a valid staged file", async () => {
    await asUser("alice", () => checkout("contested", alice()));

    // Bob somehow has a file at the expected staging path (e.g. shared staging dir in this test)
    // — but he never acquired the lock, so publish must reject him regardless of file content.
    await expect(asUser("bob", () => publish("contested", undefined, bob({ now: 1200 }))))
      .rejects.toThrow(/checked out by "alice"/);
  });

  test("bob can checkout once alice's lock has expired", async () => {
    await asUser("alice", () => checkout("contested", alice({ ttlMs: 500 }))); // expires at 1500

    const result = await asUser("bob", () => checkout("contested", bob({ now: 5000 })));
    expect(result.holder).toBe("bob");
  });

  // ── uncheckout ────────────────────────────────────────────────────────────

  test("uncheckout releases the lock without publishing", async () => {
    await asUser("alice", () => checkout("temp-edit", alice()));
    await asUser("alice", () => uncheckout("temp-edit", alice({ now: 1200 })));

    expect(await readLock(cwd, "temp-edit")).toBeNull();
    expect(await entryExists(cwd, "temp-edit")).toBe(false); // never published
  });

  test("bob cannot uncheckout alice's lock", async () => {
    await asUser("alice", () => checkout("temp-edit", alice()));
    await expect(asUser("bob", () => uncheckout("temp-edit", bob({ now: 1200 }))))
      .rejects.toThrow(/checked out by "alice"/);
  });

  test("uncheckout on a non-existent lock throws", async () => {
    await expect(asUser("alice", () => uncheckout("never-checked-out", alice())))
      .rejects.toThrow(/no active checkout/i);
  });

  // ── publish validation ───────────────────────────────────────────────────

  test("publish rejects when staged content id doesn't match the publish target", async () => {
    const co = await asUser("alice", () => checkout("right-id", alice()));
    const staged = JSON.parse(await readFile(co.stagingPath, "utf-8"));
    staged.id = "wrong-id"; // user typo'd the id field
    await writeFile(co.stagingPath, JSON.stringify(staged));

    await expect(asUser("alice", () => publish("right-id", undefined, alice({ now: 1200 }))))
      .rejects.toThrow(/declares id "wrong-id"/);
  });

  test("publish rejects invalid schema content and leaves registry.d/ untouched", async () => {
    const co = await asUser("alice", () => checkout("bad-content", alice()));
    await writeFile(co.stagingPath, JSON.stringify({ id: "bad-content" /* missing path */ }));

    await expect(asUser("alice", () => publish("bad-content", undefined, alice({ now: 1200 }))))
      .rejects.toThrow();
    expect(await entryExists(cwd, "bad-content")).toBe(false);
  });

  test("publish accepts an explicit file path argument instead of the staging default", async () => {
    await asUser("alice", () => checkout("custom-path", alice()));

    const customFile = join(stagingDir, "custom-name.json");
    await writeFile(customFile, JSON.stringify({ id: "custom-path", path: "./custom-path" }));

    await asUser("alice", () => publish("custom-path", customFile, alice({ now: 1200 })));
    expect(await entryExists(cwd, "custom-path")).toBe(true);
  });

  // ── delete ────────────────────────────────────────────────────────────────

  test("delete removes a published entry", async () => {
    await publishEntry(cwd, "doomed", { id: "doomed", path: "./doomed" });
    await asUser("alice", () => deleteEntry("doomed", alice()));
    expect(await entryExists(cwd, "doomed")).toBe(false);
  });

  test("delete releases its auto-acquired lock", async () => {
    await publishEntry(cwd, "doomed", { id: "doomed", path: "./doomed" });
    await asUser("alice", () => deleteEntry("doomed", alice()));
    expect(await readLock(cwd, "doomed")).toBeNull();
  });

  test("delete throws when the id has no published entry", async () => {
    await expect(asUser("alice", () => deleteEntry("never-existed", alice())))
      .rejects.toThrow(/no published entry/i);
  });

  test("delete is rejected if someone else currently holds a live lock", async () => {
    await publishEntry(cwd, "contested-del", { id: "contested-del", path: "./x" });
    await asUser("alice", () => checkout("contested-del", alice()));

    await expect(asUser("bob", () => deleteEntry("contested-del", bob({ now: 1200 }))))
      .rejects.toThrow(/checked out by "alice"/);
  });

  test("delete with --purge removes the integration directory", async () => {
    const intDir = join(cwd, "doomed-int");
    await mkdir(intDir, { recursive: true });
    await writeFile(join(intDir, "integra.json"), "{}");
    await publishEntry(cwd, "doomed", { id: "doomed", path: "./doomed-int" });

    await asUser("alice", () => deleteEntry("doomed", alice({ purge: true })));

    await expect(stat(intDir)).rejects.toThrow();
  });

  test("delete without --purge leaves the integration directory intact", async () => {
    const intDir = join(cwd, "kept-int");
    await mkdir(intDir, { recursive: true });
    await publishEntry(cwd, "kept", { id: "kept", path: "./kept-int" });

    await asUser("alice", () => deleteEntry("kept", alice()));

    await expect(stat(intDir)).resolves.toBeDefined();
  });

  // ── duplicate ─────────────────────────────────────────────────────────────

  test("duplicate seeds the new id's staging file from the source, with id rewritten", async () => {
    const srcDir = join(cwd, "source-int");
    await mkdir(srcDir, { recursive: true });
    await writeFile(join(srcDir, "integra.json"), "{}");
    await publishEntry(cwd, "source", { id: "source", path: "./source-int", description: "original" });

    const result = await asUser("alice", () => duplicate("source", "clone", alice()));

    const staged = JSON.parse(await readFile(result.stagingPath, "utf-8"));
    expect(staged.id).toBe("clone");
    expect(staged.description).toBe("original");
  });

  test("duplicate copies the integration folder excluding .env, storage, logs", async () => {
    const srcDir = join(cwd, "source-int");
    await mkdir(join(srcDir, "storage"), { recursive: true });
    await mkdir(join(srcDir, "logs"), { recursive: true });
    await writeFile(join(srcDir, "integra.json"), "{}");
    await writeFile(join(srcDir, ".env"), "SECRET=shouldnotcopy");
    await writeFile(join(srcDir, "storage", "store.json"), "{}");
    await writeFile(join(srcDir, "logs", "out.log"), "log line");

    await publishEntry(cwd, "source", { id: "source", path: "./source-int" });

    const result = await asUser("alice", () => duplicate("source", "clone", alice()));

    await expect(stat(join(result.integrationDir, "integra.json"))).resolves.toBeDefined();
    await expect(stat(join(result.integrationDir, ".env"))).rejects.toThrow();
    await expect(stat(join(result.integrationDir, "storage"))).rejects.toThrow();
    await expect(stat(join(result.integrationDir, "logs"))).rejects.toThrow();
  });

  test("duplicate throws if the new id already exists", async () => {
    await publishEntry(cwd, "source", { id: "source", path: "./source-int" });
    await publishEntry(cwd, "taken",  { id: "taken",  path: "./taken-int" });

    await expect(asUser("alice", () => duplicate("source", "taken", alice())))
      .rejects.toThrow(/already exists/i);
  });

  test("duplicate throws if the source id doesn't exist", async () => {
    await expect(asUser("alice", () => duplicate("nonexistent", "clone", alice())))
      .rejects.toThrow(/no published entry/i);
  });

  test("duplicate throws if source and target id are identical", async () => {
    await publishEntry(cwd, "same", { id: "same", path: "./same-int" });
    await expect(asUser("alice", () => duplicate("same", "same", alice())))
      .rejects.toThrow(/must differ/i);
  });

  // ── Full multi-user scenario, end to end ───────────────────────────────────

  test("end-to-end: alice registers a new integration while bob is blocked from the same id", async () => {
    const co = await asUser("alice", () => checkout("shared-target", alice()));

    await expect(asUser("bob", () => checkout("shared-target", bob({ now: 1100 }))))
      .rejects.toThrow();

    const staged = JSON.parse(await readFile(co.stagingPath, "utf-8"));
    staged.description = "Alice's integration";
    await writeFile(co.stagingPath, JSON.stringify(staged));
    await asUser("alice", () => publish("shared-target", undefined, alice({ now: 1200 })));

    // Now that alice's lock is released, bob can check out the SAME id to modify it
    const bobCo = await asUser("bob", () => checkout("shared-target", bob({ now: 1300 })));
    expect(bobCo.isNew).toBe(false);
    const bobStaged = JSON.parse(await readFile(bobCo.stagingPath, "utf-8"));
    expect(bobStaged.description).toBe("Alice's integration");
  });
});
