// Copyright (c) 2026 Claudius Tiberiu Iacob — Licensed under BSL 1.1. See LICENSE for details.
/**
 * packages/manager/test/archive.test.js
 *
 * live/ IS the repository — there is no separate bare remote. Developer
 * clones are created directly from live/ (git clone <path-to-live>), and
 * they push branches back into live/ itself. This suite's setup mirrors
 * that topology exactly: liveDir is the one true repo; pushBranch clones
 * FROM liveDir and pushes back INTO it.
 */
import { mkdtemp, rm, readFile, readdir, writeFile } from "fs/promises";
import { tmpdir }   from "os";
import { join }     from "path";
import { execSync } from "child_process";

import { resolveArchive as resolveArchiveRaw } from "../src/archive.js";
import { publishEntry }   from "../src/registryStorage.js";

// Every call in this file must use this wrapper, not resolveArchiveRaw
// directly — it injects a no-op for the sweep-daemon launcher so these
// tests never connect to a real PM2 daemon on this machine. A prior
// version of this suite called resolveArchive directly and genuinely
// started (and left running) a real PM2-managed process as a side effect
// of running the test suite — confirmed and cleaned up by hand once, never
// to be repeated.
function resolveArchive(id, branch, cwd) {
  return resolveArchiveRaw(id, branch, cwd, { ensureSweepRunning: async () => {} });
}

describe("resolveArchive", () => {
  let cwd, liveDir;

  function sh(cmd, dir) {
    return execSync(cmd, { cwd: dir, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  }

  beforeEach(async () => {
    cwd     = await mkdtemp(join(tmpdir(), "integra-archive-test-"));
    liveDir = join(cwd, ".integrations", "my-int", "live");

    sh(`mkdir -p ${liveDir}`, cwd);
    sh("git init -q", liveDir);
    sh("git config user.email test@test.com", liveDir);
    sh("git config user.name test", liveDir);
    await writeFile(join(liveDir, "file.txt"), "v1\n");
    sh("git add -A", liveDir);
    sh('git commit -q -m "v1"', liveDir);
    sh("git branch -M master", liveDir); // normalize default branch name across git versions

    await publishEntry(cwd, "my-int", { id: "my-int", path: "./.integrations/my-int/live" });
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  // Clones DIRECTLY from liveDir (simulating a developer's own clone),
  // commits on a new branch, then pushes that branch BACK INTO liveDir —
  // exactly the topology a real developer would use.
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

  test("throws when id or branch is missing", async () => {
    await expect(resolveArchive(undefined, "main", cwd)).rejects.toThrow();
    await expect(resolveArchive("my-int", undefined, cwd)).rejects.toThrow();
  });

  test("throws when the id is not registered", async () => {
    await expect(resolveArchive("nonexistent", "master", cwd)).rejects.toThrow(/not registered/i);
  });

  test("throws a clear error when the branch was never pushed into live/", async () => {
    await expect(resolveArchive("my-int", "never-pushed", cwd)).rejects.toThrow(/was not found in live/i);
  });

  test("archives a branch pushed from a developer's clone, with no fetch step", async () => {
    await pushBranch("feature-x", "v2-feature\n");

    const { path } = await resolveArchive("my-int", "feature-x", cwd);
    const content   = await readFile(join(path, "file.txt"), "utf-8");
    expect(content).toBe("v2-feature\n");
  });

  test("archived folder contains no .git directory", async () => {
    await pushBranch("feature-y", "v2\n");
    const { path } = await resolveArchive("my-int", "feature-y", cwd);

    const entries = await readdir(path);
    expect(entries).not.toContain(".git");
  });

  test("returns the resolved SHA, matching live/'s own rev-parse for that branch", async () => {
    await pushBranch("feature-z", "v2\n");

    const { sha } = await resolveArchive("my-int", "feature-z", cwd);
    expect(sha).toMatch(/^[0-9a-f]{40}$/);

    const liveSha = sh("git rev-parse feature-z", liveDir);
    expect(sha).toBe(liveSha);
  });

  test("second call for the same branch with no new commits reuses the existing folder (no rearchive)", async () => {
    await pushBranch("feature-stable", "v2\n");

    const first  = await resolveArchive("my-int", "feature-stable", cwd);
    // Mark the folder so we can prove it wasn't recreated
    await writeFile(join(first.path, "marker.txt"), "still here");

    const second = await resolveArchive("my-int", "feature-stable", cwd);
    expect(second.path).toBe(first.path);
    expect(second.sha).toBe(first.sha);

    const markerContent = await readFile(join(second.path, "marker.txt"), "utf-8");
    expect(markerContent).toBe("still here"); // proves no rearchive overwrote it
  });

  test("a branch that moves (new commit pushed) produces a new SHA-named folder, leaving the old one behind", async () => {
    await pushBranch("feature-moves", "v2\n");
    const first = await resolveArchive("my-int", "feature-moves", cwd);

    // Push a second commit to the same branch from another dev clone
    const devClone2 = join(cwd, "dev-clone-feature-moves-2");
    sh(`git clone -q ${liveDir} ${devClone2}`, cwd);
    sh("git config user.email test@test.com", devClone2);
    sh("git config user.name test", devClone2);
    sh("git checkout -q feature-moves", devClone2);
    await writeFile(join(devClone2, "file.txt"), "v3\n");
    sh("git add -A", devClone2);
    sh('git commit -q -m "v3"', devClone2);
    sh("git push -q origin feature-moves", devClone2);

    const second = await resolveArchive("my-int", "feature-moves", cwd);

    expect(second.sha).not.toBe(first.sha);
    expect(second.path).not.toBe(first.path);

    const oldContent = await readFile(join(first.path, "file.txt"), "utf-8");
    const newContent = await readFile(join(second.path, "file.txt"), "utf-8");
    expect(oldContent).toBe("v2\n"); // old archive untouched
    expect(newContent).toBe("v3\n"); // new archive has the new content
  });

  test("concurrent requests for the same new branch both succeed without corrupting the result", async () => {
    await pushBranch("feature-concurrent", "v2\n");

    const [a, b] = await Promise.all([
      resolveArchive("my-int", "feature-concurrent", cwd),
      resolveArchive("my-int", "feature-concurrent", cwd),
    ]);

    expect(a.sha).toBe(b.sha);
    expect(a.path).toBe(b.path);

    const content = await readFile(join(a.path, "file.txt"), "utf-8");
    expect(content).toBe("v2\n");
  });
});
