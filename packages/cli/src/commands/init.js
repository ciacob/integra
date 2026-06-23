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
 * `integra duplicate` (see commands/duplicate.js) is the same sequence with
 * one piece swapped: instead of an empty template, the new live/ is seeded
 * from an existing integration's pushed branch. Every other step — id
 * resolution/validation, collision checks, git init/commit, registry
 * registration, guide delivery — is identical and lives here, exported,
 * rather than duplicated.
 *
 * Why scaffold into .integrations/<id>/live rather than <path> itself:
 * `live/` is what `integra-manager deploy` fast-forwards and what PM2 runs.
 * It has to start somewhere, and at the moment of `init` there is no .env
 * yet — zero credentials, zero risk — so doing `git init` here immediately
 * is safe. Every integration's `live/` is a git repo from the very first
 * second it exists; there is no later "turn this into a repo" step.
 *
 * <path> is resolved to an absolute path against the invocation directory
 * before anything else happens (a relative argument like "." or "../foo"
 * is walked/normalised the same way any real path would be — never a
 * naive string basename of the raw argument). The resolved path's last
 * segment becomes the integration id, and must look like a safe token —
 * starts with a letter, then only letters/digits/hyphens/underscores,
 * case-insensitive — since it ends up as a directory name, a JSON
 * filename, and a PM2 process name. <path> itself receives only the
 * guide — it is not where development happens. It is not integra's
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

import { cpSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "fs";
import { resolve, dirname, basename }                    from "path";
import { fileURLToPath }                                 from "url";
import { mkdir, writeFile }                              from "fs/promises";
import { execSync }                                      from "child_process";
import { userInfo }                                      from "os";

import { buildScaffoldGuide } from "../scaffoldGuide.js";
import { resolveIntegraHome, assertIntegraHomeExists } from "@int3gra/manager/home";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE  = resolve(__dirname, "../../templates/integration");

const VALID_ID = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

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
export function resolvePublicHost() {
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

/**
 * Resolves pathArg to an absolute path against invokedFrom (NOT a
 * basename() of the raw string — see the module docstring for why), takes
 * its last segment as the candidate id, and validates that id against a
 * safe-token rule: starts with a letter, then only letters/digits/
 * hyphens/underscores, case-insensitive. Throws on an invalid id.
 *
 * Pure given its inputs — no filesystem access, no home/registry
 * involvement — so it's directly unit-testable without any fixture setup.
 *
 * @param {string} pathArg      the raw <path> argument as typed
 * @param {string} invokedFrom  the directory the command was invoked from
 * @returns {{ id: string, resolvedPath: string }}
 */
export function resolveAndValidateId(pathArg, invokedFrom) {
  // Resolve pathArg to an absolute path against invokedFrom before taking
  // its last segment — NOT a basename() of the raw string. A relative
  // argument like "." or "../foo" must be resolved the way a real path
  // would be (walking ".."/"." segments, normalising) before its last
  // segment means anything; an already-absolute pathArg passes through
  // resolve() unchanged, so this one call handles both cases. Naively
  // basename()-ing the raw string previously let `integra init .` produce
  // the literal, nonsensical id "." instead of the current directory's
  // real name.
  const resolvedPath = resolve(invokedFrom, pathArg);
  const id            = basename(resolvedPath);

  // The id becomes a directory name (.integrations/<id>/live), a JSON
  // filename (<id>.registry.json), and a PM2 process name — so it must be
  // a safe, unambiguous token, not just "non-empty". Rule, in the spirit
  // of a JS variable name or CSS class: starts with a letter, followed by
  // letters/digits/hyphens/underscores, case-insensitive. This rejects
  // "." and ".." (resolve()'s normalisation means those never survive to
  // this point as literal segments anyway, but the root directory "/"
  // resolving to an empty basename is exactly the case this guards), "~",
  // leading digits, and anything containing "/", spaces, or other symbols
  // — while still accepting every id already used throughout this
  // codebase (e.g. "my-sn-jira", "sn-get-incident").
  if (!VALID_ID.test(id)) {
    throw new Error(
      `"${id || resolvedPath}" is not a valid integration id.\n` +
      `An id must start with a letter and contain only letters, digits, ` +
      `hyphens, and underscores (e.g. "my-sn-jira", "sn_get_incident").`
    );
  }

  return { id, resolvedPath };
}

/**
 * Throws if `id` is already taken, either as a live directory or as a
 * registered entry. checkout/publish already guarantee an entry's id can
 * never drift from its filename once registered, so checking either
 * location alone would be sufficient in practice — both are checked
 * anyway, for peace of mind, at the cost of one extra existsSync call.
 *
 * @param {string} home  integra's resolved fixed home
 * @param {string} id
 * @returns {{ integrationsRoot: string, liveDir: string, registryDir: string, entryPath: string }}
 *   the resolved paths the caller will need next, computed once here
 */
export function checkNoCollision(home, id) {
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

  return { integrationsRoot, liveDir, registryDir, entryPath };
}

/**
 * Scaffolds an empty integration into `liveDir` from the standard
 * template — connections/, maps/, processes/, resolvers/, an empty
 * integra.json (entry: null), and .env.example. `liveDir` must not
 * already exist (checkNoCollision should have been called first).
 */
export function scaffoldEmpty(liveDir, id) {
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
}

/**
 * git init + add + commit inside `liveDir` — safe immediately, since
 * there is never a real .env at this point (an empty scaffold has none;
 * a forked-from-branch tree got its credentials from the SOURCE branch's
 * own commit, not from anything uncommitted). live/ never gets a remote
 * of its own — it IS the repository. Developers clone it directly and
 * push branches back into it.
 *
 * A failed commit (e.g. git user.name/user.email not configured on this
 * host) is not fatal — the repo still exists and is clonable; the
 * developer's first commit from their own clone will succeed once they
 * configure their own identity.
 */
export function gitInitCommit(liveDir, commitMessage) {
  execSync("git init", { cwd: liveDir, stdio: "ignore" });
  execSync("git add -A", { cwd: liveDir, stdio: "ignore" });
  try {
    execSync(`git commit -m "${commitMessage}"`, { cwd: liveDir, stdio: "ignore" });
  } catch {
    // See docstring — not fatal.
  }
}

/**
 * Registers `id` in registry.d/, delivers the guide to `resolvedPath`,
 * and prints the standard success report. Identical for both init and
 * duplicate — the only difference between them is how liveDir's content
 * was produced, which has already happened by the time this runs.
 *
 * @param {string} summaryVerb  past-tense verb for the console report,
 *   e.g. "created" or "duplicated" — the one cosmetic difference between
 *   init's and duplicate's otherwise identical report.
 */
export async function registerAndDeliverGuide({ id, liveDir, registryDir, entryPath, resolvedPath, summaryVerb = "created" }) {
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

  const guideTarget = resolvedPath;
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

  console.log(`\n✓ Integration "${id}" ${summaryVerb}.`);
  console.log(`  Live tree:  ${liveDir}`);
  console.log(`  Registered: registry.d/${id}.registry.json`);
  console.log(`  Guide:      ${resolve(guideTarget, `${id}.guide.md`)}`);
  if (!host) {
    console.warn(`\n  ⚠  Could not auto-detect this host's address — the guide's clone command is a placeholder.`);
  }
  console.log(`\nOpen the guide for next steps — including how to clone and start developing.\n`);
}

export async function init([pathArg]) {
  if (!pathArg) {
    throw new Error("Usage: integra init <path>");
  }

  // Two distinct roots, deliberately kept separate:
  //   home        — integra's one fixed home, /opt/integra (see
  //                  @int3gra/manager's home.js). registry.d/ and
  //                  .integrations/<id>/live always live here,
  //                  regardless of where `integra init` is invoked from —
  //                  the same rule every other manager/--branch operation
  //                  already follows. Must already exist — `integra setup`
  //                  (as root) is the one and only thing that creates it.
  //   invokedFrom  — the actual directory the developer ran the command
  //                  from. Only the generated guide lands relative to
  //                  this (via pathArg) — integra has no opinion on where
  //                  a developer's own clone ends up, and the guide is
  //                  not part of the registered, managed state.
  assertIntegraHomeExists();
  const home        = resolveIntegraHome();
  const invokedFrom = process.cwd();

  const { id, resolvedPath } = resolveAndValidateId(pathArg, invokedFrom);
  const { liveDir, registryDir, entryPath } = checkNoCollision(home, id);

  scaffoldEmpty(liveDir, id);
  gitInitCommit(liveDir, "Initial scaffold");

  await registerAndDeliverGuide({ id, liveDir, registryDir, entryPath, resolvedPath, summaryVerb: "created" });
}
