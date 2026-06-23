# @int3gra/manager

Integration supervisor for int3gra. Spawns, monitors, and manages integration instances via PM2.

## Installation

```bash
npm install -g @int3gra/engine @int3gra/cli @int3gra/manager
```

PM2 must also be installed globally:

```bash
npm install -g pm2
```

Then, once per host, as root:

```bash
sudo integra setup
```

This provisions `/opt/integra` — integra's one fixed home, where
`registry.d/` and `.integrations/` live. Every command below checks for
it and fails immediately, with a clear message, if it's missing. There is
no need to run any command from a particular directory — the home is
resolved automatically regardless of where you invoke from.

## Runtime commands

```bash
integra-manager start                  # Start all enabled integrations
integra-manager stop <id>              # Stop an integration
integra-manager restart <id>           # Restart an integration
integra-manager status                 # Show status, lifecycle, env, uptime
integra-manager logs <id>              # Tail integration logs
integra-manager enable <id>            # Enable an integration in the registry
integra-manager disable <id>           # Stop and disable an integration
```

## Registry commands

The registry is a directory of fragments — `registry.d/<id>.registry.json`,
one file per integration — never a single shared file, and never hand-edited
directly. All changes go through these subcommands, which lock the entry for
the duration of the edit:

```bash
integra-manager checkout <id>             # lock <id>, get an editable staged copy
integra-manager publish <id>              # validate, publish, release the lock
integra-manager uncheckout <id>           # give up without publishing
integra-manager delete <id> [--purge]     # remove an entry (--purge also deletes its folder)
integra-manager duplicate <id> <new-id>   # clone an entry + its integration folder
```

There is no separate "create" command — `integra init <path>` (run by the
developer, from `@int3gra/cli`) is the one creation path; it scaffolds the
integration and registers it in one step.

## Deploy commands

Each integration's working tree, `.integrations/<id>/live`, is itself a
git repository. Developers push branches into it directly; these commands
promote or roll back what's actually running:

```bash
integra-manager deploy <id> --branch <name>   # fast-forward live/ to a branch, restart
integra-manager undeploy <id>                 # roll back to the previous deploy
integra-manager deploy-history <id> [-n <count>]  # list recent deploys
```

## Lifecycles

| Lifecycle | How it runs |
|---|---|
| *(absent)* | Run-once — starts, executes entry process, exits |
| `scheduled` | TrafficController fires entry on cron schedule |
| `listener` | Long-lived Fastify HTTP server, `autorestart: true` |

Lifecycle is declared in each integration's `integra.json`. A `schedule`
field on the registry entry makes an integration scheduled.

For the full picture — locking semantics, the git-backed deploy model,
and `--branch` — see the [root README](https://github.com/ciacob/integra#readme).

## Links

- [Documentation & full README](https://github.com/ciacob/integra#readme)
- [GitHub](https://github.com/ciacob/integra)
- [npm — @int3gra/engine](https://www.npmjs.com/package/@int3gra/engine)
- [npm — @int3gra/cli](https://www.npmjs.com/package/@int3gra/cli)

## License

BSL 1.1 — free to use commercially as a component of your own products. May not be resold or repackaged as a standalone product. Converts to Apache 2.0 on 2030/12/31. See LICENSE and NOTICE for details.
