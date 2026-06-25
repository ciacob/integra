// Copyright (c) 2026 Claudius Tiberiu Iacob — Licensed under BSL 1.1. See LICENSE for details.
/**
 * packages/manager/test/packageDependencies.test.js
 *
 * Every third-party import in a package's src/ must be declared in that
 * SAME package's own package.json — not merely resolvable, which is all
 * a monorepo's hoisted, shared node_modules guarantees. A package that
 * imports something it never declared works fine here, inside this
 * workspace, because some OTHER package's declaration happens to pull
 * the dependency into the shared node_modules tree everyone can see.
 * It silently breaks the moment that package is installed standalone
 * (e.g. `npm install -g @int3gra/manager`), which has no such tree to
 * fall back on — exactly what happened with `ajv` in @int3gra/manager
 * before this test existed: a real, undeclared import, masked here,
 * that only surfaced on a genuine isolated install.
 *
 * This test parses no actual JS syntax — it's a regex scan over import
 * statements, deliberately simple. It is not a substitute for a real
 * isolated-install smoke test (see this repo's manual verification
 * practice of `npm pack` + install into a scratch directory before
 * shipping a dependency change) — it catches the common case (a bare
 * `import ... from "pkg"`) cheaply and automatically, on every test run,
 * which a manual pack-and-install check never runs by itself.
 */

import { readFile, readdir } from "fs/promises";
import { builtinModules } from "module";
import { resolve, join } from "path";
import { fileURLToPath } from "url";

const __dirname  = resolve(fileURLToPath(import.meta.url), "..");
const PACKAGES_DIR = resolve(__dirname, "../../../packages");

const BUILTIN_NAMES = new Set([
  ...builtinModules,
  ...builtinModules.map(m => `node:${m}`),
]);

// Matches: import X from "pkg"; import { a, b } from "pkg"; import "pkg";
// import X from "pkg/subpath"; await import("pkg"); — capturing just the
// quoted specifier each time.
const IMPORT_RE = /\bimport\s+(?:[^'"]*?\s+from\s+)?["']([^'"]+)["']|\bimport\(\s*["']([^'"]+)["']\s*\)/g;

async function listJsFilesRecursive(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listJsFilesRecursive(full));
    } else if (entry.name.endsWith(".js")) {
      files.push(full);
    }
  }
  return files;
}

/** Extracts the package name from an import specifier — "ajv" from
 *  "ajv", "@int3gra/manager" from "@int3gra/manager/home", etc. Returns
 *  null for relative/absolute specifiers and Node builtins, which this
 *  check has nothing to say about. */
function packageNameFromSpecifier(specifier) {
  if (specifier.startsWith(".") || specifier.startsWith("/")) return null;
  if (BUILTIN_NAMES.has(specifier)) return null;

  const segments = specifier.split("/");
  if (specifier.startsWith("@")) {
    return segments.slice(0, 2).join("/"); // @scope/name, even with a subpath
  }
  return segments[0];
}

async function collectImportedPackages(srcDir) {
  const files = await listJsFilesRecursive(srcDir);
  const found = new Set();

  for (const file of files) {
    const content = await readFile(file, "utf-8");
    for (const match of content.matchAll(IMPORT_RE)) {
      const specifier = match[1] ?? match[2];
      const pkgName = packageNameFromSpecifier(specifier);
      if (pkgName) found.add(pkgName);
    }
  }
  return found;
}

async function packagesUnderTest() {
  const names = await readdir(PACKAGES_DIR);
  const result = [];
  for (const name of names) {
    const pkgJsonPath = resolve(PACKAGES_DIR, name, "package.json");
    try {
      const raw = await readFile(pkgJsonPath, "utf-8");
      result.push({ name, dir: resolve(PACKAGES_DIR, name), manifest: JSON.parse(raw) });
    } catch {
      // Not a real package directory (no package.json) — skip silently.
    }
  }
  return result;
}

describe("every package's third-party imports are declared in its OWN package.json", () => {
  test("sanity: this workspace actually has packages to check", async () => {
    const pkgs = await packagesUnderTest();
    expect(pkgs.length).toBeGreaterThan(0);
  });

  test("no package imports a third-party module it doesn't declare", async () => {
    const pkgs = await packagesUnderTest();
    const violations = [];

    for (const pkg of pkgs) {
      const srcDir = resolve(pkg.dir, "src");
      let imported;
      try {
        imported = await collectImportedPackages(srcDir);
      } catch (err) {
        if (err.code === "ENOENT") continue; // no src/ — nothing to check
        throw err;
      }

      const declared = new Set([
        ...Object.keys(pkg.manifest.dependencies ?? {}),
        ...Object.keys(pkg.manifest.peerDependencies ?? {}),
        ...Object.keys(pkg.manifest.optionalDependencies ?? {}),
      ]);

      for (const importedPkg of imported) {
        if (!declared.has(importedPkg)) {
          violations.push(`${pkg.name} imports "${importedPkg}" but doesn't declare it in package.json`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  // Regression coverage for the actual bug this test exists to catch —
  // proves the scan mechanism itself works, independent of whatever the
  // real packages currently do or don't import.
  test("the scan mechanism itself: detects an undeclared import in a synthetic fixture", async () => {
    const { mkdtemp, writeFile, mkdir, rm } = await import("fs/promises");
    const { tmpdir } = await import("os");

    const fixtureDir = await mkdtemp(join(tmpdir(), "pkgdep-fixture-"));
    try {
      await mkdir(join(fixtureDir, "src"), { recursive: true });
      await writeFile(join(fixtureDir, "src", "thing.js"), 'import Ajv from "ajv";\nexport const x = 1;\n');
      await writeFile(
        join(fixtureDir, "package.json"),
        JSON.stringify({ name: "fixture-pkg", dependencies: {} })
      );

      const imported = await collectImportedPackages(join(fixtureDir, "src"));
      expect(imported.has("ajv")).toBe(true);
    } finally {
      await rm(fixtureDir, { recursive: true, force: true });
    }
  });

  test("the scan mechanism correctly ignores relative imports, builtins, and internal @int3gra packages", async () => {
    const { mkdtemp, writeFile, mkdir, rm } = await import("fs/promises");
    const { tmpdir } = await import("os");

    const fixtureDir = await mkdtemp(join(tmpdir(), "pkgdep-fixture-clean-"));
    try {
      await mkdir(join(fixtureDir, "src"), { recursive: true });
      await writeFile(
        join(fixtureDir, "src", "thing.js"),
        [
          'import { readFile } from "fs/promises";',
          'import { resolve } from "node:path";',
          'import { helper } from "./helper.js";',
          'import { other } from "../other.js";',
          'import { readHomeConfig } from "@int3gra/manager/home";',
        ].join("\n")
      );

      const imported = await collectImportedPackages(join(fixtureDir, "src"));
      expect(Array.from(imported)).toEqual(["@int3gra/manager"]);
    } finally {
      await rm(fixtureDir, { recursive: true, force: true });
    }
  });
});
