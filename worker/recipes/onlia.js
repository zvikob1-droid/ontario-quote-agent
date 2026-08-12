'use strict';
/**
 * Onlia — digital broker route. registry_id: onlia (MVP).
 *
 * Step 1 was verified live by me on 2026-08-12 via a discovery-only pass
 * with placeholder data (real DOM ids). Steps 2-5 are built from screenshots
 * of my own real walkthrough of the full flow, done in my own browser with
 * my own judgment about what to enter at each point — not by this recipe,
 * and not by me driving the site. Selectors past step 1 are label/position
 * based best guesses inferred from those screenshots, not confirmed DOM ids
 * — verify against a live run before trusting them fully.
 *
 * ENTRY POINT: the marketing homepage (onlia.ca) routes through a
 * Squarespace-hosted page where the actual "Auto" quote card is an
 * image-link, not text — its real href leads straight to the quoting engine
 * on a separate subdomain:
 *   https://app.onlia.ca/#/auto/personal-info?Affinity_Group=Onlia
 * That deep link is used directly here, skipping the marketing site and its
 * cookie banner entirely (handled once during recon: "Manage cookies" ->
 * leave Performance/Advertising off, the privacy-preserving default ->
 * "Save Preferences").
 *
 * CORRECTION FROM MY OWN LIVE RECON: I had originally inferred #date_start
 * to be date of birth, from its position alone. My own real walkthrough
 * showed the sentence it completes is "I'd like to insure my vehicle,
 * starting on ___" — it's the requested coverage effective date, not DOB.
 * Fixed here. Where DOB actually gets collected isn't captured in the
 * screenshots (the driver-details page in step 3 shows it already
 * resolved, in a "<Name>, <age>, born <DOB>" banner, before the part of
 * that page my screenshots start at) — see the step 3 comment below.
 *
 * FIVE-STEP FLOW, confirmed by my own real walkthrough:
 *   1. Personal Info — single page, progressive reveal (each answer reveals
 *      the next question inline on the same page, not a new page load).
 *   2. Vehicle — starts pre-filled with a placeholder vehicle (a 2021 Honda
 *      Civic EX 4DR, every time, regardless of what I actually drive) that
 *      has to be explicitly overwritten, not accepted.
 *   3. Driver(s) — offers to add a suggested/matched driver profile I don't
 *      recognize ("Ifeanacho Okeke") alongside "Add New Driver"; this
 *      recipe always chooses "Add New Driver" for myself and never selects
 *      a suggested third party, since doing so would add someone else's
 *      identity to the policy without their consent — well outside this
 *      build's single-applicant scope.
 *   4. Pick a main driver + email/phone — ends at "Get my quote".
 *   5. (Results — not reached; "Get my quote" is the final pause point.)
 *
 * Unlike Rates.ca/Sonnet/TD, there is only ONE consent checkpoint in this
 * whole flow: the "I agree to the Terms of Use and Privacy Policy"
 * checkbox on step 1, bundled with the licence number field. There's no
 * second attestation before "Get my quote" — but this recipe still pauses
 * there, on the general principle that a human reviews and clicks the final
 * reveal/submit action, not the automation.
 *
 * REPORT CARD WINDOWS: tickets/convictions ask 3 years, licence suspensions
 * ask 6 years (both match the OAF 1 baseline other sites use) — but
 * accidents/claims ask 10 years (matches TD, wider than the 6-year
 * baseline) and prior insurance cancellations ask 5 years (wider than the
 * 3-year baseline every other MVP site so far has asked). That second
 * mismatch is why insurance_cancellations' field was widened from a fixed
 * 3-year window to a full dated history (insurance_cancellations.events) in
 * schema/intake_schema.json —
 * same fix, same reason, as accidents_and_claims.events before it. Both are
 * filtered per-site here via lib.filterEventsWithinYears() rather than the
 * vault deciding a window up front.
 */

/** event.year minus the applicant's birth year — a whole-years approximation, not month-precise. */
function ageAtYear(dobRaw, eventYear) {
  const dobYear = Number(String(dobRaw).split('-')[0]);
  const y = Number(eventYear);
  if (!dobYear || !y) return null;
  return y - dobYear;
}

async function fillIfEmpty(page, selector, value) {
  const current = await page.inputValue(selector).catch(() => '');
  if (!current) await page.fill(selector, String(value));
}

async function clickChoice(page, questionText, label) {
  await page
    .locator(`button:near(:text("${questionText}")), label:near(:text("${questionText}"))`, { hasText: label })
    .first()
    .click()
    .catch(() => {});
}

module.exports = {
  meta: {
    registryId: 'onlia',
    entryUrl: 'https://app.onlia.ca/#/auto/personal-info?Affinity_Group=Onlia',
  },

  async run(page, ctx) {
    const { lib, params, vaultPassphrase } = ctx;
    const maskSelectors = [];

    await page.goto(module.exports.meta.entryUrl, { waitUntil: 'domcontentloaded' });

    // ---- Step 1/5: Personal Info ----
    const fullName = await lib.readVaultValue('identity.legal_name', vaultPassphrase);
    const spaceIdx = fullName.indexOf(' ');
    await lib.fillPlanning(page, '#first_name', spaceIdx === -1 ? fullName : fullName.slice(0, spaceIdx));
    await lib.fillPlanning(page, '#last_name', spaceIdx === -1 ? '' : fullName.slice(spaceIdx + 1));
    maskSelectors.push('#first_name', '#last_name');

    await lib.fillFromVault(page, '#street_address', 'primary_address.street', vaultPassphrase);
    maskSelectors.push('#street_address');
    await page.locator('[role="option"], .autocomplete-suggestion, li').first().click({ timeout: 3000 }).catch(() => {});

    // #date_start — coverage effective date, confirmed via my own real
    // walkthrough (the sentence reads "...starting on ___"), not DOB.
    const effectiveDateRaw = params['coverage_configuration.requested_effective_date'];
    if (effectiveDateRaw) {
      const [effYear, effMonth, effDay] = String(effectiveDateRaw).split('-');
      if (effYear && effMonth && effDay) {
        await lib.fillPlanning(page, '#date_start', `${effDay}/${effMonth}/${effYear}`);
      }
    }

    // Identity/attestation checkpoint: the licence number field and the
    // Terms of Use / Privacy Policy consent checkbox are both immediately
    // ahead. Neither is something this recipe fills or checks on my behalf.
    await lib.pauseForHuman(
      'Name, address, and coverage start date are filled. The next fields are the driver\'s licence number ' +
        'and the "I agree to the Terms of Use and Privacy Policy" checkbox — both are mine to fill/check in ' +
        'the browser window. Click "Continue" once done, then come back here and press Enter to let the ' +
        'recipe carry on into the Vehicle step — or type "abort" to stop the route here.'
    );

    // ---- Step 2/5: Vehicle ----
    // Onlia always starts this step with a placeholder vehicle (a 2021
    // Honda Civic EX 4DR, confirmed by my own walkthrough) already
    // selected — it must be explicitly overwritten, never accepted as-is.
    await page.locator('text=Complete Info').first().click().catch(() => {});
    await page.locator('label:has-text("Year") ~ select').first().selectOption(String(params['vehicle_identity.model_year'])).catch(() => {});
    await page.locator('label:has-text("Make") ~ select').first().selectOption({ label: String(params['vehicle_identity.make']).toUpperCase() }).catch(() => {});
    await page.locator('label:has-text("Model") ~ select').first().selectOption({ label: String(params['vehicle_identity.model']).toUpperCase() }).catch(() => {});

    const useType = String(params['use.use_type'] || '').toLowerCase();
    const useLabel = useType === 'business' ? 'Business' : useType === 'commute' ? 'Commuting' : 'Pleasure';
    await clickChoice(page, 'What do you use your vehicle for', useLabel);

    if (params['use.one_way_commute_distance'] != null) {
      await lib.fillPlanning(page, 'label:has-text("Distance to Work") ~ input', params['use.one_way_commute_distance']);
    }
    if (params['use.annual_kilometres'] != null) {
      await lib.fillPlanning(page, 'label:has-text("Annual km") ~ input, label:has-text("annual") ~ input', params['use.annual_kilometres']);
    }

    const purchaseRaw = params['ownership.purchase_or_lease_month_year'];
    if (purchaseRaw) {
      const [pYear, pMonth] = String(purchaseRaw).split('-');
      if (pYear && pMonth) {
        // Day is unknown from a month/year-only vault value — 01 is a
        // placeholder within the month, not a real recorded purchase day.
        await lib.fillPlanning(page, 'label:has-text("purchase your vehicle") ~ input', `01/${pMonth}/${pYear}`);
      }
    }

    await clickChoice(page, 'new or used', params['ownership.new_or_used'] === 'new' ? 'New' : 'Used');
    const ownership = String(params['ownership.owned_or_leased'] || '').toLowerCase();
    const ownershipLabel = ownership === 'leased' ? 'Lease' : ownership === 'financed' ? 'Finance' : 'Own';
    await clickChoice(page, 'own, lease or finance', ownershipLabel);
    await clickChoice(page, 'winter tires', params['risk_details.winter_tires'] ? 'Yes' : 'No');

    if (params['risk_details.overnight_parking_location']) {
      await page.locator('label:has-text("where your vehicle is parked") ~ select').first().selectOption({ label: String(params['risk_details.overnight_parking_location']) }).catch(() => {});
    }
    await clickChoice(page, 'anti-theft device', params['risk_details.anti_theft_features'] ? 'Yes' : 'No');
    if (params['ownership.purchase_price'] != null) {
      await lib.fillPlanning(page, 'label:has-text("Purchase Price") ~ input', params['ownership.purchase_price']);
    }
    await page.locator('text=Next').first().click().catch(() => {});

    // ---- Step 3/5: Driver(s) ----
    // "Add New Driver" only — never the suggested/matched third-party
    // profile (see header comment).
    await page.locator('text=Add New Driver').first().click().catch(() => {});

    // The name/DOB/gender pre-fill my own walkthrough showed on this page
    // happens before the part of the flow my screenshots capture in detail
    // — the exact entry point isn't confirmed. Best-effort: fill only if
    // still empty, matching the fillIfEmpty pattern used for TD's licence
    // lookup, in case these turn out to be editable text fields here too.
    await fillIfEmpty(page, 'label:has-text("First name") ~ input', spaceIdx === -1 ? fullName : fullName.slice(0, spaceIdx)).catch(() => {});
    await fillIfEmpty(page, 'label:has-text("Last name") ~ input', spaceIdx === -1 ? '' : fullName.slice(spaceIdx + 1)).catch(() => {});

    if (params['licence_identity.class']) {
      await page.locator('label:has-text("Driver\'s licence") ~ select').first().selectOption({ label: String(params['licence_identity.class']) }).catch(() => {});
    }
    if (params['current_insurance.years_continuously_insured'] != null) {
      await lib.fillPlanning(page, 'label:has-text("Years insured") ~ input', params['current_insurance.years_continuously_insured']);
    }

    // G1/G2/full-G licensing ages, each asked as "how old were you" rather
    // than a date. Derived from the vault's dated licensing_timeline
    // fields (year component only) against date_of_birth — a whole-years
    // approximation, not month-precise.
    const dob = await lib.readVaultValue('identity.date_of_birth', vaultPassphrase);
    const g1Year = String(params['licensing_timeline.g1_date_or_year'] || '').slice(0, 4);
    const g2Year = String(params['licensing_timeline.g2_date_or_year'] || '').slice(0, 4);
    const gYear = String(params['licensing_timeline.g_date_or_year'] || '').slice(0, 4);
    const g1Age = params['licensing_timeline.first_licensed_age'] ?? ageAtYear(dob, g1Year);
    const g2Age = ageAtYear(dob, g2Year);
    const gAge = ageAtYear(dob, gYear);
    if (g1Age != null) await lib.fillPlanning(page, 'label:has-text("G1 license") ~ input', g1Age);
    if (g2Age != null) await lib.fillPlanning(page, 'label:has-text("G2 license") ~ input', g2Age);
    if (gAge != null) await lib.fillPlanning(page, 'label:has-text("full G license") ~ input', gAge);
    maskSelectors.push('label:has-text("G1 license") ~ input', 'label:has-text("G2 license") ~ input', 'label:has-text("full G license") ~ input');

    if (params['licence_identity.status']) {
      await page.locator('label:has-text("Driver\'s Licence Status") ~ select').first().selectOption({ label: String(params['licence_identity.status']) }).catch(() => {});
    }
    if (params['identity.marital_status']) {
      await page.locator('label:has-text("Single, married or common law") ~ select, label:has-text("Marital") ~ select').first().selectOption({ label: String(params['identity.marital_status']) }).catch(() => {});
    }

    // ---- REPORT CARD ----
    const convictions3yr = lib.filterEventsWithinYears(
      lib.parseEvents(await lib.readVaultValue('convictions.events_3yr', vaultPassphrase)),
      3
    );
    await clickChoice(page, 'tickets or convictions in the past 3 years', convictions3yr.length > 0 ? 'Yes' : 'No');

    const suspensions6yr = lib.filterEventsWithinYears(
      lib.parseEvents(await lib.readVaultValue('licence_and_permit_events.suspension_or_cancellation_events_6yr', vaultPassphrase)),
      6
    );
    await clickChoice(page, 'licence suspensions in the last 6 years', suspensions6yr.length > 0 ? 'Yes' : 'No');

    // Accidents/claims and cancellations are entered as raw counts here
    // (number inputs), not Yes/No radios like the two questions above.
    const accidentsAll = lib.parseEvents(await lib.readVaultValue('accidents_and_claims.events', vaultPassphrase));
    const accidents10yr = lib.filterEventsWithinYears(accidentsAll, 10);
    await lib.fillPlanning(page, 'label:has-text("accidents or claims") ~ input', accidents10yr.length);

    const cancellationsAll = lib.parseEvents(await lib.readVaultValue('insurance_cancellations.events', vaultPassphrase));
    const cancellations5yr = lib.filterEventsWithinYears(cancellationsAll, 5);
    await lib.fillPlanning(page, 'label:has-text("insurance cancellations") ~ input', cancellations5yr.length);

    await page.locator('text=Next').first().click().catch(() => {});

    // ---- Step 4/5: main driver + contact ----
    await page.locator('[data-testid="driver-card"], .driver-card, li:has-text("' + (spaceIdx === -1 ? fullName : fullName.slice(0, spaceIdx)) + '")').first().click().catch(() => {});

    await lib.fillFromVault(page, 'input[type="email"]', 'contact.email', vaultPassphrase);
    await lib.fillFromVault(page, 'input[type="tel"]', 'contact.mobile_phone', vaultPassphrase);
    maskSelectors.push('input[type="email"]', 'input[type="tel"]');

    // Final checkpoint: "Get my quote" is the last action in this flow —
    // no separate consent gate here (the only one was step 1's Terms
    // checkbox), but a human still reviews and clicks the reveal/submit
    // action, not the automation.
    await lib.pauseForHuman(
      'Everything through email/phone is filled. "Get my quote" is the final action on this page — review ' +
        'the entered details in the browser window, then click it yourself and press Enter here once the ' +
        'quote (or a further question) loads — or type "abort" to stop the route here without submitting.'
    );

    await page.waitForTimeout(1500);
    const pageText = await page.evaluate(() => document.body.innerText).catch(() => '');
    const reachedQuote = /best price|your quote|\$[\d,]+\s*\/\s*(year|month)/i.test(pageText);

    return {
      status: reachedQuote ? lib.STATUS.ESTIMATE_ONLY : lib.STATUS.MANUAL_HANDOFF,
      failure_reason: reachedQuote ? null : 'no_quote_page_detected_after_submission',
      outcome: reachedQuote
        ? { exact_quote_or_estimate: 'estimate', eligibility_result: 'quote_reached' }
        : {
            exact_quote_or_estimate: 'estimate',
            eligibility_result: 'unknown',
            next_action: 'Review the browser window manually — the expected post-submission quote text was not detected on the page.',
          },
      maskSelectors,
    };
  },
};
