// Copyright (c) 2026 Claudius Tiberiu Iacob — Licensed under BSL 1.1. See LICENSE for details.
/**
 * packages/manager/test/undeploy.test.js
 *
 * live/ IS the repository — no separate bare remote. pushBranch clones
 * directly from liveDir's CURRENT state, so a branch pushed after a prior
 * deploy has landed naturally contains that deploy's history. There is no
 * need for a "branch from a specific point" helper, unlike the old
 * fetch-based model — a single pushBranch call covers every case here.
 */
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir }   from "os";
import { join }     from "path";
import { execSync } from "child_process";
import pm2           from "pm2";

import { deploy }       from "../src/commands/deploy.js";
import { undeploy }     from "../src/commands/undeploy.js";
import { publishEntry } from "../src/registryStorage.js";

function pm2Connect()    { return new Promise((res, rej) => pm2.connect(err => err ? rej(err) : res())); }
function pm2Disconnect() { pm2.disconnect(); }
function pm2Delete(name) { return new Promise(res => pm2.delete(name, () => res())); }
function pm2Start(descriptor) {
  return new Promise((res, rej) => pm2.start(descriptor, err => err ? rej(err) : res()));
}

describe("undeploy", () => {
  let cwd, liveDir;
  const PROCESS_NAME = "undeploy-test-int";

  function sh(cmd, dir) {
    return execSync(cmd, { cwd: dir, encoding: "utf-8" }).trim();
  }

  beforeEach(async () => {
    cwd     = await mkdtemp(join(tmpdir(), "integra-undeploy-test-"));
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
  // the next call to this naturally includes that deploy's history.
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
    await expect(undeploy(undefined, { cwd })).rejects.toThrow(/usage/i);
  });

  test("throws when the id is not registered", async () => {
    await expect(undeploy("nonexistent", { cwd })).rejects.toThrow(/not registered/i);
  });

  test("throws when there are no recorded deploys at all", async () => {
    await expect(undeploy(PROCESS_NAME, { cwd })).rejects.toThrow(/no recorded deploys/i);
  });

  test("throws when there is only one recorded deploy", async () => {
    await pushBranch("feature-a", "v2\n");
    await deploy(PROCESS_NAME, "feature-a", { cwd });

    await expect(undeploy(PROCESS_NAME, { cwd })).rejects.toThrow(/only one recorded deploy/i);
  }, 15000);

  // ── Correct rollback target ──────────────────────────────────────────────────

  test("rolls back to the deploy before the current one", async () => {
    await pushBranch("feature-b1", "v2\n");
    await deploy(PROCESS_NAME, "feature-b1", { cwd });

    // Pushed AFTER feature-b1 landed, so it naturally contains that history.
    await pushBranch("feature-b2", "v3\n");
    await deploy(PROCESS_NAME, "feature-b2", { cwd });

    const { readFile } = await import("fs/promises");
    let content = await readFile(join(liveDir, "file.txt"), "utf-8");
    expect(content).toBe("v3\n"); // confirm we're at deploy-2 before rolling back

    const result = await undeploy(PROCESS_NAME, { cwd });
    expect(result.tag).toBe("deploy-1");

    content = await readFile(join(liveDir, "file.txt"), "utf-8");
    expect(content).toBe("v2\n"); // back to deploy-1's content
  }, 25000);

  test("a deploy spanning MULTIPLE commits proves HEAD~1 is never used as the mechanism — HEAD~1 would land mid-deploy-2, but undeploy correctly lands exactly on deploy-1", async () => {
    await pushBranch("feature-multi1", "v2\n");
    await deploy(PROCESS_NAME, "feature-multi1", { cwd });

    // feature-multi2 is TWO commits ahead of feature-multi1's tip — a
    // single deploy that fast-forwards through two commits at once.
    // HEAD~1 from the resulting state would land on the FIRST of those two
    // commits (still inside deploy-2's branch), not on deploy-1 at all —
    // proving any HEAD~N-based approach is structurally wrong here, not
    // just wrong by coincidence.
    const devClone = join(cwd, "dev-clone-feature-multi2");
    sh(`git clone -q ${liveDir} ${devClone}`, cwd);
    sh("git config user.email test@test.com", devClone);
    sh("git config user.name test", devClone);
    sh("git checkout -q -b feature-multi2", devClone);
    await writeFile(join(devClone, "file.txt"), "v3-step1\n");
    sh("git add -A", devClone);
    sh('git commit -q -m "step 1 of 2"', devClone);
    await writeFile(join(devClone, "file.txt"), "v3-step2\n");
    sh("git add -A", devClone);
    sh('git commit -q -m "step 2 of 2"', devClone);
    sh("git push -q origin feature-multi2", devClone);

    await deploy(PROCESS_NAME, "feature-multi2", { cwd });

    const result = await undeploy(PROCESS_NAME, { cwd });
    expect(result.tag).toBe("deploy-1");

    const { readFile } = await import("fs/promises");
    const content = await readFile(join(liveDir, "file.txt"), "utf-8");
    expect(content).toBe("v2\n"); // exactly deploy-1's content, not "step 1 of 2"
  }, 25000);

  test("when HEAD has an unsanctioned commit on top of a tag, undeploy discards it and returns to that last known deploy — not HEAD~1, and not skipping past it either", async () => {
    await pushBranch("feature-c1", "v2\n");
    await deploy(PROCESS_NAME, "feature-c1", { cwd });

    await pushBranch("feature-c2", "v3\n");
    await deploy(PROCESS_NAME, "feature-c2", { cwd });

    // Someone commits directly to live/ after the deploy — not through any
    // sanctioned path, but it happens. HEAD now matches no recorded deploy
    // tag at all. The correct behaviour is to discard this unsanctioned
    // commit and return to deploy-2 — the last point we know for certain
    // was a deliberate, recorded deploy. It is explicitly NOT "skip past
    // deploy-2 to deploy-1", because the unsanctioned commit was never a
    // deploy in the first place — there is nothing to "roll back past".
    await writeFile(join(liveDir, "file.txt"), "v3-with-local-edit\n");
    sh("git add -A", liveDir);
    sh('git commit -q -m "unsanctioned direct edit on live"', liveDir);

    const result = await undeploy(PROCESS_NAME, { cwd });
    expect(result.tag).toBe("deploy-2");

    const { readFile } = await import("fs/promises");
    const content = await readFile(join(liveDir, "file.txt"), "utf-8");
    expect(content).toBe("v3\n"); // deploy-2's content — the unsanctioned edit is discarded
  }, 25000);

  test("throws when already at the oldest recorded deploy", async () => {
    await pushBranch("feature-d1", "v2\n");
    await deploy(PROCESS_NAME, "feature-d1", { cwd });
    await pushBranch("feature-d2", "v3\n");
    await deploy(PROCESS_NAME, "feature-d2", { cwd });

    await undeploy(PROCESS_NAME, { cwd }); // now at deploy-1

    await expect(undeploy(PROCESS_NAME, { cwd })).rejects.toThrow(/oldest recorded deploy/i);
  }, 30000);

  // ── Restart behaviour ────────────────────────────────────────────────────────

  test("restarts the process on successful rollback", async () => {
    await pushBranch("feature-e1", "v2\n");
    await deploy(PROCESS_NAME, "feature-e1", { cwd });
    await pushBranch("feature-e2", "v3\n");
    await deploy(PROCESS_NAME, "feature-e2", { cwd });

    function pm2Describe(name) {
      return new Promise((res, rej) => pm2.describe(name, (err, l) => err ? rej(err) : res(l)));
    }

    await pm2Connect();
    const before = await pm2Describe(PROCESS_NAME);
    const restartsBefore = before[0].pm2_env.restart_time;
    pm2Disconnect();

    await undeploy(PROCESS_NAME, { cwd });

    await pm2Connect();
    const after = await pm2Describe(PROCESS_NAME);
    const restartsAfter = after[0].pm2_env.restart_time;
    pm2Disconnect();

    expect(restartsAfter).toBeGreaterThan(restartsBefore);
  }, 25000);
});
