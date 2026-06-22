// Copyright (c) 2026 Claudius Tiberiu Iacob — Licensed under BSL 1.1. See LICENSE for details.
/**
 * @int3gra/cli - scaffoldGuide.js
 *
 * Builds the Markdown guide delivered to the developer's originally
 * requested path after `integra init` scaffolds the real working tree into
 * .integrations/<id>/live and turns it into a git repository.
 *
 * Kept separate from init.js so the guide's content can be unit-tested
 * without touching the filesystem.
 */

/**
 * @param {object} params
 * @param {string} params.id          the integration id
 * @param {string} params.host        resolved public IP/hostname, or null if lookup failed
 * @param {string} params.liveDir     absolute path to .integrations/<id>/live on this host
 * @param {string} params.osUser      the OS user owning the live/ repo (for the clone command)
 * @returns {string} Markdown content
 */
export function buildScaffoldGuide({ id, host, liveDir, osUser }) {
  const cloneTarget = host
    ? `${osUser}@${host}:${liveDir}`
    : null;

  const cloneSection = cloneTarget
    ? [
        "## Clone this integration",
        "",
        "```bash",
        `git clone ${cloneTarget} ${id}`,
        "```",
        "",
        "Replace the remote user/host above with whatever's appropriate for your network",
        "setup (VPN, jump host, etc.) if this automatic guess doesn't work as-is.",
      ].join("\n")
    : [
        "## Clone this integration",
        "",
        "We couldn't automatically determine this host's address. Clone it manually:",
        "",
        "```bash",
        `git clone <user>@<this-host>:${liveDir} ${id}`,
        "```",
      ].join("\n");

  return [
    `# ${id}`,
    "",
    `This integration's real working tree lives at \`${liveDir}\` on this host —`,
    "that's what `integra-manager deploy` updates and what PM2 runs. It is not where",
    "you should edit files directly. It also has no remote of its own — it IS the",
    "repository. Your clone, made directly from it, already has its `origin` pointing",
    "back here, by git's own default behaviour. You push branches directly into it.",
    "",
    cloneSection,
    "",
    "**Push access:** this assumes you can already push to this host over SSH — that's",
    "an account/permissions question for whoever administers it, not something integra",
    "manages. If you can SSH in, you can push.",
    "",
    "## Dev workflow",
    "",
    "```bash",
    "cd " + id,
    "cp .env.example .env          # fill in your own credentials, never commit this file",
    "git checkout -b my-patch",
    "# ...edit connections/, maps/, processes/, resolvers/...",
    "integra validate",
    "integra test                  # mock-tested, never touches anything real",
    "integra run <process-id>      # real run, against your own .env",
    "",
    "git add -A && git commit -m \"...\"",
    "git push origin my-patch      # pushes the branch directly into live/",
    "```",
    "",
    "## Promoting your changes",
    "",
    "Pushing a branch into `live/` does **not** by itself affect the running",
    "integration — it just makes that branch exist there, alongside whatever's",
    "currently deployed. Once you're confident in it, ask whoever operates this",
    "host to run:",
    "",
    "```bash",
    `integra-manager deploy ${id} --branch my-patch`,
    "```",
    "",
    "This fast-forwards `live/`'s current branch to include yours, and restarts the",
    "integration. If your branch doesn't fast-forward cleanly, deploy refuses and",
    "leaves `live/` untouched — resolve the conflict in your own clone and push again.",
    "",
    "## Trying a branch before deploying",
    "",
    "`run`, `validate`, `ping`, and `test` all accept `--branch <name>` to try out a",
    "specific branch — already pushed into `live/` — without touching the live code:",
    "",
    "```bash",
    `integra test     --branch my-patch`,
    `integra validate --branch my-patch`,
    `integra run      <process-id> --branch my-patch --env .env.dev`,
    `integra ping      --branch my-patch --env .env.dev`,
    "```",
    "",
    "**`--branch` requires `--env`** on `run` and `ping` (which actually use",
    "credentials) — but not on `test` or `validate` (which never touch real",
    "systems or read environment variables at all). This is deliberate: a patch",
    "branch can never accidentally run against production credentials via a",
    "forgotten default `.env`.",
    "",
    "**Push your branch into `live/` before trying it this way** — these commands",
    "always read the branch as it exists in `live/`'s own history, never whatever's",
    "sitting uncommitted in your own clone.",
    "",
    "**If the integration is a listener and you `run --branch`:** that starts a real,",
    "resident Fastify server that PM2 does not manage. It will keep running until you",
    "stop it yourself — it will not be cleaned up automatically.",
    "",
    "## Command reference",
    "",
    "| Command | What it does |",
    "|---|---|",
    "| `integra init <name>` | Scaffold a new integration (you just ran this) |",
    "| `integra validate` | Validate `integra.json` and all components |",
    "| `integra run <process-id>` | Execute a process for real |",
    "| `integra test` | Mock-test using fixture files — never touches anything real |",
    "| `integra ping` | Fire the `no-op` connection to check connectivity |",
    "| `integra-manager checkout <id>` | Lock and stage this integration's registry entry for editing |",
    "| `integra-manager publish <id>` | Publish staged registry changes |",
    "| `integra-manager deploy <id> --branch <name>` | Fast-forward `live/` to a branch and restart |",
    "| `integra-manager undeploy <id>` | Roll back to the previous deploy |",
    "| `integra-manager deploy-history <id>` | List recent deploys |",
    "",
    "## Gotchas",
    "",
    "- Push your branch into `live/` before you `test`/`run`/`validate`/`ping --branch`",
    "  it — these always read the branch as it exists in `live/`, never local,",
    "  uncommitted changes in your own clone.",
    "- `--branch` requires `--env` (except for `test`) — by design, to keep patch",
    "  branches away from production credentials.",
    "- `run --branch` on a listener integration leaves a process running — stop it",
    "  yourself when you're done.",
    "- Never edit files directly inside `.integrations/<id>/live` — that tree is",
    "  managed by `integra-manager deploy`/`undeploy` and will be overwritten.",
    "",
  ].join("\n");
}
