'use strict';
/**
 * Rates.ca — aggregator route. registry_id: rates_ca (MVP).
 *
 * Originally verified live on 2026-08-12 via a discovery-only pass using
 * placeholder data (never a real applicant), walking Vehicle Info → Driver
 * Info → Discount Info. Re-verified live again the same day after real
 * end-to-end runs surfaced several bugs no screenshot would have caught —
 * see worker/lib/recipe_lib.js's :visible/keyup fixes and
 * docs/KNOWN_LIMITATIONS.md. Stopped deliberately at the consent checkbox on
 * the Discount Info page — never checked it, never clicked "Get Free
 * Quotes" — since that checkbox is a consent attestation under the brief's
 * own rule ("pause before any identity lookup, consent attestation,
 * signature, payment or purchase action"), not something this recipe
 * decides on my behalf. See the pauseForHuman() call below.
 *
 * SELECTOR STRATEGY: this recipe uses label-text selectors
 * (`label:has-text("...") ~ select/input`), not raw internal ids, for every
 * field confirmed live in the second verification pass — matching the
 * pattern already used in sonnet.js/td_insurance.js/onlia.js. Confirmed
 * live that this site duplicates form markup across responsive breakpoints
 * (the same id can appear on 3 elements), which label text sidesteps for
 * the id-churn case, though not for a question moving or disappearing
 * outright (see the winter-tires handling below, and
 * docs/KNOWN_LIMITATIONS.md's stated-next-step note on Claude-assisted live
 * field matching). A few fields remain id-based, explicitly marked below,
 * where live label text wasn't confirmed this pass (the >0-events history
 * sub-flow, policy-start-date0) or where the field is conditionally hidden
 * rather than simply labeled (has-driver-education0).
 *
 * CONFIRMED LIVE LABEL TEXT, in flow order:
 *   1. https://rates.ca/ — postal code input (`#postal-code-input:visible`,
 *      no stable label; id kept — every duplicate across breakpoints has
 *      the same placeholder, not distinguishing label text), Get Quotes
 *      button (`#submitBtn:visible`) -> navigates to
 *      ratesinsuranceservices.rates.ca/autoquote/on/vehicle.
 *   2. Vehicle Info: "Vehicle year" -> "Vehicle make" -> "Vehicle model"
 *      (cascading — each unlocks the next; vehicle-model0's options are
 *      full trim strings, e.g. "CIVIC LX 4DR", not a plain model name — see
 *      pickBestModelOption() for the fuzzy match this requires), "Is the
 *      vehicle financed or leased?", "Vehicle purchase date" (one label
 *      over two selects, addressed by position), "Where is this vehicle
 *      parked overnight?", "Do you plan to or currently have any anti-theft
 *      devices installed?" (present but not yet mapped to a schema field —
 *      same documented gap as before), "What is the primary use of this
 *      vehicle?", "How many kilometres are driven to work or school one way
 *      (each day)?", "How many total kilometres are driven each year?",
 *      "Comprehensive Coverage", "Collision Coverage". CONFIRMED LIVE: no
 *      winter-tires question exists on this page at all anymore — the
 *      original recipe's `#winter-tires0` selector was a stale assumption,
 *      not something the site ever surfaced during this pass. Handled by
 *      skipping gracefully and noting the gap rather than failing the route.
 *   3. Driver Info: "First name", "Last name", "Date of birth" (one label,
 *      three selects by position), "Gender", "Marital status",
 *      "Occupational status", "What type of licence does [name] currently
 *      hold?", "Did [name] previously hold a full licence elsewhere in
 *      Canada or the U.S.?", "How old was [name] when he or she was first
 *      licensed in Ontario?", "G licence date" (one label, two selects),
 *      then "When was [name] first listed as a driver on an insurance
 *      policy..." and "How long has [name] been with their current
 *      insurance company?" — CONFIRMED LIVE: all of these labels are
 *      dynamically generated to include the entered first name once it's
 *      filled (not a static "Driver #1" placeholder as first assumed), so
 *      every one is matched here on a stable substring rather than the full
 *      text. has-driver-education0 is CONFIRMED conditionally hidden (its
 *      container is display:none until
 *      some other condition is met, not simply absent) — kept id-based with
 *      a graceful skip, unlike winter-tires which is confirmed genuinely
 *      gone. The cancellations/suspensions/accidents/tickets history
 *      questions and policy-start-date0 remain id-based below — only the
 *      "0 events" path was exercised live this pass; the same
 *      not-yet-live-verified caveat from before still applies to the >0
 *      path and these labels specifically.
 *   4. Discount Info: bundle-discount radio group (the "No, I don't want
 *      this discount" option, confirmed via its own label text), "...member
 *      of CAA" (substring), "...scores your driving habits" (substring,
 *      telematics), "...provide your email address..." (substring),
 *      "Phone number", then the consent checkbox (confirmed via its own "I
 *      agree" label) and "Get Free Quotes" button — both left to me, per
 *      the pauseForHuman() checkpoint below.
 */

const OCCUPATION_CODES = {
  employed: '998',
  unemployed: '800',
  student: '700',
  retired: '640',
};

/**
 * vehicle-model0's options are full trim strings (e.g. "CIVIC LX 4DR"), so a
 * requested model like "Civic 4dr" rarely matches exactly or even as a
 * prefix — the trim code sits in the middle. Rather than hard-failing the
 * whole route over an inexact trim match (confirmed live: this happened for
 * a real profile), this tries progressively looser matches and always
 * returns which tier it used, so the recipe can be honest in its result
 * about a substitution rather than silently treating it as exact. Only
 * throws if nothing even matches the base model name (first word) — that
 * case would mean picking a genuinely different vehicle, which is a real
 * failure, not an imprecise trim.
 */
async function pickBestModelOption(page, requestedModel) {
  // getElementById always returns the first match in document order, which
  // may not be the visible one if this id is duplicated across responsive
  // breakpoints (confirmed live for other fields on this page) — filter to
  // the actually-visible element instead. Selected by label text below;
  // options are still read via the DOM directly since building the full
  // trim list isn't something selectOption's own matching can fuzzy-match.
  const result = await page.evaluate((wanted) => {
    const labels = Array.from(document.querySelectorAll('label')).filter((l) => l.textContent.trim() === 'Vehicle model');
    const label = labels.find((l) => l.closest('div')?.querySelector('select')?.offsetParent !== null) || labels[0];
    const el = label ? label.closest('div')?.querySelector('select') : null;
    if (!el) return null;
    const options = Array.from(el.options).filter((o) => o.value);
    const wantedUpper = String(wanted).toUpperCase().trim();
    const words = wantedUpper.split(/\s+/).filter(Boolean);

    let match = options.find((o) => o.value.toUpperCase().trim() === wantedUpper);
    if (match) return { value: match.value, text: match.textContent.trim(), tier: 'exact' };

    match = options.find((o) => o.value.toUpperCase().startsWith(wantedUpper));
    if (match) return { value: match.value, text: match.textContent.trim(), tier: 'prefix' };

    // Every word from the request appears somewhere in the option (any
    // order), e.g. requested "CIVIC 4DR" matches option "CIVIC LX 4DR".
    match = options.find((o) => words.every((w) => o.value.toUpperCase().includes(w)));
    if (match) return { value: match.value, text: match.textContent.trim(), tier: 'partial_word_match' };

    // Last resort: same base model name (first word) only — still the
    // right vehicle model, just an unconfirmed trim.
    match = options.find((o) => words[0] && o.value.toUpperCase().includes(words[0]));
    if (match) return { value: match.value, text: match.textContent.trim(), tier: 'base_model_only' };

    return null;
  }, requestedModel);

  if (!result) {
    throw new Error(`No vehicle-model option matches even the base model name in "${requestedModel}" — model list may have changed.`);
  }
  const selector = 'label:has-text("Vehicle model") ~ * select:visible, label:has-text("Vehicle model") ~ select:visible';
  await page.selectOption(selector, result.value);

  // Confirmed live: on a bounded-attempt retry pass (the whole recipe
  // re-running on the same page after an earlier failure), this selection
  // can get silently reset moments later - plausibly the site re-populating
  // the model list right after the Make change fires, racing this call. A
  // single selectOption isn't enough to trust here; re-read the live value
  // after a brief settle and reselect once if the site reset it.
  await page.waitForTimeout(300);
  const currentValue = await page.evaluate(() => {
    const labels = Array.from(document.querySelectorAll('label')).filter((l) => l.textContent.trim() === 'Vehicle model');
    const label = labels.find((l) => l.closest('div')?.querySelector('select')?.offsetParent !== null) || labels[0];
    const el = label ? label.closest('div')?.querySelector('select') : null;
    return el ? el.value : null;
  });
  if (currentValue !== result.value) {
    await page.selectOption(selector, result.value);
  }

  return result;
}

// Confirmed live in the underwriter-logo footer shown throughout the
// quoting flow ("Compare car insurance from companies you trust") - the
// panel this site draws from. Used to recognize a carrier name next to a
// price on the results page; not exhaustive of every possible underwriter
// Rates.ca could ever return, so a carrier outside this list would be
// missed rather than mismatched - an honest gap, not a wrong result.
const KNOWN_CARRIER_NAMES = [
  'CAA', 'SGI Canada', 'SGI', 'Aviva', 'Sonnet', 'Economical', 'Pembridge',
  'Gore Mutual', 'Wawanesa', 'Definity', 'Intact', 'belairdirect',
  'TD Insurance', 'TD', 'Desjardins', 'Optimum', 'Travelers', 'Chubb',
  'Co-operators', 'Co-op', 'Northbridge', 'Portage', 'Heartland',
];

function parsePremiumToAnnual(text) {
  const numMatch = text.match(/\$\s*([\d,]+(?:\.\d{2})?)/);
  if (!numMatch) return null;
  const amount = parseFloat(numMatch[1].replace(/,/g, ''));
  if (Number.isNaN(amount)) return null;
  const isMonthly = /\/\s*(month|mo)\b/i.test(text);
  return Math.round(isMonthly ? amount * 12 : amount);
}

/**
 * Best-effort extraction of the multi-carrier breakdown Rates.ca's "Your
 * Quotes" results page returns (confirmed live: a "Basic"/"Recommended"
 * package pair from one carrier at the top, then an "Other Basic Quotes"
 * list below with one premium per carrier). Confirmed live: carrier names
 * on this page render as logo images, not plain text - an earlier version
 * of this function scanned only visible text and found nothing at all, an
 * empty-handed but honest result rather than a wrong one. This version
 * anchors on either a text match OR an <img> whose alt/title/src names a
 * known carrier, then walks up a bounded number of ancestors from that
 * anchor looking for the nearest price - matching the actual logo-next-to-
 * price layout confirmed live, rather than assuming carrier name and price
 * always share one text node. Still a generic heuristic, not a selector
 * built against a captured DOM - returns an empty array rather than
 * guessing if nothing matches, since a wrong number is worse than none for
 * a real financial figure.
 */
async function extractCarrierQuotes(page) {
  const raw = await page.evaluate((carrierNames) => {
    const isVisible = (el) => {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    // Confirmed live: exact word-boundary matching missed real cases -
    // a logo src slug uses hyphens ("gore-mutual.svg"), and this site's own
    // stylized display text splits "Pembridge" into "PEM BRIDGE". Comparing
    // with whitespace/hyphens/underscores stripped from both sides catches
    // both without needing to hardcode every stylistic variant.
    const normalize = (s) => (s || '').toLowerCase().replace(/[\s\-_]+/g, '');
    const matchesCarrier = (text) => {
      const normText = normalize(text);
      if (!normText) return null;
      return carrierNames.find((c) => normText.includes(normalize(c))) || null;
    };
    const priceRe = /\$\s*[\d,]+(?:\.\d{2})?(?:\s*\/\s*(?:year|yr|month|mo))?/i;

    const imgAnchors = Array.from(document.querySelectorAll('img'))
      .filter(isVisible)
      .map((el) => ({
        el,
        carrierName: matchesCarrier(el.getAttribute('alt')) || matchesCarrier(el.getAttribute('title')) || matchesCarrier(el.getAttribute('src') || ''),
      }))
      .filter((a) => a.carrierName);

    const textAnchors = Array.from(document.querySelectorAll('div, span, p, a, li, h1, h2, h3, h4'))
      .filter(isVisible)
      .filter((el) => el.children.length === 0)
      .map((el) => ({ el, carrierName: matchesCarrier(el.textContent) }))
      .filter((a) => a.carrierName);

    const results = [];
    const usedRows = new Set();
    for (const anchor of [...imgAnchors, ...textAnchors]) {
      let node = anchor.el;
      let priceText = null;
      let rowMarker = null;
      for (let depth = 0; depth < 8 && node; depth += 1) {
        const m = (node.textContent || '').match(priceRe);
        if (m) {
          priceText = m[0];
          rowMarker = node;
          break;
        }
        node = node.parentElement;
      }
      if (!priceText || !rowMarker || usedRows.has(rowMarker)) continue;
      usedRows.add(rowMarker);

      // The two featured package cards at the top of this site are each
      // labelled "Basic Coverage"/"Recommended Coverage" - bounded ancestor
      // check from the row itself, not a page-wide search, so an unrelated
      // mention elsewhere on the page doesn't mis-tag every entry. The
      // "Other Basic Quotes" list below never matches either label within
      // this bounded distance - it's tagged 'basic' afterward instead,
      // matching that section's own heading.
      let packageTier = null;
      let checkNode = rowMarker;
      for (let d = 0; d < 4 && checkNode; d += 1) {
        const t = checkNode.textContent || '';
        if (/\brecommended\b/i.test(t)) { packageTier = 'recommended'; break; }
        if (/\bbasic\b/i.test(t)) { packageTier = 'basic'; break; }
        checkNode = checkNode.parentElement;
      }

      results.push({ underwriter: anchor.carrierName, price_text: priceText, package_tier: packageTier });
    }

    const seen = new Set();
    const out = [];
    for (const r of results) {
      const key = `${r.underwriter.toLowerCase()}|${r.price_text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // Anything that didn't match "recommended" within its own card is
      // basic-tier on this site (there are only these two tiers) -
      // confirmed live for the "Other Basic Quotes" list, which never
      // carries its own per-row "basic" label at all.
      out.push({ ...r, package_tier: r.package_tier === 'recommended' ? 'recommended' : 'basic' });
      if (out.length >= 15) break;
    }
    return out;
  }, KNOWN_CARRIER_NAMES);

  return raw.map((r) => ({
    underwriter: r.underwriter,
    annual_premium: parsePremiumToAnnual(r.price_text),
    is_recommended: r.package_tier === 'recommended',
    package_tier: r.package_tier,
  }));
}

/**
 * Best-effort itemized coverage checklist for the two featured "Basic
 * Coverage"/"Recommended Coverage" package cards (confirmed live: a list
 * of benefit lines - Income Replacement, Death benefits, Caregiver
 * benefits, etc. - each visually shown as included or excluded per
 * package; the "Other Basic Quotes" list below doesn't show this level of
 * detail at all, only carrier + price). `included` is a heuristic based on
 * each line's text color relative to the darkest text in its own card
 * (excluded items are visually greyed out) - not a confirmed DOM contract,
 * so treated as informative, not authoritative; the evidence screenshot is
 * the real source of truth if this disagrees with what a person sees.
 */
async function extractPackageCoverageDetails(page) {
  return page.evaluate(() => {
    const isVisible = (el) => {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const priceRe = /\$\s*[\d,]+(?:\.\d{2})?\s*\/\s*(?:month|year|mo|yr)/i;
    const headingEls = Array.from(document.querySelectorAll('*'))
      .filter(isVisible)
      .filter((el) => el.children.length === 0)
      .filter((el) => /^(basic coverage|recommended coverage)$/i.test((el.textContent || '').trim()));

    const luminance = (el) => {
      const c = window.getComputedStyle(el).color;
      const m = c && c.match(/\d+(\.\d+)?/g);
      if (!m || m.length < 3) return null;
      const [r, g, b] = m.map(Number);
      return 0.299 * r + 0.587 * g + 0.114 * b;
    };

    const cards = [];
    for (const heading of headingEls) {
      const tier = /recommended/i.test(heading.textContent) ? 'recommended' : 'basic';
      // Walk up from the heading to the card container - the smallest
      // ancestor that also contains a price, matching the same card-level
      // scoping used for carrier/price pairing above.
      let card = heading;
      for (let d = 0; d < 8 && card; d += 1) {
        if (priceRe.test(card.textContent || '')) break;
        card = card.parentElement;
      }
      if (!card) continue;

      const leaf = Array.from(card.querySelectorAll('*')).filter((el) => el.children.length === 0 && isVisible(el));
      const items = leaf
        .map((el) => ({ text: (el.textContent || '').trim(), el }))
        .filter((x) => x.text && x.text.length > 3 && x.text.length < 80)
        .filter((x) => !priceRe.test(x.text))
        .filter((x) => !/^(basic coverage|recommended coverage|buy online now)$/i.test(x.text));

      const lums = items.map((x) => luminance(x.el)).filter((l) => l != null);
      if (lums.length === 0) {
        cards.push({ tier, coverage_items: items.map((x) => ({ label: x.text, included: null })) });
        continue;
      }
      const darkest = Math.min(...lums);
      const threshold = darkest + 40;
      const coverage_items = items.map((x) => {
        const l = luminance(x.el);
        return { label: x.text, included: l == null ? null : l <= threshold };
      });
      cards.push({ tier, coverage_items });
    }
    return cards;
  });
}

module.exports = {
  meta: {
    registryId: 'rates_ca',
    entryUrl: 'https://rates.ca/',
  },

  async run(page, ctx) {
    const { lib, params, vaultPassphrase, routeId, runId, n8nBaseUrl } = ctx;
    const maskSelectors = [];
    const gapNotes = [];

    // ---- Entry: postal code ----
    // Confirmed live: #postal-code-input matches 3 elements on this page,
    // not 1 — plausibly duplicate markup across responsive breakpoints.
    // Playwright's default "first match" picked a non-visible one and timed
    // out waiting for it to become interactable. :visible filters to the
    // one actually on screen. No stable label text distinguishes the 3
    // duplicates (same placeholder on each), so this one stays id-based.
    await page.goto(module.exports.meta.entryUrl, { waitUntil: 'domcontentloaded' });
    await lib.fillFromVault(page, '#postal-code-input:visible', 'primary_address.postal_code', vaultPassphrase);
    maskSelectors.push('#postal-code-input:visible');
    await page.click('#submitBtn:visible');
    // Confirmed live: Rates.ca can show a Cloudflare bot-detection
    // interstitial right here instead of loading Vehicle Info - a plain
    // waitForURL just times out against it. This waits, then pauses for a
    // human to clear it in the visible browser window if that's what's
    // actually happening, rather than failing outright.
    await lib.waitForURLOrBotChallenge(page, '**/autoquote/on/vehicle');
    // Baseline for checkForAdvisoryBanner's diff below - nothing filled in
    // on this page yet, so anything that appears later is genuinely new.
    await lib.snapshotPageText(page);

    // ---- Vehicle Info ----
    // These waits are for the cascading select's options to finish loading
    // (year unlocks make, make unlocks model) — the default waitForSelector
    // state is 'visible', which an <option> inside a closed <select> never
    // satisfies, so this would time out unconditionally regardless of the
    // site. 'attached' (present in the DOM) is the correct check here.
    await lib.selectPlanning(page, 'label:has-text("Vehicle year") ~ select', String(params['vehicle_identity.model_year']));
    await page.waitForSelector('label:has-text("Vehicle make") ~ * select:visible option:not([value=""]), label:has-text("Vehicle make") ~ select:visible option:not([value=""])', { state: 'attached' });
    await lib.selectPlanning(page, 'label:has-text("Vehicle make") ~ select', String(params['vehicle_identity.make']).toUpperCase());
    await page.waitForSelector('label:has-text("Vehicle model") ~ * select:visible option:not([value=""]), label:has-text("Vehicle model") ~ select:visible option:not([value=""])', { state: 'attached' });
    const modelMatch = await pickBestModelOption(page, params['vehicle_identity.model']);

    if (params['ownership.owned_or_leased']) {
      const leaseMap = { owned: '0', leased: '1', financed: '2' };
      await lib.selectPlanning(page, 'label:has-text("Is the vehicle financed or leased?") ~ select', leaseMap[params['ownership.owned_or_leased']] || '0');
    }
    if (params['ownership.purchase_or_lease_month_year']) {
      // Format: MM-YYYY, matching the same field's parsing in
      // sonnet.js/td_insurance.js (onlia.js assumes YYYY-MM instead — a
      // pre-existing inconsistency across recipes, not something
      // introduced here; not resolved in this pass since it's a separate,
      // broader question of which format the vault actually stores and is
      // out of scope for tonight's fix).
      const [pMonth, pYearStr] = String(params['ownership.purchase_or_lease_month_year']).split('-');
      const pYear = Number(pYearStr);
      // Confirmed live: this site rejects (resets to blank + shows an
      // error) any purchase date more than 60 days in the past — it's
      // asking specifically about a recent purchase, not vehicle
      // ownership history in general. Filling the real (usually older)
      // vault date just gets silently rejected and blocks Continue, so
      // this only fills when the real date actually qualifies.
      const purchaseDate = pMonth && pYear ? new Date(pYear, Number(pMonth) - 1, 1) : null;
      const daysSincePurchase = purchaseDate ? (Date.now() - purchaseDate.getTime()) / 86400000 : Infinity;
      if (purchaseDate && daysSincePurchase <= 60) {
        await lib.selectPlanning(page, 'label:has-text("Vehicle purchase date") ~ * select >> nth=0', String(Number(pMonth)));
        await lib.selectPlanning(page, 'label:has-text("Vehicle purchase date") ~ * select >> nth=1', String(pYear));
      } else if (purchaseDate) {
        // A real vault value exists, but this site's own constraint means
        // it can never be entered as-is — genuinely a judgment call
        // (skip vs. a reasonable default), not a static mapping problem.
        // Consult the brain rather than hardcoding one answer: it only
        // ever sees this question's label/type/error text, never the
        // actual purchase date.
        const [resolution] = await lib.resolveFieldsWithBrain([{
          question_id: 'vehicle_purchase_date',
          label: 'Vehicle purchase date',
          field_type: 'date_group (Month select + Year select)',
          options: null,
          error_text: 'Please select a vehicle purchase date that is no further than 60 days from today.',
          is_mandatory: true,
        }], { n8nBaseUrl, routeId, runId, profileContext: params });

        // Handled generically rather than only the one strategy expected
        // for this question — an administrative date constraint shouldn't
        // realistically come back use_inferred_value/pause_and_ask (the
        // output guardrail forces use_inferred_value to unresolved anyway
        // here, since this question has no options list to validate
        // against), but the recipe shouldn't silently drop a resolution it
        // doesn't recognize either.
        if (resolution.strategy === 'use_today_date') {
          const today = new Date();
          await lib.selectPlanning(page, 'label:has-text("Vehicle purchase date") ~ * select >> nth=0', String(today.getMonth() + 1));
          await lib.selectPlanning(page, 'label:has-text("Vehicle purchase date") ~ * select >> nth=1', String(today.getFullYear()));
          gapNotes.push(`Vehicle purchase date: used today's date to satisfy Rates.ca's requirement — the real purchase date on file doesn't qualify (${resolution.reason || 'more than 60 days ago'}).`);
        } else if (resolution.strategy === 'pause_and_ask') {
          await lib.pauseForHuman(
            `The brain flagged "Vehicle purchase date" as needing your input rather than a guess: ${resolution.reason || 'no confident answer available'}. ` +
              'Fill it in yourself in the browser window if you can, then press Enter to continue — or leave it and press Enter to proceed without it.'
          );
          gapNotes.push(`Vehicle purchase date: paused for human input — ${resolution.reason || 'the brain judged this shouldn\'t be answered automatically'}.`);
        } else {
          gapNotes.push(`Vehicle purchase date left blank — ${resolution.reason || "the real purchase date on file doesn't satisfy this site's 60-day requirement, and no fallback was resolved"}.`);
        }
      }
    }
    // Confirmed live (2026-08-12, second pass): this question no longer
    // exists on the page at all — not an id change, genuinely gone. Skipped
    // rather than failing the whole route; noted honestly in the result
    // rather than silently treated as "no" the way it was before.
    // Confirmed live: the label text matches a hidden duplicate (same
    // responsive-breakpoint duplication seen elsewhere on this page) even
    // when the question is genuinely absent from the visible page — must
    // check :visible specifically, not just presence anywhere in the DOM.
    const winterTiresCount = await page.locator('label:has-text("Winter tires"):visible').count().catch(() => 0);
    if (winterTiresCount > 0) {
      await lib.selectPlanning(page, 'label:has-text("Winter tires") ~ select', params['risk_details.winter_tires'] ? '1' : '0');
    } else {
      gapNotes.push('The winter tires discount question no longer appears on Rates.ca\'s Vehicle Info page (confirmed absent, not just an automation gap) — winter tire status could not be communicated to this site.');
    }
    if (params['risk_details.overnight_parking_location']) {
      await lib.selectPlanning(page, 'label:has-text("Where is this vehicle parked overnight?") ~ select', params['risk_details.overnight_parking_location']);
    }
    // Anti-theft checkboxes exist but aren't yet mapped to a schema field —
    // left unchecked (matches "No" default), a real gap if that discount
    // matters to the comparison.
    await lib.selectPlanning(page, 'label:has-text("What is the primary use of this vehicle?") ~ select', params['use.use_type'] === 'business' ? 'business' : 'personal');
    // != null (not a plain truthy check): confirmed live that a real 0 here
    // (e.g. working from home) was being treated as "not provided" and
    // skipped, even though the site requires an answer either way.
    if (params['use.one_way_commute_distance'] != null) {
      await lib.selectPlanning(page, 'label:has-text("How many kilometres are driven to work or school one way") ~ select', String(params['use.one_way_commute_distance']));
    }
    if (params['use.annual_kilometres'] != null) {
      await lib.selectPlanning(page, 'label:has-text("How many total kilometres are driven each year?") ~ select', String(params['use.annual_kilometres']));
    }
    const ownDamage = String(params['coverage_configuration.own_damage_coverage'] || '');
    await lib.selectPlanning(page, 'label:has-text("Comprehensive Coverage") ~ select', /comprehensive/i.test(ownDamage) ? '1' : '0');
    await lib.selectPlanning(page, 'label:has-text("Collision Coverage") ~ select', /collision/i.test(ownDamage) ? '1' : '0');

    // See the matching check before the Driver Info -> Discount Info
    // Continue click below for why this is here (site-agnostic advisory-
    // banner detection, near-zero cost when nothing matches).
    let vehiclePageAlreadyAdvanced = false;
    const vehicleBannerCheck = await lib.checkForAdvisoryBanner(page, { ctx: { n8nBaseUrl, routeId, runId }, gapNotes });
    if (vehicleBannerCheck.resolutions.length && !vehicleBannerCheck.handled) {
      const urlBeforeVehicleCheckpoint = page.url();
      await lib.pauseForHuman(vehicleBannerCheck.pauseMessage);
      // Confirmed live: clicking the site's own Continue button IS the
      // correct, expected way to resolve an inline banner checkpoint (no
      // separate dismiss control exists) - that single click landing on
      // exactly the page this recipe was already headed to next is not a
      // takeover, so skip the now-redundant click/wait below and continue
      // straight into Driver Info. Only a genuinely unrecognized landing
      // page means the human went further than resolving this checkpoint -
      // that's the only case worth stopping for.
      const navResult = lib.classifyCheckpointNavigation(page, urlBeforeVehicleCheckpoint, '/autoquote/on/driver');
      if (navResult === 'unexpected') {
        return {
          status: lib.STATUS.MANUAL_HANDOFF,
          failure_reason: null,
          outcome: {
            next_action: 'The page ended up somewhere this recipe did not recognize after a human checkpoint on the Vehicle Info page - looks like more of the flow was driven manually than just resolving that one checkpoint. Automation stopped here rather than running stale scripted steps against an unexpected page - check the browser window directly for whatever was reached.',
          },
          maskSelectors,
        };
      }
      vehiclePageAlreadyAdvanced = navResult === 'advanced_as_expected';
    }

    if (!vehiclePageAlreadyAdvanced) {
      await page.click('button:has-text("Continue"):visible');
      await lib.waitForURLOrBotChallenge(page, '**/autoquote/on/driver');
    }
    // Fresh baseline for the Driver Info page's own advisory-banner checks.
    await lib.snapshotPageText(page);

    // ---- Driver Info ----
    // legal_name/date_of_birth/gender are each ONE vault field but need
    // splitting across multiple selects here — read the raw value directly
    // (readVaultValue carries the same missing-field pause as fillFromVault)
    // rather than forcing it through an unrelated page field as scratch
    // storage, which risks tripping that field's own validation/side effects.
    // These are vault_only values resolved locally (split/derived here rather
    // than read fresh per-field), so they go through fillSensitive/
    // selectSensitive — same :visible scoping and sanitized-error protection
    // as fillFromVault/selectFromVault, just without re-reading the vault.
    const fullName = await lib.readVaultValue('identity.legal_name', vaultPassphrase);
    const spaceIdx = fullName.indexOf(' ');
    const first = spaceIdx === -1 ? fullName : fullName.slice(0, spaceIdx);
    const last = spaceIdx === -1 ? '' : fullName.slice(spaceIdx + 1);
    await lib.fillSensitive(page, 'label:has-text("First name") ~ input', first, 'identity.legal_name (first)');
    await lib.fillSensitive(page, 'label:has-text("Last name") ~ input', last, 'identity.legal_name (last)');

    // Expected vault format: YYYY-MM-DD.
    const dobRaw = await lib.readVaultValue('identity.date_of_birth', vaultPassphrase);
    const [dobYear, dobMonth, dobDay] = String(dobRaw).split('-');
    if (dobYear && dobMonth && dobDay) {
      await lib.selectSensitive(page, 'label:has-text("Date of birth") ~ * select >> nth=0', String(Number(dobMonth)), 'identity.date_of_birth (month)');
      await lib.selectSensitive(page, 'label:has-text("Date of birth") ~ * select >> nth=1', String(Number(dobDay)), 'identity.date_of_birth (day)');
      await lib.selectSensitive(page, 'label:has-text("Date of birth") ~ * select >> nth=2', dobYear, 'identity.date_of_birth (year)');
    }

    const genderValue = await lib.readVaultValue('identity.gender_field_as_required_by_form', vaultPassphrase);
    if (genderValue) {
      const g = String(genderValue).toUpperCase();
      await lib.selectSensitive(page, 'label:has-text("Gender") ~ select', g.startsWith('F') ? 'F' : g.startsWith('M') ? 'M' : 'X', 'identity.gender_field_as_required_by_form');
    }

    if (params['identity.marital_status']) {
      const maritalMap = { single: 'single', married: 'married' };
      await lib.selectPlanning(page, 'label:has-text("Marital status") ~ select', maritalMap[params['identity.marital_status']] || 'other');
    }
    if (params['identity.occupational_status']) {
      const code = OCCUPATION_CODES[String(params['identity.occupational_status']).toLowerCase()];
      if (code) await lib.selectPlanning(page, 'label:has-text("Occupational status") ~ select', code);
    }
    if (params['licence_identity.class']) {
      const classMap = { G1: 'provisional', G2: 'probationary', G: 'full' };
      // Label is dynamically generated to include the entered first name
      // ("What type of licence does <name> currently hold?"), same as the
      // "first listed as a driver" / "been with their current insurance
      // company" fields below - matched on a stable substring, not "Driver".
      // Wrapped in the resilient variant as defense-in-depth: if this
      // substring match itself ever stops matching (a further wording
      // change), the brain gets one shot at re-identifying the right select
      // from the page's own current structure before the route fails -
      // rather than needing another hand-patched selector next time.
      await lib.selectPlanningResilient(
        page,
        'label:has-text("What type of licence does") ~ select',
        classMap[params['licence_identity.class']] || 'full',
        { schemaField: 'licence_identity.class', ctx: { n8nBaseUrl, routeId, runId } }
      );
    }
    await lib.selectPlanning(page, 'label:has-text("previously hold a full licence") ~ select', params['licensing_timeline.out_of_country_experience_recognized'] ? '1' : '0');
    if (params['licensing_timeline.first_licensed_age']) {
      await lib.fillPlanning(page, 'label:has-text("first licensed in Ontario") ~ input', String(params['licensing_timeline.first_licensed_age']));
    }
    if (params['licensing_timeline.g_date_or_year']) {
      // Field name is "_date_or_year" deliberately - a bare 4-digit year is
      // valid input, not just "MM-YYYY". Blindly splitting on "-" treated a
      // bare year ("2016") as the month half, which doesn't exist as an
      // option (1-12) and hung the select until it timed out. Only fill the
      // month select when a real month is actually on file; a year-only
      // value fills just the year and leaves month at the site's own
      // default, disclosed honestly rather than guessing a month we don't
      // have on record.
      const raw = String(params['licensing_timeline.g_date_or_year']);
      const monthYearMatch = raw.match(/^(\d{1,2})-(\d{4})$/);
      if (monthYearMatch) {
        await lib.selectPlanning(page, 'label:has-text("G licence date") ~ * select >> nth=0', String(Number(monthYearMatch[1])));
        await lib.selectPlanning(page, 'label:has-text("G licence date") ~ * select >> nth=1', monthYearMatch[2]);
      } else {
        const yearOnly = raw.match(/^\d{4}$/) ? raw : raw.slice(0, 4);
        await lib.selectPlanning(page, 'label:has-text("G licence date") ~ * select >> nth=1', yearOnly);
        gapNotes.push('G licence date: only a year was on file (no month), so the month field was left at the site\'s own default and only the year was set.');
      }
    }
    // Confirmed live: this field is conditionally hidden (its container is
    // display:none until some other condition is met), not simply absent
    // like winter-tires — kept id-based since no visible label text exists
    // to match while hidden, and skipped gracefully rather than failing.
    const driverEdCount = await page.locator('#has-driver-education0:visible').count().catch(() => 0);
    if (driverEdCount > 0) {
      await lib.selectPlanning(page, '#has-driver-education0', params['training.approved_driver_training_completed'] ? '1' : '0');
    } else {
      gapNotes.push('The driver education discount question was not visible for this profile (Rates.ca shows it conditionally) — could not communicate driver training status to this site.');
    }
    if (params['current_insurance.first_insured_year']) {
      // Label is dynamically generated to include the entered first name
      // ("When was <name> first listed..."), so matched on a stable
      // substring rather than the full text.
      await lib.selectPlanning(page, 'label:has-text("first listed as a driver on an insurance policy") ~ select', String(params['current_insurance.first_insured_year']));
    }
    if (params['current_insurance.years_continuously_insured'] != null) {
      // Same dynamic-name-in-label situation as first_insured_year above.
      const opts = await page.evaluate(() => {
        const labels = Array.from(document.querySelectorAll('label')).filter((l) => /been with their current insurance company/i.test(l.textContent));
        const label = labels.find((l) => l.closest('div')?.querySelector('select')?.offsetParent !== null) || labels[0];
        const el = label ? label.closest('div')?.querySelector('select') : null;
        return el ? Array.from(el.options).map((o) => o.value) : [];
      });
      if (opts.length > 1) await lib.selectPlanning(page, 'label:has-text("been with their current insurance company") ~ select', opts[1]);
    }

    // Confirmed live: setting first_insured_year can trigger a dynamic
    // advisory banner right here ("We noticed that you received your
    // licence N years before you had insurance - if this is correct,
    // please continue with the form"), which inserts new content directly
    // above the very next section and shifts the page layout. That's the
    // likely cause of a click immediately after this point timing out
    // waiting for a now-moved element to stabilize. The banner render
    // itself appears to be asynchronous (a check run immediately after
    // setting the field found nothing, yet the click right after still
    // failed) - a brief settle wait here before snapshotting/diffing gives
    // the site's own reactive rendering a chance to actually appear before
    // being checked, rather than only right before the final page-
    // transition Continue click below.
    await page.waitForTimeout(800);
    let driverHistorySkipped = false;
    const insuranceBannerCheck = await lib.checkForAdvisoryBanner(page, { ctx: { n8nBaseUrl, routeId, runId }, gapNotes });
    if (insuranceBannerCheck.resolutions.length && !insuranceBannerCheck.handled) {
      const urlBeforeInsuranceCheckpoint = page.url();
      await lib.pauseForHuman(insuranceBannerCheck.pauseMessage);
      // Clicking the site's own Continue button here submits the *entire*
      // rest of Driver Info at once (there's no separate per-section
      // submit) - if that's what resolved this checkpoint, the recipe
      // never got a chance to fill cancellations/suspensions/accidents/
      // tickets/policy-date with the real values below. Disclosed honestly
      // rather than silently treated as filled.
      const navResult = lib.classifyCheckpointNavigation(page, urlBeforeInsuranceCheckpoint, '/autoquote/on/discounts');
      if (navResult === 'unexpected') {
        return {
          status: lib.STATUS.MANUAL_HANDOFF,
          failure_reason: null,
          outcome: {
            next_action: 'The page ended up somewhere this recipe did not recognize after a human checkpoint on the Driver Info page - looks like more of the flow was driven manually than just resolving that one checkpoint. Automation stopped here rather than running stale scripted steps against an unexpected page - check the browser window directly for whatever was reached.',
          },
          maskSelectors,
        };
      }
      if (navResult === 'advanced_as_expected') {
        driverHistorySkipped = true;
        gapNotes.push(
          'Driver Info was submitted while resolving a human checkpoint (via the site\'s own Continue button) before this recipe could fill insurance cancellations, licence suspensions, at-fault accidents, traffic tickets, or the policy start date - those may reflect the site\'s own defaults rather than the values on file. Verify them on the actual quote before treating it as final.'
        );
      }
    }

    let discountsPageAlreadyAdvanced = false;
    if (!driverHistorySkipped) {
      // ---- History: cancellations / suspensions / accidents / tickets ----
      // Only the zero-events path (all four "No") is live-verified, in either
      // pass. The >0 path's per-event selects (e.g. accident-month0-0) are
      // implemented from what the DOM structure implies, not something
      // watched unlock and fill live — kept id-based, verify before relying
      // on this for anyone with a real driving history to report.
      const cancellationsAll = lib.parseEvents(
        await lib.readVaultValue('insurance_cancellations.events', vaultPassphrase)
      );
      const cancellations = lib.filterEventsWithinYears(cancellationsAll, 3);
      // Confirmed live (twice, including after a wait-and-retry of the exact
      // same click, which failed identically both times - not a transient
      // timing issue): unlike suspensions/accidents/tickets below, which are
      // plain <select> dropdowns, this question renders as styled pill
      // buttons. The underlying native <input> is very likely visually
      // hidden behind that custom styling (a common accessible-custom-
      // control pattern), which Playwright's actionability check treats as
      // "never visible" even though the input is real and functionally
      // clickable - a plain page.click() then waits the full timeout for a
      // visibility state that will never arrive. A direct DOM click via
      // evaluate() sidesteps that CSS-visibility requirement entirely.
      const cancellationsRawSelector = `input[name="num-cancellations[0]"][value="${cancellations.length > 0 ? '1' : '0'}"]`;
      try {
        await page.click(`${cancellationsRawSelector}:visible`);
      } catch (e) {
        const clicked = await page.evaluate((sel) => {
          const el = document.querySelector(sel);
          if (el) {
            el.click();
            return true;
          }
          return false;
        }, cancellationsRawSelector);
        if (!clicked) throw e;
      }

      const suspensions = lib.parseEvents(
        await lib.readVaultValue('licence_and_permit_events.suspension_or_cancellation_events_6yr', vaultPassphrase)
      );
      await lib.selectPlanning(page, '#num-suspensions0', suspensions.length === 0 ? '0' : suspensions.length === 1 ? '1' : '2');
      for (let i = 0; i < Math.min(suspensions.length, 6); i += 1) {
        const ev = suspensions[i] || {};
        if (ev.month) await lib.selectPlanning(page, `#suspension-month0-${i}`, String(ev.month)).catch(() => {});
        if (ev.year) await lib.selectPlanning(page, `#suspension-year0-${i}`, String(ev.year)).catch(() => {});
      }

      // Rates.ca's "Has Driver #1 had any at-fault accidents?" question didn't
      // state an explicit lookback window on screen — 6 years assumed here,
      // matching the OAF 1 baseline, not confirmed against the live site.
      const accidents = lib.filterEventsWithinYears(
        lib.parseEvents(await lib.readVaultValue('accidents_and_claims.events', vaultPassphrase)),
        6
      );
      await lib.selectPlanning(page, '#num-accidents0', String(Math.min(accidents.length, 5)));
      for (let i = 0; i < Math.min(accidents.length, 6); i += 1) {
        const ev = accidents[i] || {};
        if (ev.month) await lib.selectPlanning(page, `#accident-month0-${i}`, String(ev.month)).catch(() => {});
        if (ev.year) await lib.selectPlanning(page, `#accident-year0-${i}`, String(ev.year)).catch(() => {});
      }

      const tickets = lib.parseEvents(await lib.readVaultValue('convictions.events_3yr', vaultPassphrase));
      await lib.selectPlanning(page, '#num-tickets0', String(Math.min(tickets.length, 5)));
      for (let i = 0; i < Math.min(tickets.length, 6); i += 1) {
        const ev = tickets[i] || {};
        if (ev.month) await lib.selectPlanning(page, `#ticket-month0-${i}`, String(ev.month)).catch(() => {});
        if (ev.year) await lib.selectPlanning(page, `#ticket-year0-${i}`, String(ev.year)).catch(() => {});
      }

      if (params['coverage_configuration.requested_effective_date']) {
        await lib.fillPlanning(page, '#policy-start-date0', params['coverage_configuration.requested_effective_date']);
      }

      // Confirmed live: after filling licensing timeline + insurance history,
      // Rates.ca can show a non-blocking advisory banner ("we noticed a gap
      // between your first-licensed and first-insured dates - if correct,
      // continue") rather than a hard validation error. This isn't a known
      // field to map - it's a confirmation of data already entered. Generic,
      // site-agnostic detection (not hardcoded to this exact wording) via
      // lib.checkForAdvisoryBanner; only auto-proceeds on a confident
      // acknowledge_and_continue from the brain, otherwise pauses for a human
      // rather than risking clicking past something that actually matters.
      const bannerCheck = await lib.checkForAdvisoryBanner(page, { ctx: { n8nBaseUrl, routeId, runId }, gapNotes });
      if (bannerCheck.resolutions.length && !bannerCheck.handled) {
        const urlBeforeDiscountsCheckpoint = page.url();
        await lib.pauseForHuman(bannerCheck.pauseMessage);
        const navResult2 = lib.classifyCheckpointNavigation(page, urlBeforeDiscountsCheckpoint, '/autoquote/on/discounts');
        if (navResult2 === 'unexpected') {
          return {
            status: lib.STATUS.MANUAL_HANDOFF,
            failure_reason: null,
            outcome: {
              next_action: 'The page ended up somewhere this recipe did not recognize after a human checkpoint on the Driver Info page - looks like more of the flow was driven manually than just resolving that one checkpoint. Automation stopped here rather than running stale scripted steps against an unexpected page - check the browser window directly for whatever was reached.',
            },
            maskSelectors,
          };
        }
        discountsPageAlreadyAdvanced = navResult2 === 'advanced_as_expected';
      }
    }

    if (!discountsPageAlreadyAdvanced) {
      await page.click('button:has-text("Continue"):visible');
      await lib.waitForURLOrBotChallenge(page, '**/autoquote/on/discounts');
    }

    // ---- Discount Info ----
    // The radio's own <label> wraps it — clicking the label text toggles
    // the underlying radio, confirmed live.
    await page.click('label:has-text("No, I don\'t want this discount"):visible'); // safest default, no household-composition data assumed
    if (params['discount_eligibility.good_driver_or_group_discounts']) {
      const discounts = params['discount_eligibility.good_driver_or_group_discounts'];
      await lib.selectPlanning(page, 'label:has-text("member of CAA") ~ select', Array.isArray(discounts) && discounts.includes('CAA') ? '1' : '0');
    }
    await lib.selectPlanning(page, 'label:has-text("scores your driving habits") ~ select', params['discount_eligibility.telematics_opt_in'] ? '1' : '0');
    await lib.fillFromVault(page, 'label:has-text("provide your email address") ~ input', 'contact.email', vaultPassphrase);
    await lib.fillFromVault(page, 'label:has-text("Phone number") ~ input', 'contact.mobile_phone', vaultPassphrase);

    const originalUrl = page.url();

    // Consent-attestation checkpoint — per the brief, this pauses for me, not
    // the automation. I review the exact consent text in the visible browser
    // and check the box myself (or click "Get Free Quotes") if I agree.
    await lib.pauseForHuman(
      'Everything through the Discount Info page is filled. The last step is the ' +
        '"I agree" consent checkbox above "Get Free Quotes" — read it in the browser ' +
        'window and check it yourself, then click "Get Free Quotes" yourself, then come ' +
        'back here and press Enter. This recipe does not check that box or submit on your behalf.'
    );

    await page.waitForTimeout(2000);
    // Not just a URL check — this is a multi-step wizard (the same style as
    // vehicle/driver/discounts) and may update state without a full URL
    // change. Also look for quote-result-shaped content as a fallback signal.
    const currentUrl = page.url();
    const pageText = await page.evaluate(() => document.body.innerText).catch(() => '');
    const looksSubmitted = currentUrl !== originalUrl || /your quotes|\$[\d,]+\s*\/\s*(year|month)/i.test(pageText);
    if (!looksSubmitted) {
      throw new lib.HumanCheckpoint(
        'no_submission_detected',
        'Still on the Discount Info page after the pause, and no quote-results content was found — the ' +
          'quote request likely was not submitted.',
        maskSelectors
      );
    }

    // Confirmed live: right after "Get Free Quotes" is clicked, Rates.ca
    // shows a transient loading interstitial ("You'll be redirected in a
    // few seconds... Contacting <underwriter>") while it queries carriers
    // in the background - the fixed 2s wait above isn't nearly enough for
    // that to clear, so the evidence screenshot captured the loading state
    // instead of actual results. Poll for that interstitial's own text to
    // disappear (bounded, so a route that genuinely never finishes loading
    // still completes rather than hanging indefinitely) before finishing,
    // so the evidence this recipe saves actually shows the results page a
    // person could read the premium off of.
    const interstitialClearedDeadline = Date.now() + 45000;
    while (Date.now() < interstitialClearedDeadline) {
      const stillLoading = await page
        .evaluate(() => /redirected in a few seconds|contacting/i.test(document.body.innerText))
        .catch(() => false);
      if (!stillLoading) break;
      await page.waitForTimeout(1500);
    }

    if (modelMatch.tier !== 'exact') {
      const tierLabel = modelMatch.tier === 'prefix' ? 'closest prefix' : modelMatch.tier === 'partial_word_match' ? 'closest trim match' : 'same model, unconfirmed trim';
      gapNotes.push(`Requested vehicle model "${params['vehicle_identity.model']}" wasn't listed exactly — quoted trim is actually "${modelMatch.text}" (match: ${tierLabel}). Verify this matches your actual vehicle before treating the quote as final.`);
    }

    const carrierQuotes = await extractCarrierQuotes(page).catch(() => []);
    if (carrierQuotes.length === 0) {
      gapNotes.push(
        'Reached the Your Quotes results page, but this run\'s carrier-name/price extraction found nothing to report - ' +
          'the page may not have finished loading, or its layout doesn\'t match the extraction heuristic. Check the evidence screenshot directly for the actual figures.'
      );
    } else if (carrierQuotes.some((c) => c.annual_premium == null)) {
      gapNotes.push(
        `Extracted ${carrierQuotes.length} carrier(s) from the Your Quotes page, but at least one price couldn't be parsed into a number - check the evidence screenshot to confirm the real figures.`
      );
    }

    // Basic vs Recommended (the two featured package cards, same top-ranked
    // carrier) and the fact that every other listed carrier is Basic-tier
    // only - both surfaced explicitly, not left implicit in a premium
    // number alone, since a price difference here reflects a real coverage
    // difference, not just a cheaper/pricier version of the same policy.
    const packageDetails = await extractPackageCoverageDetails(page).catch(() => []);
    const basicCard = packageDetails.find((c) => c.tier === 'basic');
    const recommendedCard = packageDetails.find((c) => c.tier === 'recommended');

    if (basicCard && recommendedCard) {
      const recommendedByLabel = new Map(recommendedCard.coverage_items.map((i) => [i.label, i.included]));
      const upgradedInRecommended = basicCard.coverage_items
        .filter((item) => item.included === false && recommendedByLabel.get(item.label) === true)
        .map((item) => item.label);
      if (upgradedInRecommended.length > 0) {
        gapNotes.push(
          `Basic vs Recommended (top-ranked carrier): Recommended includes ${upgradedInRecommended.length} benefit(s) Basic does not - ${upgradedInRecommended.join(', ')}. (Best-effort visual extraction - verify against the evidence screenshot.)`
        );
        if (params['coverage_configuration.accident_benefits_selection'] === 'standard_mandatory_only') {
          gapNotes.push(
            'The profile requested standard_mandatory_only accident benefits - the Recommended package\'s extra benefit(s) above go beyond that, so Recommended is a variance from what was declared; Basic looks like the closer match to the requested coverage, but verify against the evidence screenshot before relying on this.'
          );
        }
      } else if (basicCard.coverage_items.length > 0) {
        gapNotes.push('Basic and Recommended packages from the top-ranked carrier appeared to include the same benefit items in this best-effort extraction despite the price difference between them - verify against the evidence screenshot.');
      }
    } else if (basicCard || recommendedCard) {
      gapNotes.push('Could only extract itemized coverage for one of the two featured package tiers (Basic/Recommended) this run - see the evidence screenshot for the other.');
    } else {
      gapNotes.push('Could not extract itemized coverage details for the Basic/Recommended package comparison this run - see the evidence screenshot.');
    }

    if (carrierQuotes.some((c) => c.package_tier === 'basic' && !c.is_recommended)) {
      gapNotes.push(
        'The "Other Basic Quotes" list of additional carriers reflects Basic-tier coverage only, per the site\'s own section heading - not directly comparable to the Recommended-tier premium above without accounting for that coverage difference.'
      );
    }

    return {
      status: lib.STATUS.QUOTED_NON_COMPARABLE,
      failure_reason: null,
      outcome: {
        exact_quote_or_estimate: 'quote',
        eligibility_result: 'returned_a_result_page',
        carrier_quotes: carrierQuotes,
        package_coverage_comparison: { basic: basicCard || null, recommended: recommendedCard || null },
        next_action: [
          carrierQuotes.length > 0
            ? `Extracted ${carrierQuotes.length} carrier quote(s) from the Your Quotes page (see carrier_quotes) - verify against the evidence screenshot before treating any figure as final, since this extraction is a best-effort heuristic, not confirmed against the site's real markup.`
            : 'Reached the Your Quotes results page but could not extract carrier names/prices this run - see the evidence screenshot for the actual figures.',
          ...gapNotes,
        ].join(' '),
      },
      maskSelectors,
    };
  },
};
