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

## Commands

Run from the directory containing `registry.json`:

```bash
integra-manager start [--env <file>]   # Start all enabled integrations
integra-manager stop <id>              # Stop an integration
integra-manager restart <id>           # Restart an integration
integra-manager status                 # Show status, lifecycle, env, uptime
integra-manager logs <id>             # Tail integration logs
integra-manager enable <id>            # Enable an integration in the registry
integra-manager disable <id>           # Stop and disable an integration
```

## `registry.json`

The manager reads a `registry.json` file that lists all known integrations:

```json
{
  "integrations": [
    {
      "id":          "my-sn-jira",
      "path":        "./my-sn-jira",
      "enabled":     true,
      "description": "Syncs ServiceNow incidents to Jira",
      "schedule":    "*/5 * * * *",
      "max_ttl":     240
    },
    {
      "id":          "my-jira-sn",
      "path":        "./my-jira-sn",
      "enabled":     true,
      "description": "Receives Jira webhooks and creates SN incidents"
    }
  ]
}
```

## Lifecycles

| Lifecycle | How it runs |
|---|---|
| *(absent)* | Run-once — starts, executes entry process, exits |
| `scheduled` | TrafficController fires entry on cron schedule |
| `listener` | Long-lived Fastify HTTP server, `autorestart: true` |

Lifecycle is declared in each integration's `integra.json`. A `schedule` field in `registry.json` makes an integration scheduled.

## Links

- [Documentation & full README](https://github.com/ciacob/integra#readme)
- [GitHub](https://github.com/ciacob/integra)
- [npm — @int3gra/engine](https://www.npmjs.com/package/@int3gra/engine)
- [npm — @int3gra/cli](https://www.npmjs.com/package/@int3gra/cli)

## License

Apache-2.0 with Commons Clause. Free to use commercially. Not free to resell or rebrand.
