# Ontario Quote Agent

My personal Ontario auto-insurance quote-shopping assistant, built for the Ontario All-Quote Agent
Challenge (personal-use hackathon track). It obtains and compares **my own** auto insurance quotes
across direct, broker and aggregator channels — nobody else's.

This is not a commercial product and is not for anyone else's use. See
[docs/PERSONAL_USE.md](docs/PERSONAL_USE.md).

## How it fits together

```
   Me (local machine)                           Cloud
  ┌─────────────────────┐                ┌──────────────────────┐
  │  vault/  (encrypted) │                │  n8n (self-hosted)   │
  │  worker/ (Playwright │◄──jobs/results─┤  orchestration        │
  │  recipes, HTTP API)  │   (redacted    │  + Claude Messages API│
  │                      │    only)       │  ("the brain")        │
  └─────────────────────┘                └──────────────────────┘
        │ fills real forms directly
        ▼
   Insurer / broker / aggregator websites
```

Sensitive data (licence number, DOB, VIN, address, driving/claims history) lives **only** in my
local vault and is injected **only** by my local worker, directly into the destination form. It
never appears in an n8n execution, a Claude prompt, a log, a screenshot, or this repository. See
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full data-flow and trust-boundary breakdown.

## Repo layout

| Folder | Purpose |
|---|---|
| `vault/` | Local encrypted store + CLI for sensitive intake fields. Runs only on my machine. |
| `worker/` | Local Playwright automation service. One "recipe" per quote channel. Talks to the vault in-process; returns only redacted results. |
| `brain/` | Claude system prompt + tool definitions — the "brain" n8n calls via the Messages API. Operates only on non-sensitive data. |
| `n8n/` | Importable n8n workflow JSON (orchestration: route planning → worker jobs → normalization → comparison). |
| `schema/` | Canonical intake schema and quote-result schema (status enum, evidence fields). |
| `registry/` | Machine-readable Ontario market registry (legal underwriter / group / brand / distributor / rate source), seeded from the regulatory dataset in the challenge brief. |
| `orchestrator/` | `run_session.js` — the one local command I run for a full session: vault → n8n/Claude route plan → worker jobs → n8n/Claude comparison → redacted run report. |
| `docs/` | Architecture, safety, known limitations, personal-use notice, redacted run reports. |

## Status

MVP channel set: **Rates.ca** (aggregator), **Sonnet** and **TD Insurance** (direct writers),
**Onlia** (digital broker — self-generates a quote online), and a **local independent broker**
(traditional broker — human-mediated by nature; its recipe is built to
correctly land on `callback_required`/`manual_handoff`, not to chase an automated instant quote
that channel type doesn't produce). Each has its real entry point confirmed by direct navigation
where built, but the deeper multi-step form flow still needs to be captured against a live session
(see `worker/recipes/*.js` and `docs/KNOWN_LIMITATIONS.md` — this needs my real vault data, which
deliberately never enters this repo or any chat). Facility Association and the Ontario Mutuals are
explicitly `out_of_scope` for this build, not `unresolved` — see `docs/KNOWN_LIMITATIONS.md`. All
other registry entries start as `unresolved` — an honest, evidence-backed status per the brief's
own scoring rubric, not a gap to hide.

## Setup

1. **Vault** — see [vault/README.md](vault/README.md). I populate my real data locally; nothing
   here or in this repo ever sees it.
2. **Worker** — see [worker/README.md](worker/README.md). `npm install`, install a Chromium
   build, run `node server.js`.
3. **n8n** — see [n8n/README.md](n8n/README.md). Import the workflow, add my Claude API
   credential.
4. **Run a session** — see [orchestrator/README.md](orchestrator/README.md). Copy
   `profiles.example.json`, edit it, run `run_session.js`.
