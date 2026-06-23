# example-sn-jira

An example integra integration that syncs open incidents from **ServiceNow** to **Jira** on a cron schedule.

---

## What it does

Every 5 minutes, the TrafficController wakes up and checks whether the previous sync run is still alive. If it isn't, it starts a fresh one. The integration process:

1. Fetches all open incidents from ServiceNow (state not Resolved or Closed)
2. Maps each incident to a Jira issue payload — converting priority codes, building the Atlassian document description format, setting labels from the SN category
3. Creates each issue in Jira via the REST API
4. Writes a run summary to the shared space and exits

If a run is still alive when the TC fires, it stands down and logs its reason. If a run has been alive longer than `max_ttl` seconds (currently 240 — 4 minutes), the TC kills it and starts a fresh one.

---

## Lifecycle

```
PM2 cron tick (*/5 * * * *)
  └── TrafficController wakes up
        ├── integration already running + within max_ttl → stand down
        ├── integration already running + exceeded max_ttl → kill, start fresh
        ├── integration stopped / errored → start fresh
        └── integration not registered → start fresh

Integration process (each run)
  └── boot → load components → validate → resolve → execute process → exit
        │
        ├── fetch open incidents from ServiceNow
        ├── for each incident:
        │     ├── map SN incident → Jira issue payload
        │     ├── if priority 1 or 2: override issuetype to Bug
        │     └── POST to Jira /rest/api/3/issue
        └── write run summary → exit cleanly
```

---

## Configuration

Copy `.env.example` to `.env` and fill in your credentials:

```bash
cp .env.example .env
```

```env
# ServiceNow
SN_BASE_URL=https://devXXXXX.service-now.com
SN_USER=integra-user
SN_PASS=integra-pass

# Jira
JIRA_BASE_URL=https://your-org.atlassian.net
JIRA_USER=integra@your-org.com
JIRA_API_TOKEN=your-api-token
JIRA_PROJECT_KEY=OPS

# Engine
LOG_LEVEL=info
```

The schedule and max_ttl live in this integration's registry entry
(`registry.d/example-sn-jira.registry.json` on the host), not here:

```json
{
  "id":       "example-sn-jira",
  "path":     "./example-sn-jira",
  "enabled":  true,
  "schedule": "*/5 * * * *",
  "max_ttl":  240
}
```

Adjust `schedule` to any valid cron expression. Adjust `max_ttl` to however many seconds a full sync should reasonably take given your incident volume.

---

## Running locally (no schedule)

```bash
cd example-sn-jira
cp .env.example .env
# fill in .env, then commit — see the root README's "Env files" section
git checkout -b try-it
git add -A && git commit -m "add credentials"
git push origin try-it

integra validate --id example-sn-jira --branch try-it
integra run sync-incident-sn-to-jira --id example-sn-jira --branch try-it --env .env
```

The process runs once and exits, logging a structured summary at the end:

```json
{
  "event": "sync.run_summary",
  "completed_at": "2026-04-20T10:32:18.000Z",
  "incidents_fetched": 5,
  "issues_created": 5,
  "issues_skipped": 0
}
```

---

## Running via the manager (scheduled)

Already registered in this repo's `registry.d/`. From any directory, once `integra setup` has been run on the host:

```bash
integra-manager start
integra-manager status
integra-manager logs example-sn-jira
```

The `status` output will show both the integration process and its TrafficController (`tc` column).

---

## Component map

```
connections/
  sn-get-incident.json       ← GET /api/now/table/incident (open only)
  jira-create-issue.json     ← POST /rest/api/3/issue
  no-op.json                 ← used by `integra ping` to check connectivity

maps/
  sn-to-jira-incident.json   ← SN incident shape → Jira issue payload

processes/
  sync-incident-sn-to-jira.json  ← orchestrates fetch → loop → map → create

resolvers/
  servicenow.js    ← basicAuth, snHasResults, snStore (+ queue init)
  jira.js          ← jiraBasicAuth, jiraStore
  itsm-maps.js     ← mapIncident (priority mapping, description formatting)
  sync.js          ← hasIncidents, hasNextIncident, isHighPriority,
                      syncStore (run summary), error handlers
```

---

## Priority mapping

| ServiceNow priority | Jira priority |
|---|---|
| 1 — Critical | Highest |
| 2 — High | High |
| 3 — Moderate | Medium |
| 4 — Low | Low |
| 5 — Planning | Lowest |

Incidents with priority 1 or 2 also get their Jira `issuetype` overridden to `Bug`.

---

## Tests

```bash
# from monorepo root
node --experimental-vm-modules node_modules/.bin/jest example-sn-jira
```

Tests use mocked HTTP — no live credentials needed.
