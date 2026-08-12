# n8n workflow

`ontario_quote_agent.workflow.json` is importable directly into my
self-hosted n8n instance. It defines two independent webhook-triggered flows —
no shared state between them, nothing persisted on the n8n side:

- **`POST /webhook/oqa-plan`** — receives a system prompt, tool definitions,
  the market registry, and one or more non-sensitive profiles; calls Claude to
  produce a route plan per profile; returns `{ run_id, route_plans, flags }`.
- **`POST /webhook/oqa-compare`** — receives a benchmark coverage config and
  the local worker's redacted results for one profile; calls Claude to
  normalize and compare them; returns `{ run_id, comparison, flags }`.

Both are called by [`orchestrator/run_session.js`](../orchestrator/run_session.js),
which is the way I actually run a session — see that folder's README for the
end-to-end flow. I generally don't call these webhooks by hand.

Nothing here ever touches the vault, the worker, or an insurer/broker site
directly — this workflow only ever talks to the Claude API. See
[docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md) for why the system is split
this way.

## Import

1. In n8n: **Workflows → Import from File** → select
   `ontario_quote_agent.workflow.json`.
2. Create a credential for the Claude API: **Credentials → New → Header Auth**,
   name it `Anthropic API Key (x-api-key)`, header name `x-api-key`, value =
   my Anthropic API key. Attach it to both HTTP Request nodes ("Claude —
   Plan Routes" and "Claude — Compare") — the imported JSON references this
   credential by name but n8n requires me to re-attach it locally since
   credentials are never exported with a workflow.
3. Activate the workflow (or leave it in test mode while iterating —
   n8n shows the live webhook URLs either way under each Webhook node).
4. Note the two webhook URLs (Production or Test, matching how it's
   running) and set `N8N_BASE_URL` for the orchestrator script to the base
   URL that serves them (e.g. `https://my-n8n-host.example.com`, without the
   `/webhook/...` suffix — the script appends that itself).

## Why no filesystem node

Earlier drafts of this workflow had it read `brain/system_prompt.md`,
`brain/tools_schema.json`, and `registry/market_registry.json` directly off
the n8n host's disk. That coupled the workflow to wherever this repo happened
to be synced on that host. Instead, the orchestrator script — which already
has full local repo access — reads those files and sends their contents as
part of each webhook call. The workflow itself stays a pure function of its
input, easier to reason about and to re-import without extra host setup.
