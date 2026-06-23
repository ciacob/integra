// Copyright (c) 2026 Claudius Tiberiu Iacob — Licensed under BSL 1.1. See LICENSE for details.
/**
 * packages/cli/test/duplicate.test.js
 *
 * `integra duplicate <path> --id <source-id> --branch <name>` forks a new,
 * independent integration from another's already-pushed branch — same
 * sequence as `init` (id resolution/validation, collision checks, git
 * init/commit, registration, guide delivery), with the empty template
 * swapped for the source branch's real content.
 *
 * The fork gets its OWN git history — one fresh commit of the forked
 * content — with no shared ancestry with the source. This suite asserts
 * that explicitly, not just the file content.
 *
 * integra's home is a literal constant (/opt/integra in production — see
 * @int3gra/manager's home.js) with no override mechanism by design, so
 * this suite mocks resolveIntegraHome/assertIntegraHomeExists to point at
 * a per-test tmpdir, the same pattern established in branchTarget.test.js.
 */

import { jest } from "@jest/globals";
import { mkdtemp, rm, writeFile, mkdir, readFile, stat } from "fs/promises";
import { tmpdir }   from "os";
import { join }     from "path";
import { execSync } from "child_process";

let mockHome;

jest.unstable_mockModule("@int3gra/manager/home", () => ({
  resolveIntegraHome:     () => mockHome,
  assertIntegraHomeExists: () => {},
}));

const { duplicate } = await import("../src/commands/duplicate.js");

function sh(cmd, dir) {
  return execSync(cmd, { cwd: dir, encoding: "utf-8" }).trim();
}

describe("integra duplicate", () => {
  let home, sourceLiveDir, cwd, originalCwd, xdgRoot;

  beforeEach(async () => {
    xdgRoot  = await mkdtemp(join(tmpdir(), "integra-home-mock-duplicate-"));
    mockHome = xdgRoot;
    home     = mockHome;

    sourceLiveDir = join(home, ".integrations", "source-int", "live");
    sh(`mkdir -p ${sourceLiveDir}`, home);
    sh("git init -q", sourceLiveDir);
    sh("git config user.email test@test.com", sourceLiveDir);
    sh("git config user.name test", sourceLiveDir);
    await writeFile(join(sourceLiveDir, "integra.json"), JSON.stringify({
      id: "source-int", entry: "main-process", engine: "1.0.0", created: "2020-01-01T00:00:00.000Z",
    }));
    for (const sub of ["connections", "maps", "processes", "resolvers"]) {
      await mkdir(join(sourceLiveDir, sub), { recursive: true });
    }
    sh("git add -A", sourceLiveDir);
    sh('git commit -q -m "source init"', sourceLiveDir);
    sh("git branch -M master", sourceLiveDir);

    await mkdir(join(home, "registry.d"), { recursive: true });
    await writeFile(
      join(home, "registry.d", "source-int.registry.json"),
      JSON.stringify({ id: "source-int", path: "./.integrations/source-int/live", enabled: true })
    );

    cwd = await mkdtemp(join(tmpdir(), "integra-duplicate-cwd-"));
    try {
      originalCwd = process.cwd();
      await stat(originalCwd);
    } catch {
      originalCwd = tmpdir();
    }
    process.chdir(cwd);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(cwd, { recursive: true, force: true });
    await rm(xdgRoot, { recursive: true, force: true });
  });

  /** Pushes a branch with the given file additions into sourceLiveDir. If
   *  the branch already exists remotely, checks it out and adds a second
   *  commit on top, rather than trying to create it fresh a second time. */
  async function pushBranch(branchName, files) {
    const devClone = join(xdgRoot, `dev-clone-${branchName}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    sh(`git clone -q ${sourceLiveDir} ${devClone}`, xdgRoot);
    sh("git config user.email test@test.com", devClone);
    sh("git config user.name test", devClone);

    const branchExists = sh(`git ls-remote --heads origin ${branchName}`, devClone).length > 0;
    if (branchExists) {
      sh(`git checkout -q ${branchName}`, devClone);
    } else {
      sh(`git checkout -q -b ${branchName}`, devClone);
    }

    for (const [relPath, content] of Object.entries(files)) {
      const full = join(devClone, relPath);
      await mkdir(join(full, ".."), { recursive: true });
      await writeFile(full, typeof content === "string" ? content : JSON.stringify(content));
    }
    sh("git add -A", devClone);
    sh(`git commit -q --allow-empty -m "on ${branchName}"`, devClone);
    sh(`git push -q origin ${branchName}`, devClone);
    await rm(devClone, { recursive: true, force: true });
  }

  // ── Argument validation ──────────────────────────────────────────────────

  test("throws when no path is given", async () => {
    await expect(duplicate(["--id", "source-int", "--branch", "x"])).rejects.toThrow(/usage/i);
  });

  test("throws when --id is missing", async () => {
    await expect(duplicate(["new-int", "--branch", "x"])).rejects.toThrow(/--id/i);
  });

  test("throws when --branch is missing", async () => {
    await expect(duplicate(["new-int", "--id", "source-int"])).rejects.toThrow(/--branch/i);
  });

  test("throws when the source id isn't registered", async () => {
    await expect(duplicate(["new-int", "--id", "nonexistent", "--branch", "x"]))
      .rejects.toThrow(/not registered/i);
  });

  test("throws when the new id equals the source id", async () => {
    await pushBranch("feature-a", {});
    await expect(duplicate(["source-int", "--id", "source-int", "--branch", "feature-a"]))
      .rejects.toThrow(/must differ/i);
  });

  test("throws when the branch was never pushed", async () => {
    await expect(duplicate(["new-int", "--id", "source-int", "--branch", "never-pushed"]))
      .rejects.toThrow(/not found in live/i);
  });

  test("throws when the new id is already taken", async () => {
    await pushBranch("feature-a", {});
    await mkdir(join(home, ".integrations", "taken", "live"), { recursive: true });
    await expect(duplicate(["taken", "--id", "source-int", "--branch", "feature-a"]))
      .rejects.toThrow(/already exists/i);
  });

  // ── Successful fork ────────────────────────────────────────────────────────

  test("creates the new integration's live/ from the branch's content", async () => {
    await pushBranch("feature-b", { "connections/extra.json": { id: "extra" } });

    await duplicate(["new-int", "--id", "source-int", "--branch", "feature-b"]);

    const newLiveDir = join(home, ".integrations", "new-int", "live");
    const content = await readFile(join(newLiveDir, "connections", "extra.json"), "utf-8");
    expect(JSON.parse(content)).toEqual({ id: "extra" });
  });

  test("forked integra.json has the NEW id, but keeps the source branch's entry value", async () => {
    await pushBranch("feature-c", {
      "integra.json": { id: "source-int", entry: "main-process", engine: "1.0.0", created: "2020-01-01T00:00:00.000Z" },
    });

    await duplicate(["new-int", "--id", "source-int", "--branch", "feature-c"]);

    const newLiveDir = join(home, ".integrations", "new-int", "live");
    const manifest = JSON.parse(await readFile(join(newLiveDir, "integra.json"), "utf-8"));
    expect(manifest.id).toBe("new-int");
    expect(manifest.entry).toBe("main-process");
  });

  test("forked integra.json gets a freshly regenerated 'created' timestamp, not the source's", async () => {
    await pushBranch("feature-d", {
      "integra.json": { id: "source-int", entry: null, engine: "1.0.0", created: "2020-01-01T00:00:00.000Z" },
    });

    await duplicate(["new-int", "--id", "source-int", "--branch", "feature-d"]);

    const newLiveDir = join(home, ".integrations", "new-int", "live");
    const manifest = JSON.parse(await readFile(join(newLiveDir, "integra.json"), "utf-8"));
    expect(manifest.created).not.toBe("2020-01-01T00:00:00.000Z");
    expect(new Date(manifest.created).getTime()).not.toBeNaN();
  });

  test("registers the new integration in registry.d/", async () => {
    await pushBranch("feature-e", {});

    await duplicate(["new-int", "--id", "source-int", "--branch", "feature-e"]);

    const raw   = await readFile(join(home, "registry.d", "new-int.registry.json"), "utf-8");
    const entry = JSON.parse(raw);
    expect(entry.id).toBe("new-int");
    expect(entry.path).toBe("./.integrations/new-int/live");
  });

  test("delivers a guide to the originally requested path", async () => {
    await pushBranch("feature-f", {});

    await duplicate(["new-int", "--id", "source-int", "--branch", "feature-f"]);

    const guidePath = join(cwd, "new-int", "new-int.guide.md");
    await expect(stat(guidePath)).resolves.toBeDefined();
  });

  // ── Independent history — the core guarantee ──────────────────────────────

  test("the new live/ is its own git repository", async () => {
    await pushBranch("feature-g", {});
    await duplicate(["new-int", "--id", "source-int", "--branch", "feature-g"]);

    const newLiveDir = join(home, ".integrations", "new-int", "live");
    await expect(stat(join(newLiveDir, ".git"))).resolves.toBeDefined();
  });

  test("the new live/ has at most one commit — no shared history with the source (commit may be staged-only if no git identity is configured on this host, same as init)", async () => {
    // Source has at least 2 commits by now (init + the pushed branch).
    await pushBranch("feature-h", { "connections/extra.json": { id: "extra" } });

    await duplicate(["new-int", "--id", "source-int", "--branch", "feature-h"]);

    const newLiveDir = join(home, ".integrations", "new-int", "live");
    let log;
    try {
      log = sh("git log --oneline", newLiveDir);
    } catch {
      // No commit landed — gitInitCommit's own documented "not fatal" path
      // (no git user.name/user.email configured on this host). The repo
      // still exists and the content is staged — confirm that instead.
      const staged = sh("git status --short", newLiveDir);
      expect(staged.length).toBeGreaterThan(0);
      return;
    }
    expect(log.split("\n")).toHaveLength(1);
  });

  test("the new live/'s commit (if one landed) names the source and branch", async () => {
    await pushBranch("feature-i", {});
    await duplicate(["new-int", "--id", "source-int", "--branch", "feature-i"]);

    const newLiveDir = join(home, ".integrations", "new-int", "live");
    let log;
    try {
      log = sh("git log -1 --format=%s", newLiveDir);
    } catch {
      return; // same "not fatal, no identity configured" accommodation as above
    }
    expect(log).toContain("source-int");
    expect(log).toContain("feature-i");
  });

  test("the new live/ has no remote configured — same as a fresh init", async () => {
    await pushBranch("feature-j", {});
    await duplicate(["new-int", "--id", "source-int", "--branch", "feature-j"]);

    const newLiveDir = join(home, ".integrations", "new-int", "live");
    const remotes = sh("git remote", newLiveDir);
    expect(remotes).toBe("");
  });

  test("a commit on the source's branch AFTER duplicating does not appear in the fork", async () => {
    await pushBranch("feature-k", { "connections/v1.json": { v: 1 } });
    await duplicate(["new-int", "--id", "source-int", "--branch", "feature-k"]);

    // Push a second commit onto the SAME branch, after the fork was made.
    await pushBranch("feature-k", { "connections/v2.json": { v: 2 } });

    const newLiveDir = join(home, ".integrations", "new-int", "live");
    await expect(stat(join(newLiveDir, "connections", "v1.json"))).resolves.toBeDefined();
    await expect(stat(join(newLiveDir, "connections", "v2.json"))).rejects.toThrow();
  });
});
