# Worker

Local-only Playwright automation service. Runs on my own machine, never in
the cloud, never inside n8n. See [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md)
for why.

## Setup

```bash
cd worker
npm install
npx playwright install chromium   # downloads a local Chromium build
```

## Running

```bash
node server.js
```

I'm prompted once for my vault passphrase (hidden input). It's held in
memory for the life of this process only — never written to disk, never
logged, never returned in an API response. I stop the process (Ctrl+C) when
I'm done with a shopping session; nothing persists in memory after that.

The server listens on `http://127.0.0.1:8787` (loopback only — not reachable
from outside my machine by default, on purpose).

The browser runs **headful (visible)** by default, since some recipes pause
for me to act in the actual window — see "Human-in-the-loop" below. Setting
`OQA_HEADLESS=true` runs it headless instead.

Every run logs to both the console and `worker/logs/worker.jsonl` (git-ignored,
plain JSON lines — field names and statuses only, never sensitive values).

Other env vars, all optional: `OQA_WORKER_PORT` (default 8787),
`OQA_ROUTE_TIMEOUT_MS` (default 15 min — overall bound per route, comfortably
longer than a human pause), `OQA_ACTION_TIMEOUT_MS` (default 20s, per
fill/click), `OQA_NAV_TIMEOUT_MS` (default 30s, per page navigation).

## Human-in-the-loop

Some checkpoints (a CAPTCHA, or a final review-before-submit) pause the
recipe rather than stopping it outright — `lib.pauseForHuman(message)` prints
a prompt right here in this terminal and waits for me to press Enter (or
type "abort") before the recipe keeps going in the *same* browser window and
session. If nobody responds within 10 minutes, it gives up and reports
`unresolved` rather than hanging forever. See
`worker/recipes/local_independent_broker.js` for the working example.

**A site asking something my vault doesn't have an answer for** uses this
same mechanism automatically — `lib.fillFromVault()` pauses and prints the
exact field name and the exact `vault/cli.js set ...` command to run. I open a
second terminal, run it there, then come back and press Enter — the recipe
picks up the new value and keeps going, no restart. If I skip that, only
that one route ends; the rest of the run is unaffected.

## API

- `GET /health` — confirms it's running and lists loaded recipes.
- `GET /routes` — same route list.
- `POST /run/:routeId` with body `{ "params": { ... } }` — runs one route.
  `params` must contain only `planning_safe` fields (vehicle year/make/model,
  coverage config, etc. — see `schema/intake_schema.json`). The recipe itself
  pulls any sensitive field it needs straight from the vault, in-process.
  Returns a result shaped like `schema/quote_result_schema.json`, with an
  `evidence.redacted_artifact_ref` pointing at a locally-saved, masked
  screenshot — never sensitive raw data.

## No tunnel needed — the orchestrator is the hub, not n8n

n8n never calls this worker directly, so nothing needs to reach *into* my
machine from the cloud. Instead,
[`orchestrator/run_session.js`](../orchestrator/run_session.js) runs locally
right alongside this worker and calls both sides itself: it calls the worker
over plain `127.0.0.1`, and it calls my cloud n8n instance's webhooks over
normal outbound HTTPS — the same direction any browser request to n8n would
go. n8n stays a pure function of whatever the orchestrator sends it; it holds
no state and needs no filesystem or network access to my machine at all.

That's also why this worker only ever receives non-sensitive `params` and
only ever returns redacted results, regardless of how it's reached — see
`schema/intake_schema.json`'s `planning_safe` tag for exactly what's allowed
to cross that boundary.

## Recipes are stubs — finish them with Playwright codegen

Each file in `recipes/` has its site's real entry point confirmed (I checked
each MVP site's actual landing page/quote-start URL directly, without
entering any data), but the deeper multi-step form flow needs to be captured
against a live session — something that can't be done without real answers to
type in, which this project deliberately keeps out of any chat or shared
context.

To finish a recipe myself, once my vault has real data in it:

```bash
npx playwright codegen https://sonnet.ca/
```

This opens a real browser and a code-generation panel: I click and type
through the quote form once, and Playwright writes out the selectors and
actions it saw. I copy the relevant steps into the matching `recipes/*.js`
file, swapping literal values for
`lib.fillFromVault(page, selector, 'group.field', vaultPassphrase)`
(sensitive) or `lib.fillPlanning(page, selector, params.field)` (non-sensitive),
and insert a `throw new lib.HumanCheckpoint(...)` right before any
identity/consent/declaration/payment step — never letting codegen's recording
carry me past one of those on a real run.

See `recipes/_template.js` for the full contract and
`docs/KNOWN_LIMITATIONS.md` for why recipes are intentionally brittle rather
than "smart."
