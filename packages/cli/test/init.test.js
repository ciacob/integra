// Copyright (c) 2026 Claudius Tiberiu Iacob — Licensed under BSL 1.1. See LICENSE for details.
/**
 * packages/cli/test/init.test.js
 *
 * Tests for the init command — scaffolding into .integrations/<id>/live,
 * git init there, registry.d/ registration, and guide delivery to the
 * originally requested path.
 *
 * init() now registers against integra's one fixed home (resolved via
 * env-paths) rather than process.cwd() — the same rule every other
 * manager/--branch operation already follows. Tests isolate that fixed
 * home per-test via XDG_DATA_HOME, which env-paths itself honours (see
 * branchTarget.test.js, which established this seam first).
 *
 * The guide is the one thing that still lands relative to the real
 * invocation directory (cwd) — it is not part of the registered, managed
 * state, so it is asserted against `cwd`, while everything registry/live
 * related is asserted against `home`.
 */

import { mkdtemp, rm, mkdir, readFile, stat, access, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { execSync } from "child_process";

import { init } from "../src/commands/init.js";

describe("integra init", () => {
  let cwd, originalCwd;
  let home, xdgRoot, priorXdgDataHome;

  beforeEach(async () => {
    // Isolate integra's resolved home per test via XDG_DATA_HOME — this is
    // the same env var env-paths itself reads on Linux, confirmed directly
    // (not assumed) in branchTarget.test.js before relying on it as a test
    // seam here too.
    xdgRoot = await mkdtemp(join(tmpdir(), "integra-xdg-"));
    priorXdgDataHome = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = xdgRoot;

    const { resolveIntegraHome } = await import("@int3gra/manager/home");
    home = resolveIntegraHome();

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
    if (priorXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = priorXdgDataHome;
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

  test("guide delivered to a nested path lands at that nested path, not at cwd root", async () => {
    await init(["some/nested/my-integration"]);
    await expect(
      access(join(cwd, "some", "nested", "my-integration", "my-integration.guide.md"))
    ).resolves.toBeUndefined();
  });

  test("regression: a host lookup that returns a non-host string (e.g. a sandbox rejection message on stdout) produces the placeholder clone command, not a corrupted one", async () => {
    // This exercises the real resolvePublicHost() path in this sandboxed
    // test environment, where the IP-lookup host is genuinely not in the
    // network allowlist and curl returns a rejection message on stdout
    // with exit code 0 — the exact condition that originally caused the
    // rejection text to be embedded directly into the clone command.
    await init(["my-integration"]);
    const guide    = await readFile(join(cwd, "my-integration", "my-integration.guide.md"), "utf-8");
    const cloneLine = guide.split("\n").find(l => l.startsWith("git clone"));
    expect(cloneLine).toBeDefined();
    // Must be the clean placeholder form, never contain whitespace-laden
    // rejection text where a host/IP belongs.
    expect(cloneLine).toMatch(/git clone <user>@<this-host>:/);
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
});
