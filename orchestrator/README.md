# Orchestrator

`run_session.js` is the one command I run for a full quote-shopping session,
wiring together the vault, n8n/Claude (the brain), and the local worker. It
runs on my own machine, alongside the worker.

## Configure a run

```bash
cp orchestrator/profiles.example.json orchestrator/profiles.json
```

Edit `profiles.json` — everything in it is `planning_safe` (see
`schema/intake_schema.json`), safe to look at or share:

- `benchmark_coverage` — the one coverage configuration every route is asked
  to match, so results are comparable (see the brief's suggested demo
  benchmark).
- `profiles` — one or more vehicle/coverage variants to compare in the same
  run, e.g. a 2026 vs. a 2025 model year. Each `overrides` object is merged on
  top of my vault's `planning_safe` fields (which I set once via
  `vault/cli.js set ...` and don't need to repeat here).
- `requested_routes` — which registry routes are actually allowed to run this
  session, as a safety filter on top of whatever the brain plans. Defaults to
  `registry/market_registry.json`'s `mvp_routes` if omitted.

## Run

```bash
# terminal 1
cd worker && node server.js

# terminal 2
N8N_BASE_URL=https://my-n8n-host.example.com node orchestrator/run_session.js
```

I'm prompted once for my vault passphrase. The script then:

1. Builds each profile's full `planning_safe` field set (vault baseline +
   my overrides).
2. Asks n8n's `oqa-plan` webhook for a route plan (via Claude).
3. Runs each planned route against the local worker, one at a time.
4. Asks n8n's `oqa-compare` webhook to normalize and compare the results (via
   Claude).
5. Prints a summary per profile and writes the full run to
   `docs/run_reports/<run_id>.json` (machine-shaped, for reuse/debugging) and
   `docs/run_reports/<run_id>.md` (the same data as a plain-English summary —
   this is the one to actually read). Both are safe to commit, since
   everything in them is already redacted/non-sensitive by construction.

If the brain ever flags something anomalous (`flag_new_field`) — e.g. it
thinks a sensitive-looking value leaked into a `planning_safe` field — the
script stops and prints the flag instead of continuing, rather than silently
proceeding with something the privacy design didn't anticipate.

The script refuses to start if `profiles.json` is missing `profiles` or
`benchmark_coverage` — I get a clear message up front rather than a cryptic
failure mid-run.

## Error handling, timeouts, and retries

- Calls to n8n (`oqa-plan`/`oqa-compare`) get a 2-minute timeout and up to 3
  retries with exponential backoff + jitter (~0.5–1.5s, ~1–3s, ~2–6s) — but
  only when the failure is classified as worth retrying (`isRetryable()`):
  a rate limit, an overloaded/5xx response, a timeout, or Claude simply not
  calling the expected tool on that attempt. A non-retryable failure — a bad
  API key, a malformed request — fails immediately on the first attempt
  instead of burning the retry budget confirming the same answer three more
  times. n8n's own HTTP node no longer retries on its own for this reason;
  classification happens once, here, where the actual error detail is
  available. Every retry (and every "not retrying, here's why" decision) is
  logged.
- Calls to the local worker get a 20-minute timeout (long enough to comfortably
  outlast a human-in-the-loop pause inside a route) but are **never** retried
  automatically — retrying would mean re-running a real browser session
  against a real site, which could double-submit a form. A failed worker call
  for one route is recorded as `unreachable` and the run moves on to the next
  route rather than retrying or aborting the whole session.
- Every run logs to `worker/logs/worker.jsonl` (shared with the worker's own
  log) and the final run report includes rough Claude token usage per call —
  visibility into spend, not a hard budget/cap.

I can override the defaults with `OQA_N8N_TIMEOUT_MS` and `OQA_WORKER_TIMEOUT_MS`
if needed.
