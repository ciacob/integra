// Copyright (c) 2026 Claudius Tiberiu Iacob — Licensed under BSL 1.1. See LICENSE for details.
/**
 * packages/manager/test/deploy.test.js
 *
 * live/ IS the repository — no separate bare remote. Developer clones are
 * created directly from live/, and they push branches back into live/
 * itself. pushBranch always clones fresh from the CURRENT state of
 * liveDir, so after one deploy lands, a subsequent pushBranch call
 * naturally includes that history — no special "branch from a specific
 * point" helper is needed, unlike the old fetch-based model.
 *
 * deploy() calls the real restartOne(), which calls real PM2. Every test
 * that exercises a successful deploy therefore needs a real, harmless PM2
 * process already running under the integration's id before deploy() can
 * restart it — PM2 refuses to "restart" something it never started.
 * Explicit start in beforeEach, explicit delete in afterEach, regardless
 * of pass/fail — same discipline as sweepLauncher.test.js.
 */

import { mkdtemp, rm, writeFile, mkdir } from "fs/promises";
import { tmpdir }   from "os";
import { join }     from "path";
import { execSync } from "child_process";
import pm2           from "pm2";

import { deploy }       from "../src/commands/deploy.js";
import { publishEntry } from "../src/registryStorage.js";

function pm2Connect()    { return new Promise((res, rej) => pm2.connect(err => err ? rej(err) : res())); }
function pm2Disconnect() { pm2.disconnect(); }
function pm2Delete(name) { return new Promise(res => pm2.delete(name, () => res())); }
function pm2Start(descriptor) {
  return new Promise((res, rej) => pm2.start(descriptor, err => err ? rej(err) : res()));
}
function pm2Describe(name) {
  return new Promise((res, rej) => pm2.describe(name, (err, list) => err ? rej(err) : res(list)));
}

describe("deploy", () => {
  let cwd, liveDir;
  const PROCESS_NAME = "deploy-test-int";

  function sh(cmd, dir) {
    return execSync(cmd, { cwd: dir, encoding: "utf-8" }).trim();
  }

  beforeEach(async () => {
    cwd     = await mkdtemp(join(tmpdir(), "integra-deploy-test-"));
    liveDir = join(cwd, ".integrations", PROCESS_NAME, "live");

    sh(`mkdir -p ${liveDir}`, cwd);
    sh("git init -q", liveDir);
    sh("git config user.email test@test.com", liveDir);
    sh("git config user.name test", liveDir);
    await writeFile(join(liveDir, "file.txt"), "v1\n");
    sh("git add -A", liveDir);
    sh('git commit -q -m "v1"', liveDir);
    sh("git branch -M master", liveDir);

    await publishEntry(cwd, PROCESS_NAME, { id: PROCESS_NAME, path: `./.integrations/${PROCESS_NAME}/live` });

    // Start a real, harmless PM2 process under this id — a long-lived sleep,
    // not the actual engine — purely so restartOne() has something real to
    // restart. node -e is used to avoid depending on `sleep` existing.
    await pm2Connect();
    await pm2Start({
      name:   PROCESS_NAME,
      script: "node",
      args:   ["-e", "setInterval(() => {}, 1000)"],
      cwd,
      autorestart: false,
    });
    pm2Disconnect();
  });

  afterEach(async () => {
    await pm2Connect();
    await pm2Delete(PROCESS_NAME);
    await pm2Delete(`${PROCESS_NAME}--tc`); // harmless if it never existed
    pm2Disconnect();
    await rm(cwd, { recursive: true, force: true });
  });

  // Clones directly from liveDir's CURRENT state (simulating a developer's
  // own clone), commits on a new branch, pushes it back into liveDir. Since
  // it always clones fresh from liveDir, a branch pushed after a prior
  // deploy has landed naturally includes that deploy's history — no
  // special "branch from a specific point" helper needed.
  async function pushBranch(branchName, fileContent) {
    const devClone = join(cwd, `dev-clone-${branchName}`);
    sh(`git clone -q ${liveDir} ${devClone}`, cwd);
    sh("git config user.email test@test.com", devClone);
    sh("git config user.name test", devClone);
    sh(`git checkout -q -b ${branchName}`, devClone);
    await writeFile(join(devClone, "file.txt"), fileContent);
    sh("git add -A", devClone);
    sh(`git commit -q -m "on ${branchName}"`, devClone);
    sh(`git push -q origin ${branchName}`, devClone);
  }

  // ── Basic usage ────────────────────────────────────────────────────────────

  test("throws when id or branch is missing", async () => {
    await expect(deploy(undefined, "x", { cwd })).rejects.toThrow(/usage/i);
    await expect(deploy(PROCESS_NAME, undefined, { cwd })).rejects.toThrow(/usage/i);
  });

  test("throws when the id is not registered", async () => {
    await expect(deploy("nonexistent", "x", { cwd })).rejects.toThrow(/not registered/i);
  });

  // ── Successful fast-forward ─────────────────────────────────────────────────

  test("fast-forwards live/ to the named branch", async () => {
    await pushBranch("feature-a", "v2\n");

    await deploy(PROCESS_NAME, "feature-a", { cwd });

    const { readFile } = await import("fs/promises");
    const content = await readFile(join(liveDir, "file.txt"), "utf-8");
    expect(content).toBe("v2\n");
  }, 15000);

  test("creates a deploy-1 tag on the first deploy", async () => {
    await pushBranch("feature-b", "v2\n");
    const result = await deploy(PROCESS_NAME, "feature-b", { cwd });

    expect(result.tag).toBe("deploy-1");
    const tags = sh("git tag -l deploy-*", liveDir);
    expect(tags).toContain("deploy-1");
  }, 15000);

  test("second deploy creates deploy-2, not a duplicate deploy-1", async () => {
    await pushBranch("feature-c1", "v2\n");
    const first = await deploy(PROCESS_NAME, "feature-c1", { cwd });
    expect(first.tag).toBe("deploy-1");

    // feature-c2 is pushed after feature-c1 has already landed on liveDir —
    // pushBranch clones liveDir's CURRENT state, so this naturally contains
    // feature-c1's commit. No special handling needed.
    await pushBranch("feature-c2", "v3\n");
    const second = await deploy(PROCESS_NAME, "feature-c2", { cwd });
    expect(second.tag).toBe("deploy-2");

    const tags = sh("git tag -l deploy-*", liveDir).split("\n").filter(Boolean);
    expect(tags.sort()).toEqual(["deploy-1", "deploy-2"]);
  }, 20000);

  test("tag message records branch, deployer, and timestamp", async () => {
    await pushBranch("feature-d", "v2\n");
    const result = await deploy(PROCESS_NAME, "feature-d", { cwd });

    const message = sh(`git for-each-ref --format="%(contents:subject)" refs/tags/${result.tag}`, liveDir);
    expect(message).toContain("branch=feature-d");
    expect(message).toMatch(/by=\S+/);
    expect(message).toMatch(/at=\S+/);
  }, 15000);

  test("restarts the PM2 process on success", async () => {
    await pushBranch("feature-e", "v2\n");

    await pm2Connect();
    const before = await pm2Describe(PROCESS_NAME);
    const restartsBefore = before[0].pm2_env.restart_time;
    pm2Disconnect();

    await deploy(PROCESS_NAME, "feature-e", { cwd });

    await pm2Connect();
    const after = await pm2Describe(PROCESS_NAME);
    const restartsAfter = after[0].pm2_env.restart_time;
    pm2Disconnect();

    expect(restartsAfter).toBeGreaterThan(restartsBefore);
  }, 15000);

  // ── Refusal on divergence — live/ must be provably untouched ────────────────
  // Divergence must be created AFTER the branch is pushed, not before —
  // pushBranch clones liveDir's current state, so a commit made on liveDir
  // BEFORE pushing would simply be included in the new branch's history,
  // and the merge would correctly (and unhelpfully, for this test) succeed.
  // Genuine divergence here means: the branch was pushed from one state of
  // liveDir, then liveDir moved on its own afterward, before deploy runs.

  test("refuses and leaves live/ untouched when it has diverged from the branch", async () => {
    await pushBranch("feature-f", "v2\n");

    // NOW make a local commit on live/ that's never pushed anywhere —
    // after the branch was already created from an earlier state.
    await writeFile(join(liveDir, "other.txt"), "diverged\n");
    sh("git add -A", liveDir);
    sh('git commit -q -m "diverged, local only"', liveDir);
    const headBeforeAttempt = sh("git rev-parse HEAD", liveDir);

    await expect(deploy(PROCESS_NAME, "feature-f", { cwd })).rejects.toThrow(/refused/i);

    const headAfterAttempt = sh("git rev-parse HEAD", liveDir);
    expect(headAfterAttempt).toBe(headBeforeAttempt); // provably untouched
  }, 15000);

  test("refusal message explicitly states live/ was not modified", async () => {
    await pushBranch("feature-g", "v2\n");

    await writeFile(join(liveDir, "other.txt"), "diverged\n");
    sh("git add -A", liveDir);
    sh('git commit -q -m "diverged"', liveDir);

    await expect(deploy(PROCESS_NAME, "feature-g", { cwd }))
      .rejects.toThrow(/not.*modified|not.*touched/i);
  }, 15000);

  test("does NOT restart the process when the deploy is refused", async () => {
    await pushBranch("feature-h", "v2\n");

    await writeFile(join(liveDir, "other.txt"), "diverged\n");
    sh("git add -A", liveDir);
    sh('git commit -q -m "diverged"', liveDir);

    await pm2Connect();
    const before = await pm2Describe(PROCESS_NAME);
    const restartsBefore = before[0].pm2_env.restart_time;
    pm2Disconnect();

    await expect(deploy(PROCESS_NAME, "feature-h", { cwd })).rejects.toThrow();

    await pm2Connect();
    const after = await pm2Describe(PROCESS_NAME);
    const restartsAfter = after[0].pm2_env.restart_time;
    pm2Disconnect();

    expect(restartsAfter).toBe(restartsBefore);
  }, 15000);

  // ── Branch not found ─────────────────────────────────────────────────────────

  test("throws a clear error when the named branch was never pushed into live/", async () => {
    await expect(deploy(PROCESS_NAME, "never-pushed", { cwd }))
      .rejects.toThrow(/refused|not.*fast-forward/i);
  }, 15000);
});
