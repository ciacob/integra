// Copyright (c) 2026 Claudius Tiberiu Iacob — Licensed under BSL 1.1. See LICENSE for details.
/**
 * @int3gra/cli - commands/duplicate.js
 *
 * `integra duplicate <path> --id <source-id> --branch <name>`
 *
 * Creates a brand new, fully independent integration, seeded from an
 * existing integration's already-pushed branch — same id-resolution,
 * collision-checking, git-init, registration, and guide-delivery sequence
 * as `integra init` (see commands/init.js, which this reuses directly),
 * with exactly one difference: instead of an empty template, the new
 * live/ is populated from `--id`'s `--branch`, via @int3gra/manager's
 * archiveBranchInto — the same git-archive-into-a-folder primitive
 * --branch (on run/validate/ping/test) uses internally, called directly
 * against a permanent target rather than the ephemeral, swept
 * .integrations/<id>/tests/ area those commands use.
 *
 * The result is a deliberate fork, not a clone: the new live/ gets its
 * OWN git history, starting from one fresh commit of the forked content.
 * There is no shared ancestry with the source, and no way to fast-forward
 * changes between the two afterward — these are two independent
 * integrations from this point on, which is the whole point. If you need
 * the SAME integration running on two credential sets simultaneously
 * with a shared lineage, this is deliberately not that; see the root
 * README's "Env files" section for why `duplicate` (the simultaneous-
 * credentials case) and a true fork (this command) are different needs.
 *
 * The forked integra.json keeps the source branch's real field values
 * (notably `entry` — the actual entry process being forked is part of
 * what's being duplicated, so resetting it to null would silently break
 * the very thing this command exists to copy) — only `id` is rewritten,
 * and `created` is regenerated, since this is a genuine new creation
 * moment, distinct from whenever the source branch happened to be
 * authored.
 *
 * The fork is deliberately NOT wired to connect anywhere out of the box.
 * A committed `.env` is renamed to `env.default` (not deleted — the
 * credentials are still right there, just under a name the engine
 * doesn't recognise as a default), and a fresh `.env.example` replaces
 * whatever the source branch's own contained. Connecting the fork to
 * real systems should be a developer's explicit decision — `cp
 * env.default .env`, or write a new one entirely — never an accident of
 * having forked something that already worked. Any OTHER committed env
 * file (`.env.dev`, `.env.staging`, etc.) is left exactly as committed —
 * only the bare `.env` gets this treatment.
 */

import { existsSync, writeFileSync, renameSync } from "fs";
import { readFile } from "fs/promises";
import { resolve } from "path";

import { resolveIntegraHome, assertIntegraHomeExists } from "@int3gra/manager/home";
import { readEntry } from "@int3gra/manager/registryStorage";
import { archiveBranchInto } from "@int3gra/manager/archive";
import { parseArgs } from "../args.js";

import {
  resolveAndValidateId,
  checkNoCollision,
  gitInitCommit,
  registerAndDeliverGuide,
  writeEnvExample,
} from "./init.js";

/**
 * Forks `branch`'s tree from the source integration's live/ directly into
 * `liveDir`, then:
 *   - rewrites the copied integra.json's `id` to `newId` and regenerates
 *     `created`, keeping every other field (notably `entry`) as the
 *     source branch actually had it;
 *   - if a committed `.env` came along, renames it to `env.default` —
 *     deliberately not a name the engine recognises as a default env
 *     file, so a freshly forked integration cannot connect anywhere by
 *     accident. The credentials aren't deleted (they're still right
 *     there, under a different name, same as live/'s own .env always
 *     is — no new exposure beyond what already existed), but using them
 *     again requires a deliberate `cp env.default .env` first. This is
 *     `.env` specifically — any other committed env file (`.env.dev`,
 *     `.env.staging`, etc.) is left exactly as committed, untouched;
 *   - writes a fresh `.env.example`, overwriting whatever the source
 *     branch's own happened to contain — the new integration's
 *     ".env.example" should describe ITS OWN expected variables once a
 *     developer fills it in, not silently inherit the source's.
 */
async function scaffoldFromBranch(sourceLiveDir, branch, liveDir, newId) {
  await archiveBranchInto(sourceLiveDir, branch, liveDir);

  const manifestPath = resolve(liveDir, "integra.json");
  const raw          = await readFile(manifestPath, "utf-8");
  const manifest      = JSON.parse(raw);

  manifest.id      = newId;
  manifest.created = new Date().toISOString();

  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

  const envPath = resolve(liveDir, ".env");
  if (existsSync(envPath)) {
    renameSync(envPath, resolve(liveDir, "env.default"));
  }

  writeEnvExample(liveDir);
}

export async function duplicate(argv) {
  const { flags, positional } = parseArgs(argv);
  const pathArg = positional[0];

  if (!pathArg) {
    throw new Error("Usage: integra duplicate <path> --id <source-id> --branch <name>");
  }
  if (!flags.id) {
    throw new Error(
      `Usage requires --id <source-integration-id>.\n` +
      `--id names the integration to fork FROM — <path>'s last segment ` +
      `becomes the NEW integration's id, same as 'integra init'.`
    );
  }
  if (!flags.branch) {
    throw new Error(
      `Usage requires --branch <name>.\n` +
      `--branch must already be pushed into "${flags.id}"'s live/ — there ` +
      `is no mode that forks from live/'s current state directly, or from ` +
      `anything not yet pushed.`
    );
  }

  assertIntegraHomeExists();
  const home        = resolveIntegraHome();
  const invokedFrom = process.cwd();

  const sourceEntry = await readEntry(home, flags.id);
  if (!sourceEntry) {
    throw new Error(`"${flags.id}" is not registered in registry.d/ — nothing to duplicate from.`);
  }
  const sourceLiveDir = resolve(home, sourceEntry.path);

  const { id, resolvedPath } = resolveAndValidateId(pathArg, invokedFrom);
  if (id === flags.id) {
    throw new Error(`The new integration's id ("${id}") must differ from the source's ("${flags.id}").`);
  }
  const { liveDir, registryDir, entryPath } = checkNoCollision(home, id);

  await scaffoldFromBranch(sourceLiveDir, flags.branch, liveDir, id);
  gitInitCommit(liveDir, `Forked from "${flags.id}" @ ${flags.branch}`);

  await registerAndDeliverGuide({
    id, liveDir, registryDir, entryPath, resolvedPath,
    summaryVerb: `duplicated from "${flags.id}" @ "${flags.branch}"`,
  });
}
