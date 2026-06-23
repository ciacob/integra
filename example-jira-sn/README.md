# example-jira-sn

An example integra integration that receives Jira issue webhooks and creates corresponding incidents in ServiceNow.

This is the inbound counterpart to `example-sn-jira`. Where that example polls ServiceNow on a schedule and pushes to Jira, this one listens for Jira to push to us.

---

## What it does

A Fastify HTTP server listens on port `3100` for `POST /hooks/jira`. On each request it:

1. Verifies the HMAC-SHA256 signature (`X-Hub-Signature-256`)
2. Validates the payload shape against `schemas/jira-issue-event.json`
3. Fires the `handle-jira-issue` process with the request body as `input.payload`
4. Maps the Jira issue to a ServiceNow incident via the `jira-to-sn-incident` map component
5. Creates the incident in ServiceNow via the `sn-create-incident` connection
6. Returns the result as the HTTP response body (`sendResult: true` — see note below)

Supported webhook events: `jira:issue_created`, `jira:issue_updated`. Any other event type is acknowledged but not processed.

> **`sendResult: true` is set for demonstration only.** It makes the response visible when running `send-test-webhook.js` locally. Real Jira ignores webhook response bodies entirely — in production you would use `sendResult: false`.

---

## Configuration

```bash
cp .env.example .env
# Fill in your credentials
```

```env
JIRA_WEBHOOK_SECRET=change-me-to-a-strong-secret
SN_BASE_URL=https://devXXXXX.service-now.com
SN_USER=integra-user
SN_PASS=integra-pass
```

---

## Running locally

Start the listener (from the `example-jira-sn` directory):

```bash
integra run handle-jira-issue
```

In a separate terminal, fire a test webhook:

```bash
node tools/send-test-webhook.js
```

You should see the signed payload sent, the listener process it, and a JSON response printed to the terminal showing the created ServiceNow incident number.

Options for the test tool:

```bash
node tools/send-test-webhook.js --event jira:issue_updated
node tools/send-test-webhook.js --port 3100 --secret my-other-secret
```

---

## Running via the manager

Already registered in this repo's `registry.d/`. From any directory, once `integra setup` has been run on the host:

```bash
integra-manager start
integra-manager status
integra-manager logs example-jira-sn
```

---

## Priority and category mapping

| Jira priority | ServiceNow urgency |
|---|---|
| Highest | 1 — Critical |
| High | 2 — High |
| Medium | 3 — Moderate |
| Low / Lowest | 4 — Low |

| Jira issue type | ServiceNow category |
|---|---|
| Bug / Incident | software |
| Service Request | request |
| Task / Story | inquiry |

The Jira issue key (`OPS-42`) is stored as `correlation_id` on the ServiceNow incident so the two records can be linked.

---

## Component map

```
connections/
  sn-create-incident.json    ← POST /api/now/table/incident
  no-op.json                 ← used by `integra ping` to check connectivity

maps/
  jira-to-sn-incident.json   ← Jira issue → SN incident payload

processes/
  handle-jira-issue.json     ← orchestrates map → create, builds http_response

resolvers/
  servicenow.js              ← snStore
  itsm-maps.js               ← mapJiraToSn, extractAtlassianText, mapStore
  handler.js                 ← isSupportedEvent, buildHttpResponse, error handlers

tools/
  send-test-webhook.js       ← fires a signed test webhook at the local listener

schemas/
  jira-issue-event.json      ← payload validation schema
  jira-issue-event-query.json
```

---

## Tests

```bash
# from monorepo root
node --experimental-vm-modules node_modules/.bin/jest example-jira-sn
```

Tests use mocked fetch — no live credentials or running listener required.
