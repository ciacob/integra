// Copyright (c) 2026 Claudius Tiberiu Iacob — Licensed under BSL 1.1. See LICENSE for details.
/**
 * packages/cli/test/init.test.js
 *
 * Tests for the init command — scaffolding into .integrations/<id>/live,
 * git init there, registry.d/ registration, and guide delivery to the
 * originally requested path.
 *
 * init() registers against integra's one fixed home (/opt/integra in
 * production — see @int3gra/manager's home.js) rather than process.cwd().
 * The home is a literal constant with no override mechanism by design,
 * so these tests mock @int3gra/manager/home's resolveIntegraHome and
 * assertIntegraHomeExists to point at a per-test tmpdir, rather than
 * touching the real /opt/integra (see branchTarget.test.js, which
 * established this approach first).
 *
 * The guide is the one thing that still lands relative to the real
 * invocation directory (cwd) — it is not part of the registered, managed
 * state, so it is asserted against `cwd`, while everything registry/live
 * related is asserted against `home`.
 */

import { jest } from "@jest/globals";
import { mkdtemp, rm, mkdir, readFile, stat, access, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join, basename } from "path";
import { execSync } from "child_process";

let mockHome;

jest.unstable_mockModule("@int3gra/manager/home", () => ({
  resolveIntegraHome:     () => mockHome,
  assertIntegraHomeExists: () => {}, // mockHome always exists in these tests — nothing to assert
}));

const { init, resolveAndValidateId } = await import("../src/commands/init.js");

describe("resolveAndValidateId (pure)", () => {
  test("resolves a simple relative path against invokedFrom", () => {
    const { id, resolvedPath } = resolveAndValidateId("my-integration", "/home/dev");
    expect(id).toBe("my-integration");
    expect(resolvedPath).toBe("/home/dev/my-integration");
  });

  test("'.' resolves to invokedFrom's own basename, not the literal string '.'", () => {
    const { id, resolvedPath } = resolveAndValidateId(".", "/home/dev/my-project");
    expect(id).toBe("my-project");
    expect(resolvedPath).toBe("/home/dev/my-project");
  });

  test("'..' walks up correctly", () => {
    const { id } = resolveAndValidateId("..", "/home/dev/my-project/nested");
    expect(id).toBe("my-project");
  });

  test("an absolute path passes through resolve() unchanged", () => {
    const { id, resolvedPath } = resolveAndValidateId("/opt/somewhere/my-int", "/home/dev");
    expect(id).toBe("my-int");
    expect(resolvedPath).toBe("/opt/somewhere/my-int");
  });

  test("strips a trailing slash before taking the last segment", () => {
    const { id } = resolveAndValidateId("my-integration/", "/home/dev");
    expect(id).toBe("my-integration");
  });

  test("rejects the filesystem root, whose basename is empty", () => {
    expect(() => resolveAndValidateId("/", "/home/dev")).toThrow(/not a valid integration id/i);
  });

  test("rejects '~'", () => {
    expect(() => resolveAndValidateId("~", "/home/dev")).toThrow(/not a valid integration id/i);
  });

  test("rejects a leading digit", () => {
    expect(() => resolveAndValidateId("1-bad", "/home/dev")).toThrow(/not a valid integration id/i);
  });

  test("rejects a leading hyphen", () => {
    expect(() => resolveAndValidateId("-bad", "/home/dev")).toThrow(/not a valid integration id/i);
  });

  test("rejects embedded spaces", () => {
    expect(() => resolveAndValidateId("my integration", "/home/dev")).toThrow(/not a valid integration id/i);
  });

  test("rejects embedded symbols", () => {
    expect(() => resolveAndValidateId("my@integration", "/home/dev")).toThrow(/not a valid integration id/i);
  });

  test("accepts underscores", () => {
    const { id } = resolveAndValidateId("my_integration", "/home/dev");
    expect(id).toBe("my_integration");
  });

  test("accepts mixed case", () => {
    const { id } = resolveAndValidateId("My-Integration", "/home/dev");
    expect(id).toBe("My-Integration");
  });
});

describe("integra init", () => {
  let cwd, originalCwd;
  let home, xdgRoot;

  beforeEach(async () => {
    // mockHome stands in for integra's fixed home for this test only —
    // resolveIntegraHome/assertIntegraHomeExists are mocked above to use it.
    xdgRoot  = await mkdtemp(join(tmpdir(), "integra-home-mock-"));
    mockHome = xdgRoot;
    home     = mockHome;

    // cwd simulates "wherever the developer happens to be standing when
    // they run `integra init`" — deliberately a different directory than
    // home, to prove the guide lands relative to invocation, not home.
    cwd = await mkdtemp(join(tmpdir(), "integra-init-test-"));
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

  // ── Basic usage ────────────────────────────────────────────────────────────

  test("throws when no path is given", async () => {
    await expect(init([])).rejects.toThrow(/usage/i);
  });

  test("extracts id as the last path segment", async () => {
    await init(["my-integration"]);
    await expect(stat(join(home, ".integrations", "my-integration", "live"))).resolves.toBeDefined();
  });

  test("extracts id correctly from a nested path", async () => {
    await init(["some/nested/my-integration"]);
    await expect(stat(join(home, ".integrations", "my-integration", "live"))).resolves.toBeDefined();
  });

  test("extracts id correctly when path has a trailing slash", async () => {
    await init(["my-integration/"]);
    await expect(stat(join(home, ".integrations", "my-integration", "live"))).resolves.toBeDefined();
  });

  // ── Path resolution against cwd ─────────────────────────────────────────────
  // pathArg is resolved to an absolute path (walking ".."/"." segments,
  // normalising) before its last segment is taken as the id — never a
  // naive basename() of the raw argument string.

  test("'.' resolves to the real name of the current directory, not the literal string '.'", async () => {
    // cwd is a tmpdir whose basename is some random-looking name — that
    // name is what must become the id, never the literal "." string this
    // bug previously produced.
    const expectedId = basename(cwd);
    await init(["."]);
    await expect(stat(join(home, ".integrations", expectedId, "live"))).resolves.toBeDefined();
    const raw = await readFile(join(home, "registry.d", `${expectedId}.registry.json`), "utf-8");
    expect(JSON.parse(raw).id).toBe(expectedId);
  });

  test("a relative path with '..' resolves against cwd correctly", async () => {
    // cwd/sibling-dir doesn't need to exist for resolution purposes —
    // resolve() is pure string/path math, not a filesystem check.
    await init(["../my-integration"]);
    await expect(stat(join(home, ".integrations", "my-integration", "live"))).resolves.toBeDefined();
  });

  test("an absolute path resolves to itself unchanged (passes through resolve() as a no-op)", async () => {
    const absPath = join(cwd, "abs-test", "my-integration");
    await init([absPath]);
    await expect(stat(join(home, ".integrations", "my-integration", "live"))).resolves.toBeDefined();
  });

  test("guide lands at the resolved path, not a re-derivation of the raw argument", async () => {
    await init(["./my-integration"]);
    await expect(
      access(join(cwd, "my-integration", "my-integration.guide.md"))
    ).resolves.toBeUndefined();
  });

  // ── Id validation ────────────────────────────────────────────────────────────
  // The id becomes a directory name, a JSON filename, and a PM2 process
  // name — "non-empty" is not a strong enough rule. Must start with a
  // letter, then only letters/digits/hyphens/underscores, case-insensitive.

  test("rejects the filesystem root ('/'), whose basename is empty", async () => {
    await expect(init(["/"])).rejects.toThrow(/not a valid integration id/i);
  });

  test("rejects '~' as an id", async () => {
    await expect(init(["~"])).rejects.toThrow(/not a valid integration id/i);
  });

  test("rejects an id starting with a digit", async () => {
    await expect(init(["1-my-integration"])).rejects.toThrow(/not a valid integration id/i);
  });

  test("rejects an id starting with a hyphen", async () => {
    await expect(init(["-my-integration"])).rejects.toThrow(/not a valid integration id/i);
  });

  test("rejects an id containing spaces", async () => {
    await expect(init(["my integration"])).rejects.toThrow(/not a valid integration id/i);
  });

  test("rejects an id containing other symbols (e.g. '@')", async () => {
    await expect(init(["my@integration"])).rejects.toThrow(/not a valid integration id/i);
  });

  test("accepts an id with underscores, exactly like one with hyphens", async () => {
    await init(["my_integration"]);
    await expect(stat(join(home, ".integrations", "my_integration", "live"))).resolves.toBeDefined();
  });

  test("accepts a mixed-case id — case does not matter", async () => {
    await init(["My-Integration"]);
    await expect(stat(join(home, ".integrations", "My-Integration", "live"))).resolves.toBeDefined();
  });

  test("rejection message names the offending id and states the rule", async () => {
    await expect(init(["~"])).rejects.toThrow(/letters, digits, hyphens, and underscores/i);
  });

  // ── Scaffolding into .integrations/<id>/live ──────────────────────────────

  test("scaffolds integra.json into live/ with the correct id", async () => {
    await init(["my-integration"]);
    const liveDir = join(home, ".integrations", "my-integration", "live");
    const manifest = JSON.parse(await readFile(join(liveDir, "integra.json"), "utf-8"));
    expect(manifest.id).toBe("my-integration");
    expect(manifest.entry).toBeNull();
  });

  test("scaffolds .env.example into live/", async () => {
    await init(["my-integration"]);
    const liveDir = join(home, ".integrations", "my-integration", "live");
    await expect(access(join(liveDir, ".env.example"))).resolves.toBeUndefined();
  });

  test("does NOT place integra.json at the originally requested path", async () => {
    await init(["my-integration"]);
    await expect(access(join(cwd, "my-integration", "integra.json"))).rejects.toThrow();
  });

  // ── git init on live/ ──────────────────────────────────────────────────────

  test("live/ is a git repository", async () => {
    await init(["my-integration"]);
    const liveDir = join(home, ".integrations", "my-integration", "live");
    await expect(stat(join(liveDir, ".git"))).resolves.toBeDefined();
  });

  test("live/'s initial scaffold is committed (or at minimum staged) — repo is non-empty", async () => {
    await init(["my-integration"]);
    const liveDir = join(home, ".integrations", "my-integration", "live");
    // Either a commit exists, or the files are at least staged — both are
    // acceptable depending on whether git user.name/email are configured
    // on this host. What must NOT happen is an empty, untracked repo.
    const status = execSync("git status --porcelain", { cwd: liveDir, encoding: "utf-8" });
    // If commit succeeded, status is empty (clean tree). If commit failed
    // (no identity configured), files show as staged additions. Either way
    // this call must not throw, proving .git is a valid repo.
    expect(typeof status).toBe("string");
  });

  // ── Collisions ────────────────────────────────────────────────────────────

  test("throws when .integrations/<id> already exists", async () => {
    await mkdir(join(home, ".integrations", "existing"), { recursive: true });
    await expect(init(["existing"])).rejects.toThrow(/already exists/i);
  });

  test("throws when registry.d/<id>.registry.json already exists, even if .integrations/<id> doesn't", async () => {
    await mkdir(join(home, "registry.d"), { recursive: true });
    await writeFile(
      join(home, "registry.d", "phantom.registry.json"),
      JSON.stringify({ id: "phantom", path: "./somewhere" })
    );
    await expect(init(["phantom"])).rejects.toThrow(/already registered/i);
  });

  // ── registry.d/ registration ──────────────────────────────────────────────

  test("creates registry.d/ when it doesn't exist yet", async () => {
    await init(["my-integration"]);
    await expect(stat(join(home, "registry.d"))).resolves.toBeDefined();
  });

  test("registered entry points at .integrations/<id>/live", async () => {
    await init(["my-integration"]);
    const raw   = await readFile(join(home, "registry.d", "my-integration.registry.json"), "utf-8");
    const entry = JSON.parse(raw);
    expect(entry.id).toBe("my-integration");
    expect(entry.path).toBe("./.integrations/my-integration/live");
    expect(entry.enabled).toBe(true);
  });

  // ── Fixed home, not cwd ────────────────────────────────────────────────────
  // Regression coverage for the home/cwd split itself: init() must register
  // against integra's one fixed home regardless of invocation directory,
  // the same rule every other manager/--branch operation already follows.
  // Before this fix, .integrations/ and registry.d/ were written into cwd.

  test("does NOT write .integrations/ into cwd", async () => {
    await init(["my-integration"]);
    await expect(access(join(cwd, ".integrations"))).rejects.toThrow();
  });

  test("does NOT write registry.d/ into cwd", async () => {
    await init(["my-integration"]);
    await expect(access(join(cwd, "registry.d"))).rejects.toThrow();
  });

  // ── Guide delivery ─────────────────────────────────────────────────────────

  test("delivers a guide file to the originally requested path", async () => {
    await init(["my-integration"]);
    await expect(access(join(cwd, "my-integration", "my-integration.guide.md"))).resolves.toBeUndefined();
  });

  test("guide content mentions the live/ path and the deploy command", async () => {
    await init(["my-integration"]);
    const guide = await readFile(join(cwd, "my-integration", "my-integration.guide.md"), "utf-8");
    expect(guide).toContain(".integrations/my-integration/live");
    expect(guide).toContain("integra-manager deploy my-integration");
  });

  test("console output tells the user how to download the guide to their own machine, including the general form", async () => {
    const logs = [];
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(" "));
    try {
      await init(["my-integration"]);
    } finally {
      console.log = origLog;
    }

    const joined = logs.join("\n");
    expect(joined).toContain("scp <user>@<host>:<path> .");
    // The computed form (a real resolved host) is exercised in
    // scaffoldGuide.test.js directly, with an injected host value — this
    // sandbox's own resolvePublicHost() genuinely returns null (see the
    // clone-line regression test below), so the line actually printed
    // here is the documented null fallback, not a real computed host.
    expect(joined).toMatch(/scp \S+@\S+:.*my-integration\.guide\.md \./);
  });

  test("the scp instruction never embeds null/undefined when host resolution fails (real sandbox condition — see the clone-line regression test above)", async () => {
    const logs = [];
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(" "));
    try {
      await init(["my-integration"]);
    } finally {
      console.log = origLog;
    }

    const joined = logs.join("\n");
    expect(joined).not.toContain("null");
    expect(joined).not.toContain("undefined");
    expect(joined).toMatch(/scp \S+@<this-host>:/);
  });

  test("guide delivered to a nested path lands at that nested path, not at cwd root", async () => {
    await init(["some/nested/my-integration"]);
    await expect(
      access(join(cwd, "some", "nested", "my-integration", "my-integration.guide.md"))
    ).resolves.toBeUndefined();
  });

  test("regression: a host lookup that returns a non-host string (e.g. a sandbox rejection message on stdout) produces only the general clone form, never a corrupted one", async () => {
    // This exercises the real resolvePublicHost() path in this sandboxed
    // test environment, where the IP-lookup host is genuinely not in the
    // network allowlist and curl returns a rejection message on stdout
    // with exit code 0 — the exact condition that originally caused the
    // rejection text to be embedded directly into the clone command.
    await init(["my-integration"]);
    const guide    = await readFile(join(cwd, "my-integration", "my-integration.guide.md"), "utf-8");
    const cloneLine = guide.split("\n").find(l => l.startsWith("git clone"));
    expect(cloneLine).toBeDefined();
    // Must be the clean general form, never contain whitespace-laden
    // rejection text where a host/IP belongs, and no computed e.g. line.
    expect(cloneLine).toBe("git clone <user>@<host>:<path> <local-folder-name>");
  });

  // ── live/ has no remote of its own ─────────────────────────────────────────
  // live/ IS the repository — it never fetches from anywhere, so it never
  // has a remote configured. Developers clone it directly; that clone gets
  // an origin pointing back at live/, by git's own default behaviour, but
  // live/ itself stays remote-less forever.

  test("live/ has no remote configured", async () => {
    await init(["my-integration"]);
    const liveDir = join(home, ".integrations", "my-integration", "live");
    await expect(
      (async () => execSync("git remote", { cwd: liveDir, encoding: "utf-8" }).trim())()
    ).resolves.toBe("");
  });

  // ── live/'s default branch is always named "live" ───────────────────────────
  // Never whatever the host's git happens to default to (master, main, or
  // anything else, depending on git version/global config) — one
  // unambiguous, always-the-same name, on every host, for the one branch
  // nobody should push to directly.

  test("live/'s initial branch is named 'live', not master/main/whatever the host defaults to", async () => {
    await init(["my-integration"]);
    const liveDir = join(home, ".integrations", "my-integration", "live");
    const branch = execSync("git symbolic-ref --short HEAD", { cwd: liveDir, encoding: "utf-8" }).trim();
    expect(branch).toBe("live");
  });

  // ── A pre-receive hook deters direct pushes to that branch ─────────────────
  // Deterrent, not a hard security boundary (see init.js's own docstring on
  // buildPreReceiveHook) — but it should genuinely reject the common,
  // accidental case: a developer pushing straight to "live" from habit.

  test("live/ has an executable pre-receive hook installed", async () => {
    await init(["my-integration"]);
    const liveDir = join(home, ".integrations", "my-integration", "live");
    const hookPath = join(liveDir, ".git", "hooks", "pre-receive");
    const stats = await stat(hookPath);
    expect(stats.mode & 0o111).not.toBe(0); // at least one executable bit set
  });

  test("the installed hook actually rejects a direct push to 'live', end to end", async () => {
    await init(["my-integration"]);
    const liveDir = join(home, ".integrations", "my-integration", "live");

    // gitInitCommit's own commit can be a no-op (staged-only) if no git
    // identity is configured on this host — same accommodation other
    // tests in this file already make. Configure one here so this test
    // can push a real second commit regardless of the host's state.
    execSync("git config user.email test@test.com", { cwd: liveDir });
    execSync("git config user.name test", { cwd: liveDir });
    execSync("git add -A", { cwd: liveDir, stdio: "ignore" });
    execSync('git commit --allow-empty -q -m "ensure at least one commit exists"', { cwd: liveDir, stdio: "ignore" });

    const devClone = await mkdtemp(join(tmpdir(), "integra-hook-test-clone-"));
    try {
      execSync(`git clone -q ${liveDir} ${devClone}`);
      execSync("git config user.email test@test.com", { cwd: devClone });
      execSync("git config user.name test", { cwd: devClone });
      await writeFile(join(devClone, "direct-edit.txt"), "should not land");
      execSync("git add -A", { cwd: devClone, stdio: "ignore" });
      execSync('git commit -q -m "direct edit"', { cwd: devClone, stdio: "ignore" });

      expect(() => execSync("git push origin live", { cwd: devClone, stdio: "pipe" }))
        .toThrow();

      // The legitimate path — a differently-named branch — must still work.
      execSync("git checkout -q -b my-patch", { cwd: devClone });
      expect(() => execSync("git push origin my-patch", { cwd: devClone, stdio: "pipe" }))
        .not.toThrow();
    } finally {
      await rm(devClone, { recursive: true, force: true });
    }
  });
});
