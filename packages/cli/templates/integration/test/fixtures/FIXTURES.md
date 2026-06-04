# Test Fixtures

This directory contains fixture files used by `integra test` to mock-test your integration without touching real systems.

## Structure

```
fixtures/
  webhooks/      — inbound payloads fired AT a listener integration
  responses/     — outbound response bodies returned BY mocked upstream APIs
  .disabled/     — move any fixture here to disable it without deleting it
  .fixture-map.json  — maps outbound URLs to response fixture files (required when responses/ has more than one file)
```

## Webhooks (`webhooks/`)

Each `.json` file is a webhook payload. When you run `integra test`, every file in this directory (except those in `.disabled/`) is signed and fired at the listener in sequence.

Binary files (e.g. for attachment testing) are also supported.

Example: `webhooks/jira-issue-created.json`

## Responses (`responses/`)

Each `.json` file is a mock HTTP response body for an outbound connection call.

- **One file** — used for all outbound calls. No further configuration needed.
- **Multiple files** — a `.fixture-map.json` is required to tell `integra test` which file answers which URL.

Binary files are supported for attachment download testing.

Example: `responses/sn-create-incident-201.json`

## `.fixture-map.json`

Required only when `responses/` has more than one file. Maps outbound request URLs to fixture filenames:

```json
{
  "https://devXXXXX.service-now.com/api/now/table/incident": "responses/sn-create-incident-201.json",
  "https://devXXXXX.service-now.com/api/now/attachment/file": "responses/sn-attachment-upload-201.json"
}
```

If a URL is called during `integra test` but has no entry in the map, the run fails immediately with a clear error.

## Disabling fixtures

Move any fixture file into `.disabled/` to exclude it from test runs. Move it back to re-enable it.

## Running

```bash
integra test
```

From the integration directory. No credentials required — nothing real is called.
