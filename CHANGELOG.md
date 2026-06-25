# Changelog

## @int3gra/manager — fixed: missing `ajv` dependency on a fresh, standalone install

**What changed**

`@int3gra/manager` imports `ajv` directly (`registryStorage.js`, for
validating `registry-entry.schema.json`) but never declared it in its own
`package.json`. Inside this monorepo, that went unnoticed: npm hoists
`@int3gra/engine`'s own, separate declaration of `ajv` into the shared
`node_modules` every workspace package can see, which was enough to
satisfy the import locally. It broke on a genuine standalone install
(`npm install -g @int3gra/manager`), with `ERR_MODULE_NOT_FOUND: ajv` —
there is no shared tree to fall back on outside the workspace.

`ajv` is now declared directly in `@int3gra/manager`'s own dependencies.

**Why**

A package's own `package.json` is the only thing a real install — global
or otherwise — has to go on. Anything imported but undeclared works by
accident, for as long as some other, unrelated dependency happens to
pull it in anyway; that accident doesn't survive the package being
installed on its own.

A new test (`packages/manager/test/packageDependencies.test.js`) now
scans every package's `src/` for third-party imports and checks each one
against that same package's own declared dependencies, on every test
run — confirmed directly to catch this exact bug by reverting the fix
and re-running it before restoring.

**What you need to do**

Reinstall: `npm install -g @int3gra/engine @int3gra/cli @int3gra/manager`.

---

## @int3gra/cli — `live/`'s default branch is always named `live`, and protected by a pre-receive hook

**What changed**

Every `integra init` and `integra duplicate` now names `live/`'s initial
branch `live` explicitly (`git init --initial-branch=live`), rather than
leaving it to whatever the host's git defaults to (`master`, `main`, or
anything else, depending on git version and global config). A
`pre-receive` hook is installed alongside it, rejecting any direct push
to that branch with a clear message pointing at the real workflow — push
a feature branch, then ask for a deploy.

**Why**

Nothing in this codebase's deploy/undeploy/archive logic ever assumed a
particular branch name — every one of those already takes a branch name
as an explicit parameter. So the only thing an inconsistent, host-dependent
default ever bought was confusion: one host's "the branch you must never
push to" might be `master`, another's `main`, with no way to tell which
without checking. Naming it the same thing everywhere gives every
developer one unambiguous signal, regardless of host.

The hook is a deterrent, not a security boundary — anyone with filesystem
access to `live/` can edit or remove it, and that's fine: this guards
against the common, accidental case (`git push origin live` typed from
habit), not a determined actor. `integra-manager deploy`'s own
fast-forward merge happens locally inside `live/`, never through
`receive-pack`, so it is correctly unaffected by this hook either way.

**What you need to do**

Nothing for new integrations. For integrations created before this
change, the host's prior default branch name (whatever it happened to
be) is unaffected — this only applies going forward, to new `init`/
`duplicate` calls. There is no retrofit; renaming an existing `live/`'s
branch after the fact is a manual git operation outside this tool's
scope, on purpose — it is not something `deploy`/`undeploy` need to
care about either way.

---

## @int3gra/cli — `integra duplicate`: fork a new integration from another's pushed branch

**What changed**

`integra-manager duplicate <id> <new-id>` is gone — removed outright, not
deprecated. In its place: `integra duplicate <path> --id <source-id>
--branch <name>`, a CLI command (not a manager command), which forks a
brand new, fully independent integration, seeded from another
integration's already-pushed branch.

It runs the exact same sequence `integra init` does — id resolution and
validation from `<path>`, collision checks, `git init` and an initial
commit, registration in `registry.d/`, guide delivery — with exactly one
difference: instead of an empty template, the new `live/` is populated
from `--id`'s `--branch`, via the same `git archive` mechanism `--branch`
(on `run`/`validate`/`ping`/`test`) already uses internally to materialize
a branch's content, called directly against a permanent destination this
time rather than the ephemeral, swept `.integrations/<id>/tests/` area
those commands use.

The result is a genuine fork, not a clone: the new `live/` gets its own,
brand new git history — one fresh commit of the forked content — with no
shared ancestry with the source. There is no way to fast-forward changes
between the two afterward; they are two independent integrations from
that point on. The forked `integra.json` keeps the source branch's real
field values (notably `entry`) — only `id` is rewritten, and `created` is
regenerated.

The fork is deliberately not wired to connect anywhere out of the box. A
committed `.env` is renamed to `env.default` — not deleted, just no
longer a name the engine recognises as a default env file — and a fresh
`.env.example` replaces whatever the source branch's own contained.
Connecting the fork to real systems is then a deliberate choice (`cp
env.default .env`, or write new credentials entirely), never an accident
of having forked something that already worked. Any other committed env
file (`.env.dev`, `.env.staging`, etc.) is left exactly as committed —
only the bare `.env` gets this treatment.

**Why**

The old `integra-manager duplicate` cloned a registry entry and copied a
folder, server-side, with no git involved — a half-thought feature that
predated `--branch`/`git archive` entirely. It's now a special case of
`init` instead of a separate, parallel mechanism: same validation, same
collision handling, same guide, with the content source swapped. This
also moves it to the package where `init` (and the rest of the
developer-facing command surface) already lives, rather than the
operator-facing `@int3gra/manager`.

**What you need to do**

Replace any use of `integra-manager duplicate <id> <new-id>` with
`integra duplicate <path> --id <source-id> --branch <name>` — push the
state you want forked as a branch first, since unlike the old command,
this one forks a specific, named commit, never whatever `live/` happens
to currently contain.

---

## @int3gra/cli — `--id` and `--branch` are now mandatory on `run`/`validate`/`ping`/`test`

**What changed**

`run`, `validate`, `ping`, and `test` now require both `--id <integration-id>`
and `--branch <name>`. There is no longer a mode that operates on `live/`
directly, or on whatever happens to be checked out in the current
directory — every invocation must name a specific integration and a
specific, already-pushed branch.

`--env <file>` (where applicable) now resolves against that branch's own
root — the same ephemeral archive `--id`/`--branch` resolve to — rather
than against the directory the command was invoked from. `<file>` must be
a plain relative filename: no leading `/`, no `..` segment. The env file
must be **committed on the branch**, exactly like `.env` itself (see the
`.env`-must-be-committed entry above) — there is no other way it could
exist in the resolved archive at all.

`integra setup`'s and `integra init`'s own behaviour is unaffected — this
only touches the four commands that previously had a "no `--branch`,
operate on cwd" fallback.

**Why**

What gets verified should always be a named, traceable commit, never an
anonymous pile of whatever's on disk. Before this change, running these
commands without `--branch` silently meant "whatever code happens to be
sitting in this directory right now" — which, for a developer SSHed into
the server, was usually either `live/` itself (no audit trail of what was
actually tested) or their own local, possibly-uncommitted clone (no
audit trail, and not guaranteed to exist anywhere ever again). Requiring
`--branch` everywhere closes that gap: every verification is now
traceable to a specific SHA, the same standard `deploy`/`undeploy` already
held the *promotion* step to.

`--id` is the natural completion of the same idea — once `--branch` no
longer lets a command infer "the current integration" from a local
`integra.json`, there is nothing left for that inference to be useful for.
Naming the integration explicitly also removes a whole class of
wrong-directory, cryptic-error mistakes (a stale shell, a typo'd `cd`, a
copy-pasted command from a different terminal tab).

**What you need to do**

Add `--id <integration-id> --branch <name>` to every existing script,
alias, or muscle-memory invocation of `run`/`validate`/`ping`/`test`.
There is no equivalent for the removed "operate on `live/` directly"
mode — push your work as a branch first, the same way `--branch` already
worked. If you relied on `--env <file>` resolving relative to your own
working directory rather than the branch's root, move or commit that
file onto the branch instead.

---

## @int3gra/manager — `.env` must be committed; PM2-managed processes always use `.env`

**What changed**

`.env` holds an integration's own credentials, not a personal developer
secret, and it must now be committed — the same as any other file in
`live/`. This corrects earlier documentation (root README, the generated
scaffold guide) that said the opposite. There was never a mechanism that
got `.env` onto the host any other way: nothing creates, copies, or syncs
it outside of git. Committing it and pushing it like any other change is
not a new allowance — it is, and always was, the only way it actually
gets there.

The registry entry's `env_file` field has been removed entirely (it's no
longer accepted by `registry-entry.schema.json` — an entry containing it
now fails validation outright), and `integra-manager start` no longer
takes an `--env` flag. A PM2-managed (scheduled or listener) integration
always runs on its own `.env`, deliberately, with no override. `status`'s
`env` column is gone too — it could only ever show one value now, so it
no longer carries information.

`integra run`, `test`, `validate`, and `ping` are unaffected — `--env`
still works there exactly as before, for ad-hoc, per-invocation use.

**Why**

`env_file` as a persisted, per-integration setting was solving a problem
that doesn't need solving this way: if a long-running process genuinely
needs different default credentials, that's a different integration
(`duplicate` it), not a configurable filename on the same one. Collapsing
this to "PM2-managed processes always use `.env`" removes a knob that
added complexity without a real use case behind it, and a `status` column
that could never say anything but the same constant.

**What you need to do**

To switch which credentials a PM2-managed integration uses, replace the
file before starting, deliberately:

```bash
cp .env .env.prod      # keep the current one around
cp -f .env.dev .env    # promote the one you want active
integra-manager start
```

To run two credential sets *simultaneously*, `duplicate` the integration
— each copy gets its own `live/`, and therefore its own `.env`.

If any registry entry on disk still has an `env_file` field (from before
this change), remove it — `checkout`, edit the staged file, `publish`.
Entries with it will fail validation on load otherwise.

---

## @int3gra/manager & @int3gra/cli — `/opt/integra`, manual setup, no more postinstall

**What changed**

Integra's home is now a literal constant: `/opt/integra`. Not resolved
per-platform, not configurable, not relocatable via any environment
variable. The previous `env-paths`-based resolution (XDG on Linux,
Application Support on macOS, `%LOCALAPPDATA%` on Windows) is gone —
integra is a Linux server tool, and there was no honest cross-platform
story worth maintaining for a fixed system path nobody actually uses on
Windows or macOS.

`@int3gra/manager`'s `postinstall` npm lifecycle script has been removed
entirely, along with its `env-paths` dependency. **Nothing creates
`/opt/integra` automatically anymore.** A new command, `integra setup`,
must be run by hand, once, per host — as root or via `sudo`, since `/opt`
requires elevated privileges to write into:

```bash
sudo integra setup
```

Every command that touches `registry.d/` or `.integrations/` —
`integra-manager`'s runtime and registry subcommands, `integra init`,
and `--branch` on `run`/`validate`/`ping`/`test` — now checks that
`/opt/integra` exists *before* doing anything else, and fails immediately
with a clear message (`App was not fully setup, run \`integra setup\` as
sudo.`) if it doesn't. There is no silent fallback and no lazy creation
on first use, unlike before.

`integra setup` creates `/opt/integra` with mode `0777`, owned by whoever
ran it. This is a deliberate, explicit choice — see the README's "Integra
home" section for the reasoning — not a default that happened to come out
permissive. The previous "dedicated service user" installation
recommendation no longer applies, since ownership now simply follows
whoever runs `setup`.

**Why no automatic creation**

A fixed path under `/opt` is a system-level resource, and creating it
automatically as a side effect of `npm install` (the old `postinstall`
behaviour) or of any individual command's first invocation both have the
same problem: neither is a moment where it's safe to assume the right
permissions, the right user, or genuine operator intent. An explicit,
human-run, root command is the only honest way to provision a path like
this — `npm` lifecycle scripts writing unconditionally to the filesystem
is exactly the pattern that has burned the ecosystem before.

**Why no relocation command, still**

Unchanged from the previous entry below: the home is fixed, permanently,
for the same reasons. Symlink `/opt/integra` to wherever the real storage
should live, once, before `integra setup` is ever run on that host, if
the default location doesn't suit your disk layout.

**What you need to do**

For any host that already has a `registry.d/`/`.integrations/` tree at
the old `env-paths`-resolved location (e.g. `~/.local/share/integra`):
move that tree to `/opt/integra`, or symlink `/opt/integra` to where it
already lives — then run `sudo integra setup` to ensure `config.json`
exists (it's a no-op if the directory you moved/symlinked already has
one). For fresh hosts: `npm install`, then `sudo integra setup`, in that
order, before running anything else.

See the README's "Integra home" section for the full model.

---

## @int3gra/manager — Fixed integra home (replaces cwd-based --branch discovery)

**What changed**

`registry.d/` and `.integrations/` now live at one fixed, platform-aware
location per host — resolved via `env-paths` — rather than being found by
searching upward from the current directory. `@int3gra/manager`'s
`postinstall` script sets this up automatically on a fresh install.

This means `--branch` (on `run`/`validate`/`ping`/`test`) no longer
requires being run from inside or beneath any particular directory — it
can be invoked from anywhere. Previously, `--branch` walked upward from
the current working directory looking for the nearest ancestor containing
`registry.d/`, which meant it only worked if you happened to be standing
inside (or beneath) that tree.

**Why no relocation command**

The home is fixed at install time, permanently. There is deliberately no
`init-home`-style command to move it later — this avoids an entire
category of problems a movable home would otherwise need to handle: no
migration story, no question of whether a running integration is still
pointed at an old location. If the underlying storage needs to live on a
different disk or mount, symlink the resolved home path to it, once,
before integra is ever invoked on that host.

**What you need to do**

Nothing, for new installs — `postinstall` sets the home up automatically.
For hosts that already have a `registry.d/`/`.integrations/` tree from
before this change: move that tree to the new fixed location (shown by
running any integra command, or check the README's "Integra home" table
for your platform's default), or symlink the new location to where your
existing tree already lives.

See the README's new "Integra home" section for the full model, including
the recommended dedicated-service-user deployment pattern.

---

## @int3gra/cli & @int3gra/manager — Git-backed deploy

**What changed**

`integra init <path>` now scaffolds the integration's real working tree
into `.integrations/<id>/live` instead of at `<path>` itself, and turns
`live/` into a git repository immediately. `<path>` now receives only a
generated guide (`<id>.guide.md`) explaining how to clone it. This only
affects newly-`init`'d integrations — existing ones, scaffolded before this
change, are completely unaffected and require no migration. If you want an
existing integration to gain a `live/` tree of its own, that's a manual,
deliberate restructuring step, not something this release does for you.

New manager commands:

```bash
integra-manager deploy <id> --branch <name>
integra-manager undeploy <id>
integra-manager deploy-history <id> [-n <count>]
```

**`live/` has no remote and never fetches.** It IS the repository.
Developers clone it directly (which, by git's own default behaviour,
gives their clone an `origin` pointing back at `live/` automatically) and
push branches directly into it. `deploy` performs a plain local
`git merge --ff-only` against an already-pushed branch — there is no
fetch step anywhere in this model.

`checkout` now refuses on an id that isn't already registered, rather than
silently seeding a template for it. The one and only creation path is now
`integra init` — this closes a gap where a typo'd id during checkout could
previously create a ghost registry entry instead of producing a clear error.

New CLI flag, on `run`/`validate`/`ping`/`test`:

```bash
integra test     --branch <name>
integra validate --branch <name>
integra run      <process-id> --branch <name> --env <file>
integra ping      --branch <name> --env <file>
```

`--env` is required on `run` and `ping` (which use real credentials), but
not on `test` or `validate` (neither reads `process.env` at all). A
branch must be pushed directly into `live/` before any of these commands
can see it — see the README's "Git-backed deploy" section for the full
model: fast-forward-only deploys, tag-based (not `HEAD~1`-based) rollback,
and the ephemeral content-addressed archives `--branch` uses.

**Restart behaviour, explicitly not yet changed**

`deploy` and `undeploy` restart via the existing `restartOne()` — the same
restart `integra-manager restart` already performs. This is a hard
kill-and-respawn, with no draining of in-flight scheduled runs or inbound
HTTP requests. A graceful, per-lifecycle restart (pause-drain-swap for
scheduled, close-drain-swap for listener) is planned as a follow-up and is
deliberately out of scope for this release — building the git/tag plumbing
against an already-correct, simple restart path first, then substituting a
better restart underneath later, was judged less risky than doing both at
once.

**Correction to an earlier draft of this feature**

An earlier iteration of this work assumed `live/` would have its own
remote that `--branch`/`deploy` would `git fetch` from, and shipped a
`set-remote` command to configure it. That model was wrong: `live/` is
the one repository — developers clone it directly and push branches
*into* it, the same way any shared git repo works. `set-remote` has been
removed; there is no remote to configure.

---

## @int3gra/manager 2.0.0 — Breaking: `registry.json` → `registry.d/`

**What changed**

`registry.json` (a single file holding all integration entries) has been
replaced by `registry.d/` (a directory holding one `<id>.registry.json` file
per integration). This closes a real concurrency gap: the old single-file
format had no protection against two engineers editing different
integrations on the same host racing on the same file, and no way to grant
"Alice may change her integration's schedule" without also granting her
write access to everyone else's.

**Why no automatic migration**

`@int3gra/manager` has been published for under two weeks at the time of
this change. Rather than carry migration tooling for a format that had
very little time to accumulate real deployments, this is a clean break,
documented here.

**What you need to do**

If you have an existing `registry.json`, convert it manually — split each
entry in its `integrations` array into its own file:

```bash
# Before: registry.json
# {
#   "integrations": [
#     { "id": "my-integration", "path": "./my-integration", ... }
#   ]
# }

mkdir registry.d
# For each entry, create registry.d/<id>.registry.json with just that
# entry's fields (no "integrations" wrapper, no array):
cat > registry.d/my-integration.registry.json << 'EOF'
{
  "id": "my-integration",
  "path": "./my-integration",
  "enabled": true
}
EOF

rm registry.json
```

After that, `integra-manager start`, `status`, `stop`, `restart`, `logs`,
`enable`, and `disable` all work exactly as before — none of their
behaviour changed, only where the data lives.

**New commands**

Going forward, don't hand-edit files inside `registry.d/`. Use:

```bash
integra-manager checkout <id>
integra-manager publish <id>
integra-manager uncheckout <id>
integra-manager delete <id> [--purge]
integra-manager duplicate <id> <new-id>
```

See the README's "Manager workflow" section for the full model.
