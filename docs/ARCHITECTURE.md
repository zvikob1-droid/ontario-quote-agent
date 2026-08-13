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
| **Claude ("the brain")** | Anthropic API, called from n8n | No | Plans which channels to attempt for a given non-sensitive profile shape, normalizes redacted quote results into the comparison ledger, writes the human-readable summary. Mid-route, also resolves a page question a recipe's static mapping doesn't recognize — see §7.5 — seeing only that question's own label/type/options/error text, never a value. Never receives a sensitive field, even encrypted, in any of these calls. |

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
   step, the recipe stops (see §5, Human checkpoints). If a page question doesn't match the
   recipe's static mapping (a site changed, added, or reworded something), the worker can consult
   the brain mid-route — see §7.5 — but the worker still does every actual lookup and keystroke
   itself; the brain only ever returns a field name or a fixed strategy keyword, never a value.
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
- Evidence artifacts (screenshots, call notes): redacted before being saved to `worker/evidence/`.
  Any pre-redaction capture would live under `worker/evidence/raw/`, which is git-ignored and never
  committed. The redacted, post-mask artifacts under `worker/evidence/<route>/<run>/` are the
  submittable proof of a live run and are committed after a manual review confirms no sensitive
  value is visible.
- Access logs and consent receipts are kept separate from the quote display data.
- One-click delete: `vault/cli.js delete-all` wipes the local encrypted store. All hackathon quote
  data is deleted after judging unless I choose otherwise.

## 7. What Claude (the brain) is and isn't allowed to do

Claude plans routes, normalizes redacted results, writes human-readable comparisons, and (§7.5)
helps resolve an unrecognized page question mid-route. Claude is never the thing that types a
sensitive value into a form, never sees a raw sensitive value, and never makes a purchase, binds a
policy, or submits payment — those actions are out of scope for the whole system, not just for
Claude.

### 7.5 Mid-route field resolution — why it doesn't cross the trust boundary

Every recipe is a fixed, hand-written script — it has no ability to adapt when a site doesn't match
what it expects. Confirmed live, repeatedly, in one evening's testing: a form field duplicated
across responsive breakpoints, a submit button gated on an event a library method doesn't fire, a
question quietly removed from a page, a validation rule (a date must be within 60 days) that a real
stored value doesn't satisfy. Every one of those had to be individually discovered through a real
failure and hand-fixed — there was no way for the system itself to notice something was off and
reason about a response, because the one component capable of that reasoning (Claude) was
structurally excluded from every moment during route execution.

`resolve_fields` (`brain/tools_schema.json`, `n8n/ontario_quote_agent.workflow.json`'s
`oqa-resolve-field` webhook, `worker/lib/recipe_lib.js#resolveFieldsWithBrain`) closes that gap
without moving the trust boundary, via a strict separation between *structure* and *values*:

- **What the worker sends:** a question's own label text, its field type, the *site's own*
  predefined option list (e.g. `["Yes", "No"]` — the site's wording, not the applicant's answer),
  and any visible validation error text. All of this is the site's own static content, in the same
  `planning_safe` category as the market registry or a coverage-configuration field — never
  something the applicant typed or the vault holds.
- **What the worker never sends:** any field's current *value*. Not vault_only data, not even
  already-filled `planning_safe` data. The function has no `vaultPassphrase` parameter at all — it
  cannot leak a vault value even by accident, because it has no code path to one.
- **What Claude returns:** for each question, either a `field_mapping` (an exact
  `schema/intake_schema.json` path the worker should look up itself) or one of a fixed set of
  strategy keywords — never a literal value it invented. In priority order: `use_mapped_field_value`
  (the clean case — a known field asked differently), `use_inferred_value` (the question is
  genuinely answerable from `profile_context`, the same `planning_safe` facts already sent for this
  route during planning — not new exposure, just available again here; Claude may only pick one of
  that question's own already-disclosed options, never write new text), `use_today_date`/`use_zero`
  (an administrative constraint with no vault concept — never used for a question about the
  applicant's actual history), `pause_and_ask` (a *mandatory* driving/claims/conviction/insurance
  history question `profile_context` doesn't answer — handed to the human rather than defaulted to
  whichever answer looks better, favorable or not), `skip_and_disclose`/`unresolved` (an honest
  gap). The worker does every actual lookup and every keystroke, exactly as it already does
  everywhere else — even for `use_inferred_value`, Claude only ever names one of the options the
  worker already disclosed as the site's own wording, never something it introduced itself.
- **Guardrails, both directions, checked twice each** (once in the n8n workflow, once again in the
  worker itself — defense in depth, not trust-the-network):
  - *Input:* the outbound payload (questions and `profile_context` alike) is scanned for
    value-shaped patterns (email, phone number, Canadian postal code, a long digit run) before it
    ever leaves the process it's being built in. A match blocks the call entirely and resolves
    every question to `unresolved` locally — nothing suspect reaches n8n, let alone Claude.
  - *Output:* every `field_mapping` Claude returns is re-validated against the real schema field
    list, every `strategy` against the fixed keyword set, and every `inferred_value` against that
    specific question's own disclosed options. Anything that doesn't match exactly is discarded and
    forced to `unresolved` rather than acted on.

This mechanism is built and proven on `rates_ca.js` (the vehicle purchase-date validation case, via
`use_today_date`); `use_inferred_value` and `pause_and_ask` are built and guardrail-tested but not
yet exercised by a live recipe call site, and extending any of this to the other four recipes is
the natural next step, not yet done — see `docs/KNOWN_LIMITATIONS.md`.

**A second call site: selector rediscovery, not just value resolution.** The same live testing
that proved the purchase-date case also surfaced a different shape of drift: Rates.ca's driver
licence-type question is worded `"What type of licence does <the driver's own first name>
currently hold?"` once a name is filled in, not a static placeholder — a plain text-match selector
written before that was known assumed literal text ("Driver") that never appears. That's not a
values question (the recipe already knows the right answer); it's the DOM element itself moving out
from under a fixed selector, the same failure class §7.5's intro already names ("a submit button
gated on an event a library method doesn't fire, a question quietly removed from a page"). Rather
than hand-patch each occurrence as it's found live, `fillPlanningResilient`/
`selectPlanningResilient` (`worker/lib/recipe_lib.js`) wrap the normal fill/select call: on a
timeout for a field the recipe already has a schema mapping for, `rediscoverSelector` scans the
page's own currently-visible labels/field-types/options (`scanVisibleFormQuestions` — structure
only, exactly the same shape sent everywhere else in this mechanism, never a value) and runs them
through the *same* `resolveFieldsWithBrain` call and guardrails already described above, asking
which candidate (if any) maps back to the schema field the recipe was already trying to fill. If
one matches, the recipe retries once against that candidate's own label; if nothing resolves (n8n
not configured, no confident match, or the output guardrail discards an answer that doesn't match
the field actually asked about), the original error propagates unchanged — this is a resilience
layer on top of the existing static selector, not a silent skip or a second way to guess a value.
Guardrail-tested (happy path, no-n8n-configured fallback, full round trip, and a rejected-mismatched-
mapping case) via a throwaway script before being wired into `rates_ca.js`'s licence-class selector
as defense-in-depth alongside the direct substring fix; not yet exercised by an actual live
selector failure (today's fix was resolved by the substring correction itself, so this fallback's
live trigger path is still unproven end-to-end against a real site).
