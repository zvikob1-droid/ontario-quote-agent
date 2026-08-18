'use strict';
/**
 * LowestRates.ca — aggregator route. registry_id: lowestrates_ca (MVP).
 *
 * CONFIRMED LIVE (DOM inspection with placeholder postal code only, never
 * real vault data): LowestRates.ca runs on the exact same underlying
 * quoting engine as rates_ca.js's route. After submitting a postal code on
 * the marketing homepage, it redirects to
 * `https://lowestratesinsuranceservices.lowestrates.ca/autoquote/on/vehicle`
 * — the identical path structure and page layout (same tab bar: Vehicle
 * Info / Driver Info / Discount Info / Your Quotes; same field labels,
 * same cascading Vehicle year/make/model behaviour) as
 * `ratesinsuranceservices.rates.ca/autoquote/on/vehicle`, just re-skinned
 * (teal branding instead of red). This is almost certainly the same
 * "RATESDOTCA Group" platform white-labelled under two consumer brands,
 * not a coincidence — matching the panel-overlap note already in
 * `brain/system_prompt.md` flagging Rates.ca and LowestRates.ca as a
 * possible shared program.
 *
 * SCOPE OF WHAT'S ACTUALLY VERIFIED: only the landing page and the fact
 * that Vehicle Info's URL/layout matches were confirmed live this pass.
 * Everything from Vehicle Info onward is copied from rates_ca.js on the
 * strength of that match, not independently re-walked field-by-field on
 * this specific domain — the underlying engine being shared makes this a
 * reasonable, well-evidenced bet, not a confirmed 1:1 verification of
 * every selector on this exact host. Treat any failure past the landing
 * page as a signal to verify that specific step live here, same as any
 * other not-yet-live-verified recipe path.
 *
 * ENTRY FLOW (the one genuinely different part from rates_ca.js):
 * LowestRates.ca's homepage (`https://lowestrates.ca`) is a marketing page
 * with a "Postal Code" input (`#auto-postal-code`) and a "Get Started"
 * button (no unique id — matched by its own text) directly on it, unlike
 * Rates.ca's dedicated intake page. No separate welcome/cookie modal was
 * observed blocking this postal code field during the live check (unlike
 * sonnet.js's landing page), but that was one check with placeholder data,
 * not proof one can never appear — if a future run stalls right here,
 * check for an unexpected overlay first before assuming this recipe is
 * broken.
 *
 * Everything from "---- Vehicle Info ----" onward is unchanged from
 * rates_ca.js, including all of tonight's hardening (:visible scoping,
 * defensive keyup dispatch, the advisory-banner detector, checkpoint-
 * navigation classification, the Cloudflare-challenge handler, the
 * multi-carrier/coverage-comparison extraction) — see rates_ca.js's own
 * header comment and docs/KNOWN_LIMITATIONS.md for the detailed history
 * behind each of those.
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
 * whole route over an inexact trim match, this tries progressively looser
 * matches and always returns which tier it used, so the recipe can be
 * honest in its result about a substitution rather than silently treating
 * it as exact. Only throws if nothing even matches the base model name
 * (first word) — that case would mean picking a genuinely different
 * vehicle, which is a real failure, not an imprecise trim. Copied from
 * rates_ca.js — see that file for the live-confirmation history behind
 * this logic.
 */
async function pickBestModelOption(page, requestedModel) {
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

    match = options.find((o) => words.every((w) => o.value.toUpperCase().includes(w)));
    if (match) return { value: match.value, text: match.textContent.trim(), tier: 'partial_word_match' };

    match = options.find((o) => words[0] && o.value.toUpperCase().includes(words[0]));
    if (match) return { value: match.value, text: match.textContent.trim(), tier: 'base_model_only' };

    return null;
  }, requestedModel);

  if (!result) {
    throw new Error(`No vehicle-model option matches even the base model name in "${requestedModel}" — model list may have changed.`);
  }
  const selector = 'label:has-text("Vehicle model") ~ * select:visible, label:has-text("Vehicle model") ~ select:visible';
  await page.selectOption(selector, result.value);

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

// Same known-carrier list as rates_ca.js — same underlying platform, so
// plausibly the same panel, though this hasn't been independently
// confirmed on this specific domain yet.
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
 * Best-effort extraction of the multi-carrier breakdown the "Your Quotes"
 * results page returns. Copied from rates_ca.js — see that file for the
 * live-testing history behind this heuristic (logo-image anchoring,
 * carrier-name normalization, bounded ancestor walk for price pairing).
 */
async function extractCarrierQuotes(page, ctx = {}) {
  const raw = await page.evaluate((carrierNames) => {
    const isVisible = (el) => {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    // Copied from rates_ca.js — see that file for the confirmed-live bug
    // this matching logic fixes: separator-stripped substring matching on
    // short/ambiguous codes (TD, SGI, CAA) false-positived on this site's
    // own footer text ("...RATESDOTCA Group Ltd. company...", "Ltd"
    // contains "td"). Short codes now require a real word boundary
    // against the original text; longer, more distinctive names keep the
    // separator-stripped substring match (needed for hyphenated logo
    // src slugs and stylized display text like "PEM BRIDGE").
    const normalize = (s) => (s || '').toLowerCase().replace(/[\s\-_]+/g, '');
    const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const SHORT_CODE_MAX_LEN = 3;
    const matchesCarrier = (text) => {
      if (!text) return null;
      const normText = normalize(text);
      for (const c of carrierNames) {
        const normCarrier = normalize(c);
        if (!normCarrier) continue;
        if (normCarrier.length <= SHORT_CODE_MAX_LEN) {
          if (new RegExp(`\\b${escapeRe(c)}\\b`, 'i').test(text)) return c;
        } else if (normText.includes(normCarrier)) {
          return c;
        }
      }
      return null;
    };
    const priceRe = /\$\s*[\d,]+(?:\.\d{2})?(?:\s*\/\s*(?:year|yr|month|mo))?/i;

    const imgAnchors = Array.from(document.querySelectorAll('img'))
      .filter(isVisible)
      .map((el) => {
        let carrierName = matchesCarrier(el.getAttribute('alt')) || matchesCarrier(el.getAttribute('title')) || matchesCarrier(el.getAttribute('src') || '');
        if (!carrierName) {
          let node = el.parentElement;
          for (let d = 0; d < 4 && node && !carrierName; d += 1) {
            carrierName = matchesCarrier(node.textContent);
            node = node.parentElement;
          }
        }
        return { el, carrierName };
      })
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
        // Confirmed via fixture test on rates_ca.js (identical logic here):
        // checking size AFTER accepting a price match still let a
        // low-information anchor (e.g. a small trust-badge logo with no
        // nearby price of its own) climb all the way to <body> and grab an
        // unrelated price, since the cap only stopped climbing PAST an
        // oversized node, not from using a match found ON it. Check size
        // first, every step.
        const rect = node.getBoundingClientRect();
        if (rect.height > window.innerHeight * 0.5) break;
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

      let packageTier = null;
      let checkNode = rowMarker;
      for (let d = 0; d < 4 && checkNode; d += 1) {
        // Same unbounded-climb risk as the price-pairing loop above: on a
        // long results page, 4 ancestor levels can reach <main> or <body>,
        // whose combined text includes "Recommended Coverage" from the
        // unrelated featured cards elsewhere on the page. Same size cap.
        const rect = checkNode.getBoundingClientRect();
        if (rect.height > window.innerHeight * 0.5) break;
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
      out.push({ ...r, package_tier: r.package_tier === 'recommended' ? 'recommended' : 'basic' });
      if (out.length >= 15) break;
    }

    // Copied from rates_ca.js — see that file for the full reasoning.
    // GAP DETECTION feeding the optional vision-verification fallback in
    // worker/lib/recipe_lib.js's verifyCarrierQuotesWithBrain: find every
    // visible leaf whose own text contains a price that isn't already
    // inside one of the rows matched above (usedRows) - a real row nobody
    // could attach a carrier name to. Purely structural.
    const isInsideMatchedRow = (leaf) => {
      for (const claimed of usedRows) {
        if (claimed === leaf || claimed.contains(leaf)) return true;
      }
      return false;
    };
    // Climb from the leaf's own PARENT (not the leaf itself) using the same
    // "first ancestor whose own text contains a price, size-capped" rule
    // the matched pass above uses - lands on the shared row wrapper for two
    // sibling price mentions (monthly + annual) alike, collapsing both into
    // one Set entry. Starting from the leaf itself would trivially match
    // itself at depth 0 every time, defeating the collapse.
    const findUnmatchedRowContainer = (leaf) => {
      let node = leaf.parentElement;
      for (let d = 0; d < 8 && node; d += 1) {
        const rect = node.getBoundingClientRect();
        if (rect.height > window.innerHeight * 0.5) break;
        if (priceRe.test(node.textContent || '')) return node;
        node = node.parentElement;
      }
      return leaf;
    };
    const priceLeaves = Array.from(document.querySelectorAll('*'))
      .filter(isVisible)
      .filter((el) => el.children.length === 0)
      .filter((el) => priceRe.test(el.textContent || ''));
    const unmatchedRowSet = new Set();
    for (const leaf of priceLeaves) {
      if (isInsideMatchedRow(leaf)) continue;
      unmatchedRowSet.add(findUnmatchedRowContainer(leaf));
    }
    const unmatchedRowsRaw = Array.from(unmatchedRowSet)
      .map((el) => {
        const m = (el.textContent || '').match(priceRe);
        const rect = el.getBoundingClientRect();
        return { price_text: m ? m[0] : null, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } };
      })
      .filter((r) => r.price_text);
    const matchedRects = Array.from(usedRows).map((el) => {
      const rect = el.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    });

    return { out, unmatchedRowsRaw, matchedRects };
  }, KNOWN_CARRIER_NAMES);

  const quotes = raw.out.map((r) => ({
    underwriter: r.underwriter,
    annual_premium: parsePremiumToAnnual(r.price_text),
    is_recommended: r.package_tier === 'recommended',
    package_tier: r.package_tier,
  }));
  const unmatchedRows = raw.unmatchedRowsRaw
    .map((r) => ({ annual_premium: parsePremiumToAnnual(r.price_text), rect: r.rect }))
    .filter((r) => r.annual_premium != null);

  if (unmatchedRows.length === 0 || !ctx.lib || typeof ctx.lib.verifyCarrierQuotesWithBrain !== 'function') {
    return { quotes, notes: [] };
  }

  const allRowRects = [...raw.matchedRects, ...unmatchedRows.map((r) => r.rect)];
  return ctx.lib
    .verifyCarrierQuotesWithBrain(page, { candidateQuotes: quotes, unmatchedRows, allRowRects }, ctx)
    .catch(() => ({ quotes, notes: [] }));
}

/**
 * Best-effort itemized coverage checklist for the two featured "Basic
 * Coverage"/"Recommended Coverage" package cards. Copied from
 * rates_ca.js — see that file for the live-testing history behind this
 * heuristic (relative text-color luminance for included/excluded).
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
    registryId: 'lowestrates_ca',
    entryUrl: 'https://lowestrates.ca',
  },

  async run(page, ctx) {
    const { lib, params, vaultPassphrase, routeId, runId, n8nBaseUrl } = ctx;
    const maskSelectors = [];
    const gapNotes = [];

    // ---- Entry: postal code (the one genuinely different part from
    // rates_ca.js - see header comment) ----
    await page.goto(module.exports.meta.entryUrl, { waitUntil: 'domcontentloaded' });
    await lib.fillFromVault(page, '#auto-postal-code:visible', 'primary_address.postal_code', vaultPassphrase);
    maskSelectors.push('#auto-postal-code:visible');
    await page.click('button:has-text("Get Started"):visible');
    // Same Cloudflare-challenge handling as rates_ca.js - confirmed
    // structurally identical engine, so the same risk applies here even
    // though it hasn't yet been observed live on this specific domain.
    await lib.waitForURLOrBotChallenge(page, '**/autoquote/on/vehicle');
    await lib.snapshotPageText(page);

    // ---- Vehicle Info ---- (unchanged from rates_ca.js from here on)
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
      const [pMonth, pYearStr] = String(params['ownership.purchase_or_lease_month_year']).split('-');
      const pYear = Number(pYearStr);
      const purchaseDate = pMonth && pYear ? new Date(pYear, Number(pMonth) - 1, 1) : null;
      const daysSincePurchase = purchaseDate ? (Date.now() - purchaseDate.getTime()) / 86400000 : Infinity;
      if (purchaseDate && daysSincePurchase <= 60) {
        await lib.selectPlanning(page, 'label:has-text("Vehicle purchase date") ~ * select >> nth=0', String(Number(pMonth)));
        await lib.selectPlanning(page, 'label:has-text("Vehicle purchase date") ~ * select >> nth=1', String(pYear));
      } else if (purchaseDate) {
        const [resolution] = await lib.resolveFieldsWithBrain([{
          question_id: 'vehicle_purchase_date',
          label: 'Vehicle purchase date',
          field_type: 'date_group (Month select + Year select)',
          options: null,
          error_text: 'Please select a vehicle purchase date that is no further than 60 days from today.',
          is_mandatory: true,
        }], { n8nBaseUrl, routeId, runId, profileContext: params });

        if (resolution.strategy === 'use_today_date') {
          const today = new Date();
          await lib.selectPlanning(page, 'label:has-text("Vehicle purchase date") ~ * select >> nth=0', String(today.getMonth() + 1));
          await lib.selectPlanning(page, 'label:has-text("Vehicle purchase date") ~ * select >> nth=1', String(today.getFullYear()));
          gapNotes.push(`Vehicle purchase date: used today's date to satisfy this site's requirement — the real purchase date on file doesn't qualify (${resolution.reason || 'more than 60 days ago'}).`);
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
    const winterTiresCount = await page.locator('label:has-text("Winter tires"):visible').count().catch(() => 0);
    if (winterTiresCount > 0) {
      await lib.selectPlanning(page, 'label:has-text("Winter tires") ~ select', params['risk_details.winter_tires'] ? '1' : '0');
    } else {
      gapNotes.push('The winter tires discount question wasn\'t visible on this run — matches the same gap already confirmed on rates_ca.js\'s shared engine — winter tire status could not be communicated to this site.');
    }
    if (params['risk_details.overnight_parking_location']) {
      await lib.selectPlanning(page, 'label:has-text("Where is this vehicle parked overnight?") ~ select', params['risk_details.overnight_parking_location']);
    }
    await lib.selectPlanning(page, 'label:has-text("What is the primary use of this vehicle?") ~ select', params['use.use_type'] === 'business' ? 'business' : 'personal');
    if (params['use.one_way_commute_distance'] != null) {
      await lib.selectPlanning(page, 'label:has-text("How many kilometres are driven to work or school one way") ~ select', String(params['use.one_way_commute_distance']));
    }
    if (params['use.annual_kilometres'] != null) {
      await lib.selectPlanning(page, 'label:has-text("How many total kilometres are driven each year?") ~ select', String(params['use.annual_kilometres']));
    }
    const ownDamage = String(params['coverage_configuration.own_damage_coverage'] || '');
    await lib.selectPlanning(page, 'label:has-text("Comprehensive Coverage") ~ select', /comprehensive/i.test(ownDamage) ? '1' : '0');
    await lib.selectPlanning(page, 'label:has-text("Collision Coverage") ~ select', /collision/i.test(ownDamage) ? '1' : '0');

    let vehiclePageAlreadyAdvanced = false;
    const vehicleBannerCheck = await lib.checkForAdvisoryBanner(page, { ctx: { n8nBaseUrl, routeId, runId }, gapNotes });
    if (vehicleBannerCheck.resolutions.length && !vehicleBannerCheck.handled) {
      const urlBeforeVehicleCheckpoint = page.url();
      await lib.pauseForHuman(vehicleBannerCheck.pauseMessage);
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
    await lib.snapshotPageText(page);

    // ---- Driver Info ---- (unchanged from rates_ca.js)
    const fullName = await lib.readVaultValue('identity.legal_name', vaultPassphrase);
    const spaceIdx = fullName.indexOf(' ');
    const first = spaceIdx === -1 ? fullName : fullName.slice(0, spaceIdx);
    const last = spaceIdx === -1 ? '' : fullName.slice(spaceIdx + 1);
    await lib.fillSensitive(page, 'label:has-text("First name") ~ input', first, 'identity.legal_name (first)');
    await lib.fillSensitive(page, 'label:has-text("Last name") ~ input', last, 'identity.legal_name (last)');

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
    const driverEdCount = await page.locator('#has-driver-education0:visible').count().catch(() => 0);
    if (driverEdCount > 0) {
      await lib.selectPlanning(page, '#has-driver-education0', params['training.approved_driver_training_completed'] ? '1' : '0');
    } else {
      gapNotes.push('The driver education discount question was not visible for this profile — could not communicate driver training status to this site.');
    }
    if (params['current_insurance.first_insured_year']) {
      await lib.selectPlanning(page, 'label:has-text("first listed as a driver on an insurance policy") ~ select', String(params['current_insurance.first_insured_year']));
    }
    if (params['current_insurance.years_continuously_insured'] != null) {
      const opts = await page.evaluate(() => {
        const labels = Array.from(document.querySelectorAll('label')).filter((l) => /been with their current insurance company/i.test(l.textContent));
        const label = labels.find((l) => l.closest('div')?.querySelector('select')?.offsetParent !== null) || labels[0];
        const el = label ? label.closest('div')?.querySelector('select') : null;
        return el ? Array.from(el.options).map((o) => o.value) : [];
      });
      if (opts.length > 1) await lib.selectPlanning(page, 'label:has-text("been with their current insurance company") ~ select', opts[1]);
    }

    await page.waitForTimeout(800);
    let driverHistorySkipped = false;
    const insuranceBannerCheck = await lib.checkForAdvisoryBanner(page, { ctx: { n8nBaseUrl, routeId, runId }, gapNotes });
    if (insuranceBannerCheck.resolutions.length && !insuranceBannerCheck.handled) {
      const urlBeforeInsuranceCheckpoint = page.url();
      await lib.pauseForHuman(insuranceBannerCheck.pauseMessage);
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
      const cancellationsAll = lib.parseEvents(
        await lib.readVaultValue('insurance_cancellations.events', vaultPassphrase)
      );
      const cancellations = lib.filterEventsWithinYears(cancellationsAll, 3);
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

    // ---- Discount Info ---- (unchanged from rates_ca.js)
    await page.click('label:has-text("No, I don\'t want this discount"):visible');
    if (params['discount_eligibility.good_driver_or_group_discounts']) {
      const discounts = params['discount_eligibility.good_driver_or_group_discounts'];
      await lib.selectPlanning(page, 'label:has-text("member of CAA") ~ select', Array.isArray(discounts) && discounts.includes('CAA') ? '1' : '0');
    }
    await lib.selectPlanning(page, 'label:has-text("scores your driving habits") ~ select', params['discount_eligibility.telematics_opt_in'] ? '1' : '0');
    await lib.fillFromVault(page, 'label:has-text("provide your email address") ~ input', 'contact.email', vaultPassphrase);
    await lib.fillFromVault(page, 'label:has-text("Phone number") ~ input', 'contact.mobile_phone', vaultPassphrase);

    const originalUrl = page.url();

    await lib.pauseForHuman(
      'Everything through the Discount Info page is filled. The last step is the ' +
        '"I agree" consent checkbox above "Get Free Quotes" — read it in the browser ' +
        'window and check it yourself, then click "Get Free Quotes" yourself, then come ' +
        'back here and press Enter. This recipe does not check that box or submit on your behalf.'
    );

    await page.waitForTimeout(2000);
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

    const carrierExtraction = await extractCarrierQuotes(page, { lib, n8nBaseUrl, routeId, runId })
      .catch(() => ({ quotes: [], notes: [] }));
    const carrierQuotes = carrierExtraction.quotes;
    if (carrierExtraction.notes && carrierExtraction.notes.length) gapNotes.push(...carrierExtraction.notes);
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
