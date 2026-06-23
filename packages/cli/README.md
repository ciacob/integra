# @int3gra/cli

Developer tooling for int3gra integrations. Scaffold, validate, run, mock-test, and check connectivity — all from the command line.

## Installation

```bash
npm install -g @int3gra/engine @int3gra/cli @int3gra/manager
```

Then, once per host, as root:

```bash
sudo integra setup
```

This provisions `/opt/integra`, integra's fixed home — see the root
README's "Integra home" section. Every other command checks for it and
fails immediately, with a clear message, if it's missing.

## Commands

```bash
integra setup                                                # One-off host provisioning. Run once, as root.
integra init <path>                                          # Scaffold a new integration; <path>'s last segment becomes its id
integra validate --id <id> --branch <name>                   # Validate a pushed branch's integra.json and component files
integra run <process-id> --id <id> --branch <name>           # Execute a process for real, against a pushed branch
integra run <process-id> --id <id> --branch <name> --env <file>  # Run with a specific committed env file
integra test --id <id> --branch <name>                       # Mock-test a pushed branch using fixture files (no real calls)
integra ping --id <id> --branch <name>                       # Check connectivity via the no-op connection
integra ping --id <id> --branch <name> --con <id>[,<id>]      # Ping specific connection(s)
integra ping --id <id> --branch <name> --env <file>           # Ping with a specific committed env file
```

`--id` and `--branch` are mandatory on `run`, `validate`, `ping`, and
`test` — there is no mode that operates on `live/` directly, or on
whatever happens to be checked out locally. Push your work into the
integration's `live/` repository first, then verify the pushed branch.
See the root README's "Git-backed deploy" section for the full model.

### `integra init`

Scaffolds a new integration. The real working tree is written to
`.integrations/<id>/live` on the host (not at `<path>` itself — see the
root README's "Integra home" and "Git-backed deploy" sections), turned
into a git repository, and registered. `<path>` itself receives only a
generated guide with clone and workflow instructions:

```
.integrations/<id>/live/
  connections/   maps/   processes/   resolvers/   logs/
  test/fixtures/webhooks/   test/fixtures/responses/   test/fixtures/.disabled/
  integra.json   .env.example
```

### `integra test`

Runs a pushed branch end-to-end against fixture files — no real HTTP calls. Requires `--id` and `--branch`. Place response fixtures in `test/fixtures/responses/` and webhook fixtures in `test/fixtures/webhooks/`, committed on the branch like any other file. Use `test/fixtures/.fixture-map.json` to map outbound URLs to fixtures when you have more than one response file.

### `integra ping`

Requires `--id` and `--branch`. Fires `connections/no-op.json` (or the connections named via `--con`) from the resolved branch and reports reachability. The implementor provides a safe, side-effect-free connection to use as the connectivity check.

## Links

- [Documentation & full README](https://github.com/ciacob/integra#readme)
- [GitHub](https://github.com/ciacob/integra)
- [npm — @int3gra/engine](https://www.npmjs.com/package/@int3gra/engine)
- [npm — @int3gra/manager](https://www.npmjs.com/package/@int3gra/manager)

## License

BSL 1.1 — free to use commercially as a component of your own products. May not be resold or repackaged as a standalone product. Converts to Apache 2.0 on 2030/12/31. See LICENSE and NOTICE for details.
