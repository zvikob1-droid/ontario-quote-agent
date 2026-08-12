# Vault

Local-only encrypted store for sensitive intake fields (licence number, DOB, VIN,
address, driving/claims history). No network calls, no npm dependencies — just
Node's built-in `crypto` (AES-256-GCM, scrypt-derived key from my passphrase).

**I run this only on my own machine, directly in a terminal.** Never paste real
values into a chat, an n8n node, or anywhere outside this CLI.

```bash
# See all valid field names
node cli.js

# Set a field (passphrase and value both hidden when run in a real terminal)
node cli.js set licence_identity.ontario_drivers_licence_number
node cli.js set vehicle_identity.vin
node cli.js set vehicle_identity.model_year

# Check what's populated (values are never shown)
node cli.js list

# Print only the non-sensitive fields — the profile the brain (Claude via n8n)
# is allowed to see for route planning and normalization
node cli.js export-planning-safe

# Wipe everything
node cli.js delete-all
```

`lib.js` is the module the local `worker/` imports directly (in-process, same
machine) to pull a single field's real value at the moment it's typed into a
form — never through this CLI, never through a file, never logged.

Field names and their `vault_only` vs `planning_safe` classification come from
[`schema/intake_schema.json`](../schema/intake_schema.json). Whenever I'm unsure
whether something is sensitive, it defaults to `vault_only`.
