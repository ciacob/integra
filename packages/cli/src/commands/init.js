// Copyright (c) 2026 Claudius Tiberiu Iacob — Licensed under BSL 1.1. See LICENSE for details.
/**
 * @int3gra/cli - commands/init.js
 *
 * `integra init <path>`
 *
 * Scaffolds a new integration's real working tree directly into
 * .integrations/<id>/live, turns that tree into a git repository, registers
 * it in registry.d/, and delivers a Markdown guide to the user-supplied
 * <path> explaining how to clone and work on it.
 *
 * Why scaffold into .integrations/<id>/live rather than <path> itself:
 * `live/` is what `integra-manager deploy` fast-forwards and what PM2 runs.
 * It has to start somewhere, and at the moment of `init` there is no .env
 * yet — zero credentials, zero risk — so doing `git init` here immediately
 * is safe. Every integration's `live/` is a git repo from the very first
 * second it exists; there is no later "turn this into a repo" step.
 *
 * <path>'s last segment becomes the integration id. <path> itself receives
 * only the guide — it is not where development happens. It is not integra's
 * business where a developer actually clones and edits; the guide just
 * tells them how.
 *
 * live/ has no remote of its own and never fetches from anywhere. It IS
 * the one repository. A developer clones it directly — which, by git's own
 * default behaviour, gives their clone an origin pointing back at live/,
 * with zero configuration needed on integra's part. They push a branch
 * into live/ itself; from that moment the branch exists as a normal local
 * branch inside live/'s own history. --branch and deploy operate on that
 * local branch directly — no fetch, no remote, no separate hosting
 * service in the picture at all.
 */

import { cpSync, mkdirSync, writeFileSync, existsSync } from "fs";
import { resolve, dirname, basename }                    from "path";
import { fileURLToPath }                                 from "url";
import { mkdir, writeFile }                              from "fs/promises";
import { execSync }                                      from "child_process";
import { userInfo }                                      from "os";

import { buildScaffoldGuide } from "../scaffoldGuide.js";
import { resolveIntegraHome } from "@int3gra/manager/home";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE  = resolve(__dirname, "../../templates/integration");

/**
 * Best-effort public IP lookup, used only to build the guide's clone
 * command — this is the address a developer clones FROM, the first and
 * only time. It has nothing to do with live/'s own git configuration,
 * which never has a remote at all.
 *
 * Returns null on any failure (no network, firewalled, command
 * unavailable, or a captive proxy/sandbox that returns an error message
 * on stdout with a zero exit code instead of failing the call outright)
 * rather than throwing — the guide falls back to a placeholder clone
 * command in that case.
 */
function resolvePublicHost() {
  try {
    const out = execSync("curl -s --max-time 3 ifconfig.me", { encoding: "utf-8" }).trim();
    // Some sandboxed/proxied environments return a human-readable rejection
    // message on stdout with exit code 0 rather than failing the command.
    // Guard against trusting that as a real host: a real IPv4/IPv6 address
    // or DNS hostname never contains whitespace.
    if (!out || /\s/.test(out)) return null;
    return out;
  } catch {
    return null;
  }
}

export async function init([pathArg]) {
  if (!pathArg) {
    throw new Error("Usage: integra init <path>");
  }

  // Two distinct roots, deliberately kept separate:
  //   home        — integra's one fixed, platform-resolved location per
  //                  host (see @int3gra/manager's home.js). registry.d/
  //                  and .integrations/<id>/live always live here,
  //                  regardless of where `integra init` is invoked from —
  //                  the same rule every other manager/--branch operation
  //                  already follows.
  //   invokedFrom  — the actual directory the developer ran the command
  //                  from. Only the generated guide lands relative to
  //                  this (via pathArg) — integra has no opinion on where
  //                  a developer's own clone ends up, and the guide is
  //                  not part of the registered, managed state.
  const home        = resolveIntegraHome();
  const invokedFrom = process.cwd();
  const id           = basename(pathArg.replace(/\/+$/, "")); // strip trailing slashes before taking last segment

  if (!id) {
    throw new Error(`Could not determine an integration id from path: ${pathArg}`);
  }

  // ── Collision checks — against both possible sources of truth ────────────
  // checkout/publish already guarantee an entry's id can never drift from
  // its filename once registered, so checking either location alone would
  // be sufficient in practice — both are checked anyway, for peace of mind,
  // at the cost of one extra existsSync call.

  const integrationsRoot = resolve(home, ".integrations");
  const liveDir           = resolve(integrationsRoot, id, "live");
  const registryDir       = resolve(home, "registry.d");
  const entryPath          = resolve(registryDir, `${id}.registry.json`);

  if (existsSync(resolve(integrationsRoot, id))) {
    throw new Error(`"${id}" already exists at .integrations/${id}/`);
  }
  if (existsSync(entryPath)) {
    throw new Error(`"${id}" is already registered at registry.d/${id}.registry.json`);
  }

  // ── Scaffold the real working tree into .integrations/<id>/live ──────────

  mkdirSync(liveDir, { recursive: true });
  cpSync(TEMPLATE, liveDir, { recursive: true });

  const manifest = {
    id,
    entry:   null,
    engine:  "1.0.0",
    created: new Date().toISOString(),
  };

  writeFileSync(
    resolve(liveDir, "integra.json"),
    JSON.stringify(manifest, null, 2) + "\n"
  );

  writeFileSync(
    resolve(liveDir, ".env.example"),
    [
      "# Environment variables for this integration",
      "# Copy to .env and fill in your values",
      "",
      "# LOG_LEVEL=debug",
      "",
    ].join("\n")
  );

  // ── git init — safe immediately: no .env exists yet, zero credentials ───
  // live/ never gets a remote of its own — it IS the repository. Developers
  // clone it directly and push branches back into it.

  execSync("git init", { cwd: liveDir, stdio: "ignore" });
  execSync("git add -A", { cwd: liveDir, stdio: "ignore" });
  try {
    execSync('git commit -m "Initial scaffold"', { cwd: liveDir, stdio: "ignore" });
  } catch {
    // A commit can fail if git user.name/user.email aren't configured on
    // this host. The repo still exists and is clonable; the developer's
    // first commit from their own clone will succeed once they configure
    // their own identity. Not fatal.
  }

  // ── Register in registry.d/ ────────────────────────────────────────────────

  await mkdir(registryDir, { recursive: true });

  const entry = {
    id,
    path:    `./.integrations/${id}/live`,
    enabled: true,
  };
  await writeFile(entryPath, JSON.stringify(entry, null, 2) + "\n");

  // ── Deliver the guide to the originally requested path ────────────────────
  // This is the only thing that lands at <path> — it is not where
  // development happens, and integra has no opinion on where the
  // developer's own clone ends up.

  const guideTarget = resolve(invokedFrom, pathArg);
  mkdirSync(guideTarget, { recursive: true });

  const host = resolvePublicHost();
  const guide = buildScaffoldGuide({
    id,
    host,
    liveDir,
    osUser: userInfo().username,
  });

  writeFileSync(resolve(guideTarget, `${id}.guide.md`), guide);

  // ── Report ───────────────────────────────────────────────────────────────

  console.log(`\n✓ Integration "${id}" created.`);
  console.log(`  Live tree:  ${liveDir}`);
  console.log(`  Registered: registry.d/${id}.registry.json`);
  console.log(`  Guide:      ${resolve(guideTarget, `${id}.guide.md`)}`);
  if (!host) {
    console.warn(`\n  ⚠  Could not auto-detect this host's address — the guide's clone command is a placeholder.`);
  }
  console.log(`\nOpen the guide for next steps — including how to clone and start developing.\n`);
}
