// Copyright (c) 2026 Claudius Tiberiu Iacob — Licensed under BSL 1.1. See LICENSE for details.
import { mkdtemp, rm } from "fs/promises";
import { tmpdir }      from "os";
import { join }        from "path";

import {
  isExpired, buildLockRecord, canActOnLock,
  acquireLock, readLock, removeLock, assertCanActOnLock,
  archiveStaleStagingFile, DEFAULT_LOCK_TTL_MS,
} from "../src/lock.js";

// ── Pure functions — no disk involved ─────────────────────────────────────────

describe("isExpired", () => {
  test("null record is treated as expired", () => {
    expect(isExpired(null)).toBe(true);
  });

  test("record with no expiresAt is treated as expired", () => {
    expect(isExpired({ holder: "alice" })).toBe(true);
  });

  test("record with future expiresAt is not expired", () => {
    expect(isExpired({ expiresAt: Date.now() + 60000 }, Date.now())).toBe(false);
  });

  test("record with past expiresAt is expired", () => {
    expect(isExpired({ expiresAt: Date.now() - 1000 }, Date.now())).toBe(true);
  });

  test("record expiring exactly now is expired (inclusive boundary)", () => {
    const now = 1000000;
    expect(isExpired({ expiresAt: now }, now)).toBe(true);
  });
});

describe("buildLockRecord", () => {
  test("builds a record with the given id and holder", () => {
    const rec = buildLockRecord("my-id", "alice", 1000, 5000);
    expect(rec.id).toBe("my-id");
    expect(rec.holder).toBe("alice");
  });

  test("computes expiresAt as now + ttl", () => {
    const rec = buildLockRecord("x", "alice", 1000, 5000);
    expect(rec.acquiredAt).toBe(1000);
    expect(rec.expiresAt).toBe(6000);
  });

  test("uses DEFAULT_LOCK_TTL_MS when ttl omitted", () => {
    const now = 1000;
    const rec = buildLockRecord("x", "alice", now);
    expect(rec.expiresAt).toBe(now + DEFAULT_LOCK_TTL_MS);
  });
});

describe("canActOnLock", () => {
  const now = 1_000_000;

  test("no lock at all → not ok, reason no_lock", () => {
    const result = canActOnLock(null, "alice", now);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("no_lock");
  });

  test("expired lock → not ok, reason lock_expired (even for original holder)", () => {
    const rec = { holder: "alice", expiresAt: now - 1 };
    const result = canActOnLock(rec, "alice", now);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("lock_expired");
  });

  test("live lock, same holder → ok", () => {
    const rec = { holder: "alice", expiresAt: now + 1000 };
    const result = canActOnLock(rec, "alice", now);
    expect(result.ok).toBe(true);
  });

  test("live lock, different actor → not ok, reason held_by_other, names holder", () => {
    const rec = { holder: "alice", expiresAt: now + 1000 };
    const result = canActOnLock(rec, "bob", now);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("held_by_other");
    expect(result.holder).toBe("alice");
  });
});

// ── I/O wrappers — real temp directories ──────────────────────────────────────

describe("lock.js I/O wrappers", () => {
  let dir;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "integra-lock-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("readLock returns null when no lock file exists", async () => {
    expect(await readLock(dir, "nonexistent")).toBeNull();
  });

  test("readLock returns null for malformed lock file content", async () => {
    const { mkdir, writeFile } = await import("fs/promises");
    await mkdir(join(dir, "registry.d-locks"), { recursive: true });
    await writeFile(join(dir, "registry.d-locks", "broken.lock.json"), "{not json");
    expect(await readLock(dir, "broken")).toBeNull();
  });

  test("acquireLock succeeds when no prior lock exists", async () => {
    const result = await acquireLock(dir, "my-id", "alice", 60000, 1000);
    expect(result.ok).toBe(true);
    expect(result.record.holder).toBe("alice");
  });

  test("acquireLock writes a lock file readable by readLock", async () => {
    await acquireLock(dir, "my-id", "alice", 60000, 1000);
    const rec = await readLock(dir, "my-id");
    expect(rec.holder).toBe("alice");
    expect(rec.id).toBe("my-id");
  });

  test("acquireLock fails when another holder has a live lock", async () => {
    await acquireLock(dir, "my-id", "alice", 60000, 1000);
    const result = await acquireLock(dir, "my-id", "bob", 60000, 1500);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("held_by_other");
    expect(result.holder).toBe("alice");
  });

  test("acquireLock succeeds for the same holder re-acquiring (refresh)", async () => {
    await acquireLock(dir, "my-id", "alice", 60000, 1000);
    const result = await acquireLock(dir, "my-id", "alice", 60000, 2000);
    expect(result.ok).toBe(true);
  });

  test("acquireLock succeeds for a new holder once the prior lock has expired", async () => {
    await acquireLock(dir, "my-id", "alice", 1000, 1000); // expires at 2000
    const result = await acquireLock(dir, "my-id", "bob", 60000, 5000); // well past expiry
    expect(result.ok).toBe(true);
    expect(result.record.holder).toBe("bob");
  });

  test("removeLock is a no-op when no lock file exists", async () => {
    await expect(removeLock(dir, "nonexistent")).resolves.toBeUndefined();
  });

  test("removeLock deletes an existing lock file", async () => {
    await acquireLock(dir, "my-id", "alice", 60000, 1000);
    await removeLock(dir, "my-id");
    expect(await readLock(dir, "my-id")).toBeNull();
  });

  test("assertCanActOnLock throws a descriptive error when no lock exists", async () => {
    await expect(assertCanActOnLock(dir, "my-id", "alice", 1000))
      .rejects.toThrow(/no active checkout/i);
  });

  test("assertCanActOnLock throws naming the other holder", async () => {
    await acquireLock(dir, "my-id", "alice", 60000, 1000);
    await expect(assertCanActOnLock(dir, "my-id", "bob", 1500))
      .rejects.toThrow(/alice/i);
  });

  test("assertCanActOnLock resolves (returns the record) for the rightful holder", async () => {
    await acquireLock(dir, "my-id", "alice", 60000, 1000);
    const rec = await assertCanActOnLock(dir, "my-id", "alice", 1500);
    expect(rec.holder).toBe("alice");
  });

  test("assertCanActOnLock throws when the lock has expired, even for original holder", async () => {
    await acquireLock(dir, "my-id", "alice", 1000, 1000); // expires 2000
    await expect(assertCanActOnLock(dir, "my-id", "alice", 5000))
      .rejects.toThrow(/expired/i);
  });
});

describe("archiveStaleStagingFile", () => {
  let dir;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "integra-archive-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("renames the file with an .old_<epoch> suffix", async () => {
    const { writeFile, readFile } = await import("fs/promises");
    const original = join(dir, "my-id.registry.json");
    await writeFile(original, '{"id":"my-id"}');

    const archived = await archiveStaleStagingFile(original, 1_700_000_000_000);

    expect(archived).toBe(`${original}.old_1700000000`);
    const content = await readFile(archived, "utf-8");
    expect(content).toBe('{"id":"my-id"}');
  });

  test("original path no longer exists after archiving", async () => {
    const { writeFile, stat } = await import("fs/promises");
    const original = join(dir, "x.registry.json");
    await writeFile(original, "{}");
    await archiveStaleStagingFile(original, 1000000);
    await expect(stat(original)).rejects.toThrow();
  });
});
