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

- **Live-tested for 2 of 5 MVP routes; 3 remain screenshot-verified only — and testing effort this
  cycle deliberately concentrated on `rates_ca`, not spread evenly.** `local_independent_broker` and
  `rates_ca` have both been run end to end through the real worker against the live site with real
  vault data; Onlia, Sonnet, and TD Insurance are still only screenshot/discovery-verified, not yet
  run against their live sites with real data — I'd genuinely expect at least one of the same
  classes of bug found below to show up there too, unconfirmed either way. That imbalance is a
  deliberate choice, not an oversight: `rates_ca` is a broker aggregator that returns a whole panel
  of carrier quotes from one route attempt (confirmed live: up to 8+ underwriters, each with its own
  premium, from a single form submission), where Onlia/Sonnet/TD Insurance are each a single direct
  writer returning exactly one premium per attempt. Hardening the one route that multiplies into
  many results outweighed spreading the same debugging effort across three routes that each only
  ever produce one — the other three remain exactly where they were, not attempted this cycle.
  Concretely, `orchestrator/profiles.json`'s `requested_routes` was temporarily narrowed to
  `["rates_ca"]` for the duration of this testing pass (that file is git-ignored, so this wouldn't
  be visible from the repo alone without saying so here) — a local testing-focus setting, not a
  permanent scope reduction; the full 5-route MVP plan is still what `market_registry.json` and the
  rest of this document describe, and resetting that file to request all five is the honest next
  step before the next full run.
  Live testing on `rates_ca` surfaced and fixed several real bugs a screenshot alone couldn't have
  caught: duplicate form markup across responsive breakpoints causing the worker to interact with a
  hidden element instead of the visible one, a submit button gated on a real `keyup` event that
  Playwright's `.fill()` never fires, a vault-only value (a postal code) that leaked into an error
  message before a site interaction was properly sanitized, a vehicle-trim dropdown whose live
  option list didn't exactly match the requested model string, a date field format assumption
  ("MM-YYYY" vs. a bare year) that hung the browser trying to select an invalid month, a
  vehicle-model selection silently reset by the site on a bounded-attempt retry pass, and (see
  below) a site that echoes the driver's own name into dynamically-generated page text in a way the
  masking mechanism didn't originally cover. All fixed in `worker/lib/recipe_lib.js` (centrally, so
  every recipe benefits) and `worker/recipes/rates_ca.js`. This same live-testing pass also reached
  a real end-to-end quote submission on Rates.ca for the first time (`status: quoted_non_comparable`,
  a "Your Quotes" results page actually returned) — the first MVP route to get that far in this
  build, and the reason a best-effort multi-carrier extractor (see below) was worth building at all.
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
  transient error, no retry past a rejection/CAPTCHA/terms restriction) is followed. Confirmed live
  on Rates.ca: a field the recipe expected (a winter tires discount question) was simply no longer
  present on the page — the recipe was looking for it purely because the code said to, not because
  it observed the page in any way. Selecting `label:has-text(...)` text over a raw internal id
  (already the pattern in `sonnet.js`/`td_insurance.js`/`onlia.js`; `rates_ca.js` was converted to
  match) helps with id churn specifically, but not with a question disappearing outright.
  - **Built this cycle, proven on one recipe: Claude-assisted live field resolution.** Rather than
    leave the above as a stated-but-unbuilt idea, it's now real: `resolve_fields`
    (`brain/tools_schema.json`), the `oqa-resolve-field` n8n webhook, and
    `worker/lib/recipe_lib.js#resolveFieldsWithBrain` let a recipe consult the brain mid-route when
    its static mapping doesn't recognize a question — sending only that question's own
    label/type/options/error text (never a value; the function has no vault access at all) and
    getting back a schema field name or a fixed strategy keyword (never a literal answer) to act
    on itself. Full design and guardrail detail in `docs/ARCHITECTURE.md` §7.5.

    The strategy set also distinguishes *administrative* questions (a date needing to fall in a
    valid range) from *disclosure* questions (driving/claims/conviction/insurance history) —
    the former can get a sensible computed default (`use_today_date`/`use_zero`); the latter never
    get defaulted in either direction, favorable or not, since an unevidenced guess on a disclosure
    question is a potential misrepresentation on an insurance application, not a helpful shortcut.
    A disclosure question either gets answered from real already-known facts (`use_inferred_value`
    — and only by picking one of that question's own disclosed options, never inventing text) or is handed to me directly (`pause_and_ask`, the same
    `lib.pauseForHuman()` mechanism already used for consent/CAPTCHA checkpoints) if it's mandatory
    and unanswerable from what's already known.

    **Scope actually covered:** the core mechanism (`use_mapped_field_value`, `use_today_date`,
    `skip_and_disclose`, `unresolved`) is wired into one real, judgment-requiring case —
    `rates_ca.js`'s vehicle purchase-date validation. `use_inferred_value` and `pause_and_ask` are
    fully built with the same guardrails and unit-tested directly (including a rejected-hallucinated-
    option case), but haven't yet been exercised by an actual live recipe call site — no run tonight
    has hit a genuinely new, unmapped disclosure-type question to trigger one for real. **Not done:**
    the other four recipes don't call any of this yet, and `rates_ca.js`'s own
    winter-tires-question-removed case stays plain local logic rather than a brain consultation
    (there's no ambiguity to resolve there — the field either exists or doesn't). Extending this to
    the other recipes, and to a more general "sweep whatever the static pass didn't handle" pattern
    rather than a few hand-picked call sites, is the honest remaining next step.
  - **Also built this cycle: brain-assisted selector rediscovery, a second call site for a
    different failure shape.** Live testing surfaced a case the mechanism above doesn't cover — not
    "what value answers this question" but "this known field's selector stopped finding its
    element" (Rates.ca's licence-type question is worded with the driver's own first name once
    entered, not the static placeholder text a selector was originally written against).
    `fillPlanningResilient`/`selectPlanningResilient` (`worker/lib/recipe_lib.js`) wrap the normal
    fill/select call: on a timeout, they scan the page's own current labels/types/options (never a
    value) and reuse the exact same `resolveFieldsWithBrain` call and guardrails to ask which
    candidate, if any, maps back to the field being filled — retrying once if something matches,
    otherwise letting the original error through unchanged. Guardrail-tested end-to-end via a
    throwaway script (happy path, no-n8n-configured fallback, full round trip, and a rejected
    wrong-field-mapping case) and wired into `rates_ca.js`'s licence-class selector as
    defense-in-depth. **Honest gap:** tonight's actual failure was fixed directly (the selector's
    text match was corrected once the real live wording was known), so this fallback's live trigger
    path — a real selector timeout resolved via an actual n8n round trip against a real page — is
    still proven only against mocks, not a real site. The other four recipes don't use it yet
    either.
  - **Also built this cycle: a site-agnostic advisory-banner detector, plus a fix for the
    destructive-retry incident it exposed.** Confirmed live, twice, in genuinely different forms:
    Rates.ca can show a non-blocking informational banner mid-route ("we estimated your annual
    usage at 8,000 km," "you got your licence 6 years before you had insurance") that isn't a
    question at all — just a confirmation prompt. `lib.checkForAdvisoryBanner`/`snapshotPageText`
    detect this by diffing the page's visible text against a snapshot taken earlier, not by
    matching against a wordlist (an earlier version tried keyword matching and only ever proved it
    recognized the one banner it was built against — corrected after direct pushback). Consults the
    brain with the new text via the same `resolve_fields` mechanism and a new `acknowledge_and_continue`
    strategy; only auto-proceeds on a confident answer, otherwise pauses for me. Resolving that
    pause by clicking the site's own Continue button (the only real way to acknowledge an inline
    banner) then exposed a second, more serious bug: the recipe would resume its own stale script
    assuming it was still on the same page, fail against elements that no longer existed, trigger a
    bounded-attempt retry, and that retry's full page reload silently destroyed everything I'd just
    done by hand up to and including the Discount Info page. `lib.classifyCheckpointNavigation` now
    distinguishes "landed exactly where the recipe's own next step was already headed" (skip the
    redundant click, keep going) from "landed somewhere unrecognized" (stop cleanly, report
    `manual_handoff`, never retry) — confirmed live to correctly handle both cases. **Not done:**
    only wired into `rates_ca.js`; the other four recipes have no equivalent protection if a human
    resolves a checkpoint there by advancing the page.
  - **Also built this cycle: best-effort multi-carrier quote extraction, unverified against a
    captured DOM contract.** Rates.ca is an aggregator that returns a whole panel from one
    submission (confirmed live: a featured carrier's Basic and Recommended packages, then up to 8
    more carriers at Basic-tier pricing only). `extractCarrierQuotes`/`extractPackageCoverageDetails`
    (`worker/recipes/rates_ca.js`) pull carrier name, price, tier, and an itemized coverage
    checklist for the two featured packages, tagging which benefits Recommended adds over Basic and
    flagging it as a variance from the benchmark when the profile requested
    `standard_mandatory_only` accident benefits. This is a heuristic built by iterating against real
    screenshots this session (matching on known carrier names in text *and* image `alt`/`src`
    attributes, since this site renders logos as images; locating price via a bounded ancestor walk;
    included/excluded via relative text-color luminance) — not a selector written against a captured
    DOM, because none was ever captured. It worked on the one live run that reached this page
    tonight; it has not been proven against a second. `run_session.js#expandCarrierQuotes` fans this
    into one comparable row per carrier for `oqa-compare`, with `price.annual_premium` set directly
    from the extraction (the brain is explicitly instructed never to restate or re-derive that
    number). The human-readable report also now opens with an explicit disclaimer that it never
    recommends which policy to choose, since "Recommended" here is Rates.ca's own package label, not
    an endorsement from this system.
- **CAPTCHA / bot-detection.** A site that presents a CAPTCHA pauses the recipe (`lib.pauseForHuman()`)
  and hands off to me to solve it myself in the browser window — see `docs/ARCHITECTURE.md` §5.
  The recipe never solves or automates past one. A hard bot-detection wall with no human-solvable
  challenge still ends in `blocked`. This mechanism is real and working (used in
  `local_independent_broker.js`), but none of the other four MVP recipes have gotten far enough
  into their site's actual flow yet to exercise it — that's still pending the live-capture work
  described above, not the pause mechanism itself.
  - **Confirmed live: Rates.ca can put the automation behind a Cloudflare challenge before it ever
    reaches the intake form, and this does not appear to be about my IP.** `lib.looksLikeBotChallenge`/
    `lib.waitForURLOrBotChallenge` (`worker/lib/recipe_lib.js`) detect the challenge (both by URL
    pattern — a `__cf_chl_rt_tk` redirect-loop token — and by the interstitial's own page text) and
    pause for me the same way any other CAPTCHA does, wired into all three of `rates_ca.js`'s page
    transitions. First version checked once, at the end of the full wait, and missed the challenge
    entirely since it cycles through several redirect hops and can settle back onto a clean-looking
    URL before a single late check ever sees it — fixed to poll in short slices throughout the wait
    instead. **Honest, harder finding:** even after that fix correctly opened the checkpoint and I
    solved the visible challenge myself, the site kept re-issuing it. Tested from a different,
    genuinely trustworthy home residential IP — still challenged from the very first attempt, which
    rules out simple IP/rate-based reputation as the main cause and points instead at something
    about the automated browser itself (most plausibly Cloudflare's Bot Management fingerprinting
    Playwright's TLS/client signature, a signal that doesn't change no matter how many times a human
    solves the visible checkbox). **Deliberately not addressed further:** the only way to reliably
    get past that would be making the automation look less automated to Cloudflare — spoofing
    fingerprint/TLS signals, browser-stealth patches, and similar techniques — which this project
    does not do, on principle, not because it wasn't considered. The existing checkpoint mechanism
    already does the right thing with this: it hands off to a real human, and if that human genuinely
    can't get past it either, `blocked` is the honest, accurate status — not a gap still waiting on a
    workaround.
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
- **Confirmed live: a real name leak, root-caused and fixed, but revealing a gap that isn't fully
  closed.** Rates.ca personalizes several Driver Info questions with the driver's own first name
  once typed in (e.g. "How old was `<name>` when first licensed?"). The worker's masking only
  covers the specific input selectors it fills, not every place a site echoes that value back into
  its own generated text — so that name appeared, unmasked, in several evidence screenshots this
  session (manually caught in pre-push review, redacted, re-verified before committing) and, once,
  in the `resolve_fields` mid-route brain consultation itself: `worker/lib/recipe_lib.js`'s
  scan-the-page-structure helpers (`scanVisibleFormQuestions`, `extractVisibleTextBlocks`) assume a
  site's own label text is inherently `planning_safe`-shaped, and the input guardrail that's
  supposed to catch a sensitive-looking value before it leaves the worker only pattern-matches
  email/phone/postal-code/long-digit shapes — a plain name in ordinary prose matches none of those,
  so it wasn't blocked, and it reached n8n and Claude via the API. **Not done:** the guardrail still
  doesn't check outbound structural text against the applicant's own already-typed vault values, so
  the same gap could recur on Rates.ca or any other site with similar personalization, and the fix
  applied tonight was catching and redacting the specific evidence files affected, not closing the
  underlying detection gap. Extending the guardrail to check candidate text against values the
  recipe has itself already typed onto the page this run — without ever passing the guardrail a raw
  value to compare against — is the honest next step.

## Orchestration

- **n8n cloud availability.** Since orchestration is self-hosted, any downtime of that instance
  stops the pipeline; the local worker and vault are unaffected and can be run manually as a
  fallback.
- **This is a hackathon-window build.** Verification dates in the market registry reflect when
  each route was actually checked during this build, not a guarantee that panels or eligibility
  are unchanged afterward — per the brief, panel membership changes and every row needs
  re-verification over time.
