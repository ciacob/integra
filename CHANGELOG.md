# Changelog

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
