# Known limitations

Honest accounting of where this system depends on something outside its own control, per the
challenge brief's requirement to state gaps rather than imply full coverage.

## Coverage

- **Market breadth.** The regulatory seed lists 60 legal entities across 32 insurer groups. This
  build actively attempts 5 distinct rate sources for the MVP: Rates.ca (aggregator), Sonnet and
  TD Insurance (direct writers), Onlia (digital broker), and one local independent broker
  (traditional broker). Every other registry entry is `unresolved`: not yet built, not yet
  attempted. That label describes the state of this build, not a prediction about what each route
  would actually return.
- **Digital brokers vs. traditional independent brokers are structurally different, and the
  registry reflects that.** A digital broker (Onlia, and also Surex/ThinkInsure/Scoop/PC Insurance
  in the wider registry) can self-generate a quote online, the same as a direct writer. A
  traditional local independent broker cannot — it provides its carrier list and quote results on
  request, which is a human-mediated exchange, not a page render (confirmed directly by Staebler's
  own site description of its 3-step process, not by an independently-verified legal citation —
  see the Staebler recipe file). The
  `local_independent_broker` MVP route is built around that reality: its recipe submits the
  request and is designed to correctly land on `callback_required`/`manual_handoff`, not to chase
  an automated firm quote that channel type was never going to produce.
- **Voice channel.** Outbound/inbound calling is not implemented in this build. Routes that would
  normally need a phone call or callback are marked `callback_required` or `manual_handoff` with
  the public contact route recorded as evidence, instead of actually being called.
- **Residual market and mutuals — out of scope by choice, not by gap.** Facility Association and
  the Ontario Mutuals are excluded from this build. As the applicant, I already know I qualify for
  the standard market, so there's no personal need to pursue the residual market or mutual carriers
  right now — this is a scoping decision based on my own situation, not unfinished research.

## Automation reliability

- **Written, but not yet live-tested end to end.** All 5 MVP recipes are now built from a mix of
  direct live DOM verification (Rates.ca, Onlia's step 1) and screenshots — either from a
  discovery-only pass with placeholder data (Sonnet, TD Insurance, Staebler) or from my own real
  walkthrough of the full flow (Onlia's steps 2-5). None has actually been run through the real
  worker against a live site with my real vault data yet — that's the next step, and I'd
  genuinely expect some selectors to need a fix the first time they hit the real DOM rather than a
  screenshot of it.
- **Onlia's field windows differ from every other MVP site's, in two ways at once.** Like TD, it
  asks about accidents/claims over 10 years, not the 6-year OAF 1 baseline. Unlike any other MVP
  site, it also asks about prior insurance cancellations over 5 years, not the 3-year baseline —
  the vault now stores full dated cancellation history the same way it already did for
  accidents/claims, and each recipe filters to whatever window that specific site asks for via
  `lib.filterEventsWithinYears()`. Onlia also asks G1/G2/full-G licensing as ages rather than
  dates; those ages are derived from the vault's dated licensing fields against date of birth, a
  whole-years approximation.
- **Site-specific recipes are brittle by design.** Each Playwright recipe encodes a specific
  site's current form layout. If a site changes a field, adds/removes a question, or restructures
  its flow, the recipe stops at the point it no longer recognizes rather than guessing — it
  reports `blocked` or `unresolved`, not a fabricated result. Recipes are not self-healing; they
  need to be re-verified periodically, and the brief's bounded-attempt policy (one retry for a
  transient error, no retry past a rejection/CAPTCHA/terms restriction) is followed.
- **CAPTCHA / bot-detection.** A site that presents a CAPTCHA pauses the recipe (`lib.pauseForHuman()`)
  and hands off to me to solve it myself in the browser window — see `docs/ARCHITECTURE.md` §5.
  The recipe never solves or automates past one. A hard bot-detection wall with no human-solvable
  challenge still ends in `blocked`. This mechanism is real and working (used in
  `local_independent_broker.js`), but none of the other four MVP recipes have gotten far enough
  into their site's actual flow yet to exercise it — that's still pending the live-capture work
  described above, not the pause mechanism itself.
- **Panel visibility for brokers/aggregators.** Rates.ca and Onlia's returned underwriter panel can
  change over time and is only as broad as what's live and eligible for my specific profile at
  query time. Each result records the legal underwriter actually returned, not an assumed panel
  list from documentation.

## Data and identity

- **No licence, no live quote — but you get a chance to fix that mid-run.** If a route asks for a
  vault field I haven't set yet (a real Ontario licence number, or anything else — including a
  question a site asks that I didn't anticipate), `fillFromVault()` pauses rather than failing
  outright: it tells me exactly which field is missing and the exact `vault/cli.js set` command to
  run, I go set it in another terminal, then press Enter here to resume from exactly where it
  stopped — no restart needed. Only if I skip that (abort, time out, or leave it unset) does the
  route actually stop, as `manual_handoff`/`unresolved`. It never invents a value or works around
  the field. See `worker/lib/recipe_lib.js#fillFromVault`.
- **Single applicant only.** The vault and intake schema hold only my own data. No other household
  driver's information is collected, so any route requiring another driver's consent/details is
  out of scope for this build.

## Orchestration

- **n8n cloud availability.** Since orchestration is self-hosted, any downtime of that instance
  stops the pipeline; the local worker and vault are unaffected and can be run manually as a
  fallback.
- **This is a hackathon-window build.** Verification dates in the market registry reflect when
  each route was actually checked during this build, not a guarantee that panels or eligibility
  are unchanged afterward — per the brief, panel membership changes and every row needs
  re-verification over time.
