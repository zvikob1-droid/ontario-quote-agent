# Architecture and safety note

## 1. Why the system is split the way it is

Two rules from the challenge brief drive every architectural decision here:

1. *"Keep sensitive fields in a dedicated encrypted vault and inject them only into the
   destination that needs them."*
2. *"Mask licence numbers and other identifiers in the UI; never place them in prompts, traces,
   analytics, screenshots, demos, source control or submitted datasets."*

Both n8n (self-hosted on a cloud VM) and Claude (called from n8n over the Messages API) are
**outside the trust boundary** for sensitive data. Neither is designed to guarantee that a value
passed into it won't end up in an execution log, a prompt trace, or a provider's own logging.
So sensitive fields simply never go there — not encrypted, not tokenized, not at all. Only the
**local worker**, running on my own machine, ever holds a decrypted sensitive value, and only for
the instant it takes to type it into a form field.

## 2. Components and trust boundaries

| Component | Runs where | Sees sensitive data? | Role |
|---|---|---|---|
| **Vault** | Local machine only | Stores it (encrypted at rest) | Holds licence #, DOB, VIN, address, driving/claims history. Decrypts a field only in-process, on request from the local worker. |
| **Worker** | Local machine only | Yes, transiently, in-process | Runs Playwright recipes per channel. Reads a field from the vault right before typing it into a form, then discards it — never logs, returns, or persists the raw value. Returns only redacted results (status, premium, coverage, masked evidence) to n8n. |
| **n8n** | Self-hosted cloud VM | No | Orchestrates the run: asks Claude for a route plan, sends job requests (non-sensitive params only — vehicle year/make/model, coverage config, which channel) to the local worker, collects redacted results, asks Claude to normalize/compare them, produces the output. |
| **Claude ("the brain")** | Anthropic API, called from n8n | No | Plans which channels to attempt for a given non-sensitive profile shape, maps form questions to the canonical schema, normalizes redacted quote results into the comparison ledger, writes the human-readable summary. Never receives a sensitive field, even encrypted. |

The consequence: even if n8n's execution history or Claude's conversation were fully exposed, no
licence number, DOB, VIN, address, or driving/claims history would be in it. The blast radius of a
leak on the cloud/LLM side is limited to non-sensitive facts (e.g., "2025 Chevy Equinox,
Toronto-area postal prefix, $2M liability requested") that are needed to route and compare quotes.

## 3. Data flow, step by step

1. **Local intake (once).** I run the vault CLI on my machine and enter my real data directly —
   never through n8n, never through this repo, never through a chat with Claude. The CLI never
   echoes values back to the terminal after they're set.
2. **Non-sensitive profile extraction.** The vault also stores a small *non-sensitive* profile
   view (vehicle year/make/model, general location — not full address, coverage preferences) that
   is safe to hand to n8n/Claude for planning. This is generated locally and is the only thing
   that leaves the vault before a job runs.
3. **Route planning (n8n → Claude).** n8n sends the non-sensitive profile plus the current market
   registry to Claude. Claude returns a route plan: which channels to attempt, in what order, and
   which canonical intake fields each one needs (by *name*, not value).
4. **Job dispatch (n8n → local worker).** For each planned route, n8n calls the local worker's
   HTTP API with the channel name and the non-sensitive parameters. No sensitive field is ever a
   parameter in this call.
5. **Form fill (local worker only).** The worker's Playwright recipe for that channel runs
   locally, pulls each sensitive field from the vault at the moment it's needed, types it, and
   proceeds. Before any identity lookup, consent attestation, signature, payment, or purchase
   step, the recipe stops (see §5, Human checkpoints).
6. **Evidence capture.** The worker saves a timestamped, redacted evidence artifact (screenshot
   with sensitive fields masked, or a structured note) plus the outcome status.
7. **Redacted result (local worker → n8n).** Only the outcome status, premium, coverage terms,
   discounts, validity, and redacted evidence *reference* go back to n8n.
8. **Normalization (n8n → Claude).** Claude maps results into the common quote-result schema,
   flags coverage differences from the benchmark, and assembles the comparison.
9. **Output.** n8n produces the comparison (and can notify me), all built from redacted data end
   to end.

## 4. Consent flow

- Nothing is sent to any insurer/broker/aggregator route until I've explicitly triggered a run for
  that route.
- Before dispatch, the plan shows me which fields a given route will receive, so I can exclude a
  route (per the brief's requirement to "show the user which route will receive which fields
  before submission and let the user exclude a route").
- The system never enters another household driver's information — the vault only ever holds my
  own data, and there is no field for "other driver consent" in this personal-use build because no
  other driver's data is collected.

## 5. Human checkpoints (pauses I control, never automation targets)

| Checkpoint | Behaviour |
|---|---|
| Identity/database lookup | Worker pauses; I confirm legal name, licence use, and consent before it proceeds. |
| Missing vault field / an unanticipated question | Worker pauses (`fillFromVault`) and tells me exactly which field and command — I set it in another terminal and resume from the same spot. See below. |
| Application declaration | Worker stops. Never clicked or signed by automation. |
| Coverage advice | System presents options and differences only. No suitability recommendation. |
| CAPTCHA / access restriction | Worker pauses and hands off to me — see below. Never solved or bypassed by automation. |
| Quote-to-purchase transition | Worker stops after saving quote details. Never binds, never pays. |

**On the missing-field pause specifically:** a real site will ask questions this project didn't
anticipate — a slightly different phrasing of a known field, or a genuinely new one. Rather than
treating that as a dead end, `fillFromVault()` pauses the same way a CAPTCHA does: it names the
exact vault field it needs and the exact command to set it, I run that in another terminal (the
vault is a shared file on disk, so the value is visible the moment I resume — no restart), and the
recipe continues from exactly where it paused. If I skip that — abort, don't respond, or leave it
unset — only *that* route ends (`manual_handoff`/`unresolved`); every other route in the run is
unaffected.

**On CAPTCHA specifically:** the brief's own rule is "hand off only if permitted; otherwise log
the blocker" — not "always stop." There's a real difference between automating past a CAPTCHA
(prohibited outright, everywhere in this project) and pausing so I solve it myself, as a real
person, in the actual browser window. A CAPTCHA exists to confirm a human is present; a human
solving it is the check working as intended, not a bypass of it.

In practice: the worker runs the browser in headful mode by default (a visible window — set
`OQA_HEADLESS=true` to opt into headless for routes that won't need a human). A recipe pauses via
`lib.pauseForHuman(message)` (`worker/lib/recipe_lib.js`), which blocks in the worker's own
terminal — "solve it in the browser window, then press Enter to continue" — and keeps running in
the *same* browser session once I do, rather than ending the run outright. If I solve it, the run
continues and ends with whatever status it would have reached anyway (`quoted_comparable`,
`estimate_only`, etc.) — it was never really "blocked." If I type "abort," don't respond within
the wait window (10 minutes by default), or it's not that kind of barrier at all (e.g. a hard
bot-detection wall with no human challenge to solve), it falls back to `manual_handoff`/
`unresolved`/`blocked` as appropriate, logged honestly — never silently.

This mechanism is built and used for real in `worker/recipes/local_independent_broker.js` (the
Staebler route), where it pauses before the final Submit click. It isn't yet exercised by the
other four MVP recipes' CAPTCHA paths, since those recipes don't reach far enough into their
site's flow yet to hit one — see `docs/KNOWN_LIMITATIONS.md`.

## 6. Storage, redaction, and deletion

- Sensitive fields: encrypted at rest in the local vault only. Never written to n8n, Claude
  prompts/traces, this repository, or any submitted artifact.
- Evidence artifacts (screenshots, call notes): redacted before being saved to `worker/evidence/`,
  which is git-ignored and excluded from anything submitted.
- Access logs and consent receipts are kept separate from the quote display data.
- One-click delete: `vault/cli.js delete-all` wipes the local encrypted store. All hackathon quote
  data is deleted after judging unless I choose otherwise.

## 7. What Claude (the brain) is and isn't allowed to do

Claude plans routes, maps intake fields by name, normalizes redacted results, and writes
human-readable comparisons. Claude is never the thing that types a sensitive value into a form,
never sees a raw sensitive value, and never makes a purchase, binds a policy, or submits payment —
those actions are out of scope for the whole system, not just for Claude.
