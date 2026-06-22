// Copyright (c) 2026 Claudius Tiberiu Iacob — Licensed under BSL 1.1. See LICENSE for details.
/**
 * packages/manager/test/deployHistory.test.js
 *
 * live/ IS the repository — no separate bare remote. pushBranch clones
 * directly from liveDir's CURRENT state, so a branch pushed after a prior
 * deploy has landed naturally contains that deploy's history.
 */
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir }   from "os";
import { join }     from "path";
import { execSync } from "child_process";
import pm2           from "pm2";

import { deploy }        from "../src/commands/deploy.js";
import { deployHistory } from "../src/commands/deployHistory.js";
import { publishEntry }  from "../src/registryStorage.js";

function pm2Connect()    { return new Promise((res, rej) => pm2.connect(err => err ? rej(err) : res())); }
function pm2Disconnect() { pm2.disconnect(); }
function pm2Delete(name) { return new Promise(res => pm2.delete(name, () => res())); }
function pm2Start(descriptor) {
  return new Promise((res, rej) => pm2.start(descriptor, err => err ? rej(err) : res()));
}

describe("deployHistory", () => {
  let cwd, liveDir;
  const PROCESS_NAME = "history-test-int";

  function sh(cmd, dir) {
    return execSync(cmd, { cwd: dir, encoding: "utf-8" }).trim();
  }

  beforeEach(async () => {
    cwd     = await mkdtemp(join(tmpdir(), "integra-history-test-"));
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
    pm2Disconnect();
    await rm(cwd, { recursive: true, force: true });
  });

  // Clones directly from liveDir's CURRENT state. After a deploy lands,
  // the next call naturally includes that deploy's history.
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

  test("throws when id is missing", async () => {
    await expect(deployHistory(undefined, { cwd })).rejects.toThrow(/usage/i);
  });

  test("throws when the id is not registered", async () => {
    await expect(deployHistory("nonexistent", { cwd })).rejects.toThrow(/not registered/i);
  });

  test("returns an empty array when there are no deploys yet", async () => {
    const entries = await deployHistory(PROCESS_NAME, { cwd });
    expect(entries).toEqual([]);
  });

  // ── Listing and ordering ─────────────────────────────────────────────────────

  test("lists a single deploy with its metadata", async () => {
    await pushBranch("feature-a", "v2\n");
    await deploy(PROCESS_NAME, "feature-a", { cwd });

    const entries = await deployHistory(PROCESS_NAME, { cwd });
    expect(entries).toHaveLength(1);
    expect(entries[0].tag).toBe("deploy-1");
    expect(entries[0].branch).toBe("feature-a");
    expect(entries[0].by).toBeTruthy();
    expect(entries[0].at).toBeTruthy();
  }, 15000);

  test("lists multiple deploys newest first, by numeric tag suffix not creatordate", async () => {
    // Same-second tag creation is realistic in fast operation, not just
    // fast tests — confirmed directly that creatordate ordering is
    // unreliable at second resolution, so this orders by the tag's
    // numeric suffix instead.
    await pushBranch("feature-b1", "v2\n");
    await deploy(PROCESS_NAME, "feature-b1", { cwd });

    await pushBranch("feature-b2", "v3\n");
    await deploy(PROCESS_NAME, "feature-b2", { cwd });

    await pushBranch("feature-b3", "v4\n");
    await deploy(PROCESS_NAME, "feature-b3", { cwd });

    const entries = await deployHistory(PROCESS_NAME, { cwd });
    expect(entries.map(e => e.tag)).toEqual(["deploy-3", "deploy-2", "deploy-1"]);
    expect(entries.map(e => e.branch)).toEqual(["feature-b3", "feature-b2", "feature-b1"]);
  }, 25000);

  // ── Count limiting ───────────────────────────────────────────────────────────

  test("respects the n option, returning only the most recent n entries", async () => {
    await pushBranch("feature-c1", "v2\n");
    await deploy(PROCESS_NAME, "feature-c1", { cwd });
    await pushBranch("feature-c2", "v3\n");
    await deploy(PROCESS_NAME, "feature-c2", { cwd });
    await pushBranch("feature-c3", "v4\n");
    await deploy(PROCESS_NAME, "feature-c3", { cwd });

    const entries = await deployHistory(PROCESS_NAME, { cwd, n: 2 });
    expect(entries).toHaveLength(2);
    expect(entries.map(e => e.tag)).toEqual(["deploy-3", "deploy-2"]);
  }, 25000);

  test("defaults to 10 entries when n is not specified", async () => {
    await pushBranch("feature-d1", "v2\n");
    await deploy(PROCESS_NAME, "feature-d1", { cwd });

    const entries = await deployHistory(PROCESS_NAME, { cwd });
    expect(entries.length).toBeLessThanOrEqual(10);
  }, 15000);

  // ── sha field ────────────────────────────────────────────────────────────────

  test("sha field is the commit's short SHA, not the tag object's own SHA", async () => {
    await pushBranch("feature-e", "v2\n");
    const deployResult = await deploy(PROCESS_NAME, "feature-e", { cwd });

    const entries = await deployHistory(PROCESS_NAME, { cwd });
    expect(entries[0].sha).toBe(deployResult.headAfter.slice(0, 7));
  }, 15000);
});
