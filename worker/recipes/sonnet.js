'use strict';
/**
 * Sonnet Insurance — direct writer route. registry_id: sonnet (MVP).
 *
 * Built from a combination of (a) live DOM verification I did myself up
 * through the province page, using placeholder data, and (b) screenshots
 * from a discovery-only pass with placeholder data on 2026-08-12. Everything
 * past the province page uses label/placeholder/role-based locators rather
 * than confirmed CSS selectors — verify against a live run before trusting
 * it fully; each uncertain step is marked below.
 *
 * Entry point: rather than the marketing homepage (sonnet.ca), this recipe
 * goes straight to the quoting engine's own province page, which is a
 * stable, confirmed deep link — https://secure.sonnet.ca/#/quoting/auto/province.
 * The marketing homepage's province-gate modal and cookie banner turned out
 * to be unreliable to drive with synthetic clicks and aren't needed at all
 * if this route is used directly.
 *
 * Real, confirmed selectors (province page, AngularJS custom dropdown):
 *   #provinceButton              opens the province dropdown
 *   #provinceOption9             "Ontario" (options are provinceOption0..14)
 *   #province-submit-btn         "Continue"
 *
 * IMPORTANT DISCOVERY — a real CAPTCHA: clicking Continue on the province
 * page triggered a visible "I'm not a robot" reCAPTCHA challenge during my
 * verification pass. That was plausibly caused by my own synthetic clicks
 * reading as bot-like — real Playwright-driven input, or a real person, may
 * not trigger it — but it's a real, confirmed possibility on this route, not
 * a hypothetical. Handled below with pauseForHuman(), never solved
 * automatically.
 *
 * Everything past the province page (Get Started → Vehicle → Driver Details
 * → Other Drivers → pricing modal) is mapped from screenshots only, using
 * Playwright's label/placeholder/role locators. Field labels quoted below
 * are exact, taken directly from the screenshots.
 *
 * Consent/attestation gates on this route (more than most — implemented
 * faithfully rather than collapsed into one pause):
 *   - Vehicle page: "I acknowledge that knowingly using the wrong address is
 *     fraud..." (near the address fields) — required, pause.
 *   - Vehicle page: "I confirm that this vehicle does not have commercial
 *     plates..." — appears only after answering "No" to the business-use
 *     question; required when it appears, pause.
 *   - Vehicle page: "If Sonnet can't provide a quote... I allow Sonnet to
 *     share my personal information with an appointed broker..." — OPTIONAL.
 *     Left unchecked deliberately, no pause needed for declining it.
 *   - Vehicle page: "I allow Sonnet to collect, use and disclose my personal
 *     information..." — required main consent, pause.
 *   - Driver Details page: "Address Validation — I agree" — required, pause.
 *   - Other Drivers page: clicking "View my quote" itself carries consent
 *     via adjacent text (driving/insurance history review) — no separate
 *     checkbox, but the click itself is mine to make, pause.
 *   - Pricing modal: "See my price" after entering email/mobile — final
 *     reveal, pause. The "Keep in the loop" marketing checkbox next to it is
 *     optional — left unchecked.
 */
module.exports = {
  meta: {
    registryId: 'sonnet',
    entryUrl: 'https://secure.sonnet.ca/#/quoting/auto/province',
  },

  async run(page, ctx) {
    const { lib, params, vaultPassphrase } = ctx;
    const maskSelectors = [];

    // ---- Province ----
    await page.goto(module.exports.meta.entryUrl, { waitUntil: 'domcontentloaded' });
    await page.click('#provinceButton');
    await page.click('#provinceOption9'); // Ontario — this project is Ontario-only, hardcoded
    await page.click('#province-submit-btn');

    // A real reCAPTCHA checkbox showed up here during verification — handle
    // it as a human checkpoint every time, since it's a confirmed possibility
    // on this route, not just a theoretical CAPTCHA path.
    const captchaPresent = await page
      .locator('text=/unable to verify that you.?re human/i')
      .isVisible()
      .catch(() => false);
    if (captchaPresent) {
      await lib.pauseForHuman(
        'A reCAPTCHA challenge appeared after selecting the province. Solve it yourself in the browser ' +
          'window (check "I\'m not a robot" and complete any follow-up challenge), click Continue if it ' +
          'doesn\'t advance automatically, then come back here and press Enter.'
      );
    }
    await page.waitForURL('**/num_vehicles_drivers**', { timeout: 30000 }).catch(() => {});

    // ---- Get started (vehicle/driver counts) ----
    // Defaults are 1 vehicle / 1 driver, which is this project's only
    // supported case for now — multi-vehicle/multi-driver isn't implemented.
    // No consent involved here, so no pause — just proceed.
    await page.click('text=Next: vehicle details');
    await page.waitForURL('**/vehicle**', { timeout: 30000 }).catch(() => {});

    // ---- Vehicle details ----
    await lib.fillFromVault(page, 'input[placeholder*="street or civic address" i]', 'primary_address.street', vaultPassphrase);
    maskSelectors.push('input[placeholder*="street or civic address" i]');
    if (params['primary_address.unit']) {
      await lib.fillPlanning(page, 'label:has-text("Suite #") + input, input[name="suite"]', String(params['primary_address.unit']));
    }

    // "What are you driving?" — free-text search field (example: "2015 HONDA
    // CIVIC"). TODO/uncertain: this plausibly opens an autocomplete list that
    // needs a suggestion clicked, not just typed text — not verified live.
    const vehicleDesc = [params['vehicle_identity.model_year'], params['vehicle_identity.make'], params['vehicle_identity.model']]
      .filter(Boolean)
      .join(' ');
    await lib.fillPlanning(page, 'input[placeholder*="HONDA CIVIC" i]', vehicleDesc);
    // If an autocomplete suggestion list appears, this best-effort click picks
    // the first one — verify against a live run.
    await page.locator('[role="option"], .autocomplete-suggestion').first().click({ timeout: 3000 }).catch(() => {});

    if (params['ownership.owned_or_leased']) {
      await page.locator('label:has-text("owned, leased or financed") ~ select, select[name*="ownership" i]').first().selectOption({ label: params['ownership.owned_or_leased'] }).catch(() => {});
    }
    if (params['ownership.purchase_or_lease_month_year']) {
      const [pMonth, pYear] = String(params['ownership.purchase_or_lease_month_year']).split('-');
      if (pMonth) await page.locator('select:near(:text("When did you lease or buy it?"))').first().selectOption({ label: pMonth }).catch(() => {});
      if (pYear) await page.locator('select:near(:text("Year"))').first().selectOption({ label: pYear }).catch(() => {});
    }
    if (params['ownership.new_or_used']) {
      await page.locator('label:has-text("Purchase condition") ~ select').first().selectOption({ label: params['ownership.new_or_used'] }).catch(() => {});
    }
    if (params['use.annual_kilometres']) {
      await page.locator('label:has-text("Annual distance") ~ select').first().selectOption({ label: String(params['use.annual_kilometres']) }).catch(() => {});
    }
    if (params['use.one_way_commute_distance']) {
      await lib.fillPlanning(page, 'input:near(:text("Daily commute"))', String(params['use.one_way_commute_distance']));
    }
    await page.click(params['special_use.rideshare_or_delivery'] ? 'text=Yes >> nth=0' : 'label:has-text("paying passengers") ~ * >> text=No').catch(() => {});
    const businessUse = params['use.use_type'] === 'business';
    await page.click(businessUse ? 'label:has-text("other business purposes") ~ * >> text=Yes' : 'label:has-text("other business purposes") ~ * >> text=No').catch(() => {});
    await page.click(params['risk_details.winter_tires'] ? 'label:has-text("winter tires") ~ * >> text=Yes' : 'label:has-text("winter tires") ~ * >> text=No').catch(() => {});
    await page.click(params['risk_details.unrepaired_damage'] ? 'label:has-text("unrepaired damage") ~ * >> text=Yes' : 'label:has-text("unrepaired damage") ~ * >> text=No').catch(() => {});
    await page.click(params['risk_details.modifications_or_customization'] ? 'label:has-text("modifications") ~ * >> text=Yes' : 'label:has-text("modifications") ~ * >> text=No').catch(() => {});
    if (params['coverage_configuration.requested_effective_date']) {
      await lib.fillPlanning(page, 'label:has-text("Coverage Start Date") ~ input', params['coverage_configuration.requested_effective_date']);
    }

    // Consent-attestation checkpoint (batched — see header comment for why
    // each of these needs a real person, not automation):
    await lib.pauseForHuman(
      'Vehicle page filled. Before continuing, please review and check these yourself in the browser window:\n' +
        '    1. "I acknowledge that knowingly using the wrong address is fraud..."\n' +
        '    2. "I confirm that this vehicle does not have commercial plates..." (only if it appeared)\n' +
        '    3. "I allow Sonnet to collect, use and disclose my personal information..." (the main consent)\n' +
        '  Leave the broker-sharing checkbox ("If Sonnet can\'t provide a quote...") UNCHECKED — deliberately ' +
        'declined. Then click "Next: driver details" yourself and come back here and press Enter.'
    );
    await page.waitForURL('**/driver_details**', { timeout: 60000 }).catch(() => {});

    // ---- Driver details ----
    // identity.legal_name/date_of_birth are vault_only and split locally
    // here, so text fills go through fillSensitive (sanitized-error +
    // :visible scoping) rather than fillPlanning — see recipe_lib.js's
    // fillSensitive comment for why (a real value leaking into
    // failure_reason the same way a postal code did on Rates.ca).
    const fullName = await lib.readVaultValue('identity.legal_name', vaultPassphrase);
    const spaceIdx = fullName.indexOf(' ');
    await lib.fillSensitive(page, 'label:has-text("First name") ~ input', spaceIdx === -1 ? fullName : fullName.slice(0, spaceIdx), 'identity.legal_name (first)');
    await lib.fillSensitive(page, 'label:has-text("Last name") ~ input', spaceIdx === -1 ? '' : fullName.slice(spaceIdx + 1), 'identity.legal_name (last)');

    const dobRaw = await lib.readVaultValue('identity.date_of_birth', vaultPassphrase); // expected YYYY-MM-DD
    const [dobYear, dobMonth, dobDay] = String(dobRaw).split('-');
    if (dobMonth) await page.locator('label:has-text("Your birthday") ~ * select').first().selectOption({ index: Number(dobMonth) }).catch(() => {});
    if (dobDay) await lib.fillSensitive(page, 'input[placeholder="Day" i]', String(Number(dobDay)), 'identity.date_of_birth (day)');
    if (dobYear) await lib.fillSensitive(page, 'input[placeholder="Year" i]', dobYear, 'identity.date_of_birth (year)');
    maskSelectors.push('label:has-text("Your birthday") ~ *');

    // Issuing province already defaults to Ontario per the screenshot — left as-is.
    await lib.fillFromVault(page, 'label:has-text("Driver\'s licence number") ~ input', 'licence_identity.ontario_drivers_licence_number', vaultPassphrase);
    maskSelectors.push('label:has-text("Driver\'s licence number") ~ input');

    if (params['licence_identity.class']) {
      await page.locator('label:has-text("Licence class") ~ select').first().selectOption({ label: params['licence_identity.class'] }).catch(() => {});
    }

    const convictions = JSON.parse((await lib.readVaultValue('convictions.events_3yr', vaultPassphrase).catch(() => '[]')) || '[]');
    const suspensions = JSON.parse((await lib.readVaultValue('licence_and_permit_events.suspension_or_cancellation_events_6yr', vaultPassphrase).catch(() => '[]')) || '[]');
    const hasTicketsOrSuspensions = convictions.length > 0 || suspensions.length > 0;
    await page.click(hasTicketsOrSuspensions ? 'text=I\'ve had tickets, or a licence >> ~ * >> text=Yes' : 'text=I\'ve had tickets, or a licence >> ~ * >> text=No').catch(() => {});

    if (params['identity.marital_status'] === 'married') {
      await page.click('text=I\'m married or have a common law partner').catch(() => {});
    }
    // Group/affinity discount search (university, employer, etc.) intentionally
    // not automated — no reliable way to match an org without guessing.

    await lib.pauseForHuman(
      'Driver details filled. Please check the "Address Validation — I agree" checkbox yourself, ' +
        'then click "Next: additional drivers" and come back here and press Enter.'
    );
    await page.waitForURL('**/additional_drivers**', { timeout: 60000 }).catch(() => {});

    // ---- Other drivers ----
    // Single-driver only for now — no additional drivers added.
    const preQuoteUrl = page.url();
    await lib.pauseForHuman(
      'On the "Other drivers" page. Clicking "View my quote" carries an implied consent (reviewing your ' +
        'driving/insurance history) per the text just above it — read it, then click "View my quote" ' +
        'yourself, then come back here and press Enter.'
    );
    await page.waitForTimeout(1500);
    if (page.url() === preQuoteUrl) {
      throw new lib.HumanCheckpoint(
        'no_advance_detected',
        'Still on the Other Drivers page after the pause — "View my quote" was not clicked.',
        maskSelectors
      );
    }

    // ---- Pricing modal ----
    await lib.fillFromVault(page, 'label:has-text("Email address") ~ input, input[type="email"]', 'contact.email', vaultPassphrase);
    await lib.fillFromVault(page, 'label:has-text("Mobile number") ~ input, input[type="tel"]', 'contact.mobile_phone', vaultPassphrase);
    maskSelectors.push('label:has-text("Email address") ~ input', 'input[type="email"]', 'label:has-text("Mobile number") ~ input', 'input[type="tel"]');
    // "Keep in the loop" marketing checkbox intentionally left unchecked — optional.

    const originalUrl = page.url();
    await lib.pauseForHuman(
      'Email and mobile filled. Review, then click "See my price" yourself (the "Keep in the loop" box ' +
        'has been left unchecked deliberately) and come back here and press Enter.'
    );
    await page.waitForTimeout(2000);
    const currentUrl = page.url();
    const pageText = await page.evaluate(() => document.body.innerText).catch(() => '');
    const looksSubmitted = currentUrl !== originalUrl || /\$[\d,]+\s*\/\s*(year|month)|your quote/i.test(pageText);
    if (!looksSubmitted) {
      throw new lib.HumanCheckpoint(
        'no_submission_detected',
        'Still on the pricing modal after the pause — "See my price" does not appear to have been clicked.',
        maskSelectors
      );
    }

    return {
      status: lib.STATUS.QUOTED_NON_COMPARABLE,
      failure_reason: null,
      outcome: {
        exact_quote_or_estimate: 'quote',
        eligibility_result: 'returned_a_result_page',
        next_action:
          'Capture the actual returned premium/coverage from the results page — this recipe stops at ' +
          'detecting a successful submission and has not yet been extended to parse the results themselves.',
      },
      maskSelectors,
    };
  },
};
