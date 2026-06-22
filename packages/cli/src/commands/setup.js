// Copyright (c) 2026 Claudius Tiberiu Iacob — Licensed under BSL 1.1. See LICENSE for details.
/**
 * @int3gra/cli - commands/setup.js
 *
 * `integra setup`
 *
 * One-off provisioning command. Creates integra's fixed home (/opt/integra,
 * see @int3gra/manager's home.js) and writes its initial config.json.
 *
 * Nothing else in integra creates this path automatically anymore — every
 * command that needs it (manager runtime/registry commands, `init`,
 * `--branch`) calls assertIntegraHomeExists() first and fails hard,
 * pointing back at this command, if it's missing. This is deliberate:
 * a fixed system path under /opt needs an explicit, human-run, root
 * provisioning step — there is no safe automatic moment (npm postinstall,
 * first command invocation, etc.) to create it on someone's behalf.
 *
 * Run by hand, once, per host — typically as root or via sudo, since /opt
 * requires elevated privileges to write into. Whoever runs it owns the
 * resulting directory; mode 0777 is intentional (see home.js and the
 * project's own reasoning) — this application's safety does not come
 * from filesystem permissions, so there is nothing gained by being
 * stingier here at the cost of friction for whichever user later needs
 * to write into it.
 *
 * Idempotent the same way the old npm postinstall hook was: never
 * overwrites an existing config.json, including on repeated runs.
 */

import { mkdir, chmod } from "fs/promises";

export async function setup() {
  const { resolveIntegraHome, readHomeConfig, writeHomeConfig } = await import("@int3gra/manager/home");
  const home = resolveIntegraHome();

  try {
    await mkdir(home, { recursive: true });
    // mkdir's mode option is masked by the process umask (POSIX mkdir(2)
    // behaviour) — confirmed directly: 0o777 there silently becomes 0o755
    // under the common 0022 umask. An explicit chmod afterward bypasses
    // the umask entirely, which is the only reliable way to guarantee the
    // intended 0o777 regardless of whatever umask the invoking shell or
    // sudo session happens to have.
    await chmod(home, 0o777);
  } catch (err) {
    if (err.code === "EACCES" || err.code === "EPERM") {
      throw new Error(
        `Could not create ${home}: permission denied.\n` +
        `This path requires elevated privileges. Run 'integra setup' as root (e.g. via sudo).`
      );
    }
    throw err;
  }

  const existing = await readHomeConfig(home);
  if (existing !== null) {
    console.log(`✓ Already set up: ${home}`);
    console.log(`  config.json already exists — left untouched.`);
    return;
  }

  await writeHomeConfig({}, home);
  console.log(`✓ Initialised integra home: ${home}`);
  console.log(`  Wrote: ${home}/config.json`);
}
