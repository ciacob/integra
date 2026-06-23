// Copyright (c) 2026 Claudius Tiberiu Iacob — Licensed under BSL 1.1. See LICENSE for details.
import { mkdtemp, rm, mkdir, writeFile, readFile, stat } from "fs/promises";
import { tmpdir } from "os";
import { join, resolve } from "path";

import { checkout }    from "../src/commands/checkout.js";
import { publish }     from "../src/commands/publish.js";
import { uncheckout }  from "../src/commands/uncheckout.js";
import { deleteEntry } from "../src/commands/delete.js";
import { readEntry, entryExists, publishEntry } from "../src/registryStorage.js";
import { readLock } from "../src/lock.js";

describe("registry.d workflow — checkout / publish / delete / uncheckout", () => {
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

  // ── checkout — requires existing entry ────────────────────────────────────

  test("checkout errors clearly on a non-existing id, directing user to init", async () => {
    await expect(asUser("alice", () => checkout("never-existed", alice())))
      .rejects.toThrow(/integra init never-existed/);
  });

  test("checkout on an existing id seeds a staging file from live content", async () => {
    await publishEntry(cwd, "existing", { id: "existing", path: "./existing", description: "original" });

    const result = await asUser("alice", () => checkout("existing", alice()));

    const staged = JSON.parse(await readFile(result.stagingPath, "utf-8"));
    expect(staged.description).toBe("original");
    expect(staged.id).toBe("existing");
  });

  // ── Happy path: checkout → edit → publish ─────────────────────────────────

  test("full lifecycle: checkout existing, edit, publish", async () => {
    await publishEntry(cwd, "my-int", { id: "my-int", path: "./my-int", description: "before" });

    const co = await asUser("alice", () => checkout("my-int", alice()));

    const staged = JSON.parse(await readFile(co.stagingPath, "utf-8"));
    staged.description = "after";
    await writeFile(co.stagingPath, JSON.stringify(staged, null, 2));

    await asUser("alice", () => publish("my-int", undefined, alice({ now: 1500 })));

    const live = await readEntry(cwd, "my-int");
    expect(live.description).toBe("after");
  });

  test("publish releases the lock on success", async () => {
    await publishEntry(cwd, "my-int", { id: "my-int", path: "./my-int" });
    await asUser("alice", () => checkout("my-int", alice()));
    await asUser("alice", () => publish("my-int", undefined, alice({ now: 1500 })));
    expect(await readLock(cwd, "my-int")).toBeNull();
  });

  // ── Lock contention between two users ──────────────────────────────────────

  test("bob cannot checkout an id alice has already checked out", async () => {
    await publishEntry(cwd, "contested", { id: "contested", path: "./contested" });
    await asUser("alice", () => checkout("contested", alice()));

    await expect(asUser("bob", () => checkout("contested", bob({ now: 1200 }))))
      .rejects.toThrow(/already checked out by "alice"/);
  });

  test("bob cannot publish against alice's lock", async () => {
    await publishEntry(cwd, "contested", { id: "contested", path: "./contested" });
    await asUser("alice", () => checkout("contested", alice()));

    await expect(asUser("bob", () => publish("contested", undefined, bob({ now: 1200 }))))
      .rejects.toThrow(/checked out by "alice"/);
  });

  test("bob can checkout once alice's lock has expired", async () => {
    await publishEntry(cwd, "contested", { id: "contested", path: "./contested" });
    await asUser("alice", () => checkout("contested", alice({ ttlMs: 500 }))); // expires at 1500

    const result = await asUser("bob", () => checkout("contested", bob({ now: 5000 })));
    expect(result.holder).toBe("bob");
  });

  // ── INTEGRA_LOCK_TTL_SECONDS env override ─────────────────────────────────

  test("INTEGRA_LOCK_TTL_SECONDS is respected as the lock TTL", async () => {
    const prior = process.env.INTEGRA_LOCK_TTL_SECONDS;
    process.env.INTEGRA_LOCK_TTL_SECONDS = "1"; // 1 second = 1000ms

    await publishEntry(cwd, "my-int", { id: "my-int", path: "./my-int" });
    const now = Date.now();
    await asUser("alice", () => checkout("my-int", { cwd, stagingDir, now }));
    const lock = await readLock(cwd, "my-int");
    expect(lock.expiresAt).toBe(now + 1000); // TTL honoured

    if (prior === undefined) delete process.env.INTEGRA_LOCK_TTL_SECONDS;
    else process.env.INTEGRA_LOCK_TTL_SECONDS = prior;
    await asUser("alice", () => uncheckout("my-int", { cwd, now: now + 500 }));
  });

  // ── uncheckout ────────────────────────────────────────────────────────────

  test("uncheckout releases the lock without publishing", async () => {
    await publishEntry(cwd, "temp-edit", { id: "temp-edit", path: "./temp-edit", description: "original" });
    await asUser("alice", () => checkout("temp-edit", alice()));
    await asUser("alice", () => uncheckout("temp-edit", alice({ now: 1200 })));

    expect(await readLock(cwd, "temp-edit")).toBeNull();
    // entry still exists unchanged
    const live = await readEntry(cwd, "temp-edit");
    expect(live.description).toBe("original");
  });

  test("bob cannot uncheckout alice's lock", async () => {
    await publishEntry(cwd, "temp-edit", { id: "temp-edit", path: "./temp-edit" });
    await asUser("alice", () => checkout("temp-edit", alice()));
    await expect(asUser("bob", () => uncheckout("temp-edit", bob({ now: 1200 }))))
      .rejects.toThrow(/checked out by "alice"/);
  });

  test("uncheckout on a non-existent lock throws", async () => {
    await expect(asUser("alice", () => uncheckout("never-checked-out", alice())))
      .rejects.toThrow(/no active checkout/i);
  });

  // ── publish validation ────────────────────────────────────────────────────

  test("publish rejects when staged content id doesn't match the publish target", async () => {
    await publishEntry(cwd, "right-id", { id: "right-id", path: "./right-id" });
    const co = await asUser("alice", () => checkout("right-id", alice()));

    const staged = JSON.parse(await readFile(co.stagingPath, "utf-8"));
    staged.id = "wrong-id";
    await writeFile(co.stagingPath, JSON.stringify(staged));

    await expect(asUser("alice", () => publish("right-id", undefined, alice({ now: 1200 }))))
      .rejects.toThrow(/declares id "wrong-id"/);
  });

  test("publish rejects invalid schema content and leaves registry.d/ untouched", async () => {
    await publishEntry(cwd, "bad-content", { id: "bad-content", path: "./bad-content" });
    const co = await asUser("alice", () => checkout("bad-content", alice()));

    await writeFile(co.stagingPath, JSON.stringify({ id: "bad-content" /* missing path */ }));

    await expect(asUser("alice", () => publish("bad-content", undefined, alice({ now: 1200 }))))
      .rejects.toThrow();
    // Entry still has the original valid content
    expect(await entryExists(cwd, "bad-content")).toBe(true);
  });

  test("publish accepts an explicit file path argument instead of the staging default", async () => {
    await publishEntry(cwd, "custom-path", { id: "custom-path", path: "./custom-path" });
    await asUser("alice", () => checkout("custom-path", alice()));

    const customFile = join(stagingDir, "custom-name.json");
    await writeFile(customFile, JSON.stringify({ id: "custom-path", path: "./custom-path", description: "via custom file" }));

    await asUser("alice", () => publish("custom-path", customFile, alice({ now: 1200 })));
    const live = await readEntry(cwd, "custom-path");
    expect(live.description).toBe("via custom file");
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

  // ── Full multi-user scenario, end to end ───────────────────────────────────

  test("end-to-end: alice edits an integration while bob is blocked, then bob updates after release", async () => {
    // Both start from an existing published entry (as init would have created)
    await publishEntry(cwd, "shared-target", { id: "shared-target", path: "./shared-target", description: "v1" });

    const co = await asUser("alice", () => checkout("shared-target", alice()));

    // Bob is blocked during alice's edit
    await expect(asUser("bob", () => checkout("shared-target", bob({ now: 1100 }))))
      .rejects.toThrow();

    // Alice finishes
    const staged = JSON.parse(await readFile(co.stagingPath, "utf-8"));
    staged.description = "v2 by alice";
    await writeFile(co.stagingPath, JSON.stringify(staged));
    await asUser("alice", () => publish("shared-target", undefined, alice({ now: 1200 })));

    // Bob can now check out and sees alice's changes
    const bobCo = await asUser("bob", () => checkout("shared-target", bob({ now: 1300 })));
    const bobStaged = JSON.parse(await readFile(bobCo.stagingPath, "utf-8"));
    expect(bobStaged.description).toBe("v2 by alice");

    // Clean up bob's checkout
    await asUser("bob", () => uncheckout("shared-target", bob({ now: 1400 })));
  });
});
