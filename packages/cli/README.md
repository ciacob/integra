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
integra setup                    # One-off host provisioning. Run once, as root.
integra init <name>              # Scaffold a new integration directory
integra validate                 # Validate integra.json and all component files
integra run <process-id>         # Execute a process locally
integra run <process-id> --env <file>  # Run with a specific env file
integra test                     # Mock-test using fixture files (no real calls)
integra ping                     # Check connectivity via the no-op connection
integra ping --con <id>[,<id>]   # Ping specific connection(s)
integra ping --env <file>        # Ping with a specific env file
```

### `integra init`

Scaffolds a new integration directory with the standard layout:

```
my-integration/
  connections/   maps/   processes/   resolvers/   logs/
  test/fixtures/webhooks/   test/fixtures/responses/
  integra.json   .env.example
```

### `integra test`

Runs the integration end-to-end against fixture files — no real HTTP calls. Place response fixtures in `test/fixtures/responses/` and webhook fixtures in `test/fixtures/webhooks/`. Use `test/fixtures/.fixture-map.json` to map outbound URLs to fixtures when you have more than one response file.

### `integra ping`

Fires `connections/no-op.json` (or the connections named via `--con`) and reports reachability. The implementor provides a safe, side-effect-free connection to use as the connectivity check.

## Links

- [Documentation & full README](https://github.com/ciacob/integra#readme)
- [GitHub](https://github.com/ciacob/integra)
- [npm — @int3gra/engine](https://www.npmjs.com/package/@int3gra/engine)
- [npm — @int3gra/manager](https://www.npmjs.com/package/@int3gra/manager)

## License

BSL 1.1 — free to use commercially as a component of your own products. May not be resold or repackaged as a standalone product. Converts to Apache 2.0 on 2030/12/31. See LICENSE and NOTICE for details.
