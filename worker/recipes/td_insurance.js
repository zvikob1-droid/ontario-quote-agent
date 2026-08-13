'use strict';
/**
 * TD Insurance — direct/exclusive-agent route. registry_id: td_insurance (MVP).
 *
 * Built entirely from screenshots of a discovery-only pass with placeholder
 * data on 2026-08-12 — I did not drive this site myself (unlike Rates.ca),
 * so every selector here is a label/text-based best guess, not a confirmed
 * DOM id. Verify against a live run before trusting it fully. This is also
 * the longest of the four MVP flows — TD asks more questions than Rates.ca,
 * Sonnet, or Staebler.
 *
 * ENTRY POINT: the marketing homepage redirect chain is skipped in favour of
 * the stable quoting-engine URL captured in the screenshots:
 *   tdinsurance.com/quote/car/ontario?quoter=auto&website_id=generic&...
 * The extra query params (AID, company_name, brand) are plausibly just
 * affiliate/tracking noise rather than required — not confirmed either way,
 * so the full observed URL is used as-is rather than guessing which parts
 * are load-bearing.
 *
 * A REAL IDENTITY/DATABASE LOOKUP, not just a form: "The Driver" page offers
 * "Use your license" (enter an Ontario licence number, TD looks up and
 * pre-fills Name/Gender/Marital status/DOB/Address/Claims history/Insurance
 * history from external records) vs. "Use your information" (manual entry).
 * The screenshots this recipe is built from went through "Use your
 * license" — confirmed by the "Success! We retrieved some of your
 * information" banner and a pre-filled first name afterward. This recipe
 * follows that same real path rather than switching to manual entry, but
 * treats the licence-number entry + the following consent screen as the
 * single most important checkpoint in this whole flow — a real pull of real
 * personal records is a textbook "identity/database lookup" under the
 * brief's own rules, not a routine form step.
 *
 * Because the licence lookup may pre-fill fields before this recipe gets to
 * them, every field on "Your Details" and "Your address" is filled only if
 * still empty (fillIfEmpty/selectIfEmpty below) — respecting what TD's own
 * lookup already populated rather than risking overwriting it with a
 * differently-formatted vault value.
 *
 * TWO separate consent/contact gates were observed, not one — handled as two
 * separate pauses:
 *   1. "We Just Need Your Consent to Continue" — right after the licence
 *      number, gating the database lookup itself.
 *   2. "You're Almost Done!" — at the very end, with its own email/mobile
 *      fields and its own "I agree" + "Calculate my premium". Uncertain
 *      whether the first page also has its own email/mobile inputs (not
 *      clearly visible in the screenshots) — this recipe fills email/mobile
 *      if such fields are present at either point, harmless if only one
 *      actually has them.
 *
 * A note on the claims-history question specifically: TD asks about auto
 * claims in the **last 10 years** — wider than the 6-year OAF 1 baseline
 * Rates.ca's equivalent question assumes. This is exactly why
 * accidents_and_claims.events was widened to store full dates rather than a
 * fixed window — see schema/intake_schema.json and
 * lib.filterEventsWithinYears().
 */

async function clickChoice(page, questionText, label) {
  await page
    .locator(`button:near(:text("${questionText}"))`, { hasText: label })
    .first()
    .click();
}

// value here is frequently a vault_only field (name/DOB/address) respected
// only if the licence lookup didn't already prefill it — Playwright's own
// error message can embed the literal value on a failed fill/select, the
// same way a postal code leaked on Rates.ca, so both sanitize on failure.
function sanitizeFillIfEmptyError(e, selector, fieldLabel) {
  const sanitized = new Error(`Failed to fill "${fieldLabel || selector}" (${e.name || 'Error'}) — the value itself is never included in this error.`);
  sanitized.name = e.name || 'Error';
  return sanitized;
}

async function fillIfEmpty(page, selector, value, fieldLabel) {
  const current = await page.inputValue(selector).catch(() => '');
  if (!current) {
    try {
      await page.fill(selector, String(value));
    } catch (e) {
      throw sanitizeFillIfEmptyError(e, selector, fieldLabel);
    }
  }
}

async function selectIfEmpty(page, selector, value, fieldLabel) {
  const current = await page.inputValue(selector).catch(() => '');
  if (!current) {
    try {
      await page.selectOption(selector, String(value));
    } catch (e) {
      throw sanitizeFillIfEmptyError(e, selector, fieldLabel);
    }
  }
}

function kmBucketLabel(km) {
  const n = Number(km);
  if (!n) return null;
  if (n <= 5000) return '0 to 5,000 km';
  if (n <= 10000) return '5,001 to 10,000 km';
  if (n <= 15000) return '10,001 to 15,000 km';
  if (n <= 20000) return '15,001 to 20,000 km';
  return '20,001+ km';
}

async function pickBestModelOption(page, requestedModel) {
  const value = await page
    .locator('label:has-text("Vehicle model") ~ select')
    .first()
    .evaluate((el, wanted) => {
      const match = Array.from(el.options).find(
        (o) => o.value && o.value.toUpperCase().startsWith(String(wanted).toUpperCase())
      );
      return match ? match.value : null;
    }, requestedModel)
    .catch(() => null);
  if (!value) return; // TODO/uncertain: verify this selector against a live run
  await page.locator('label:has-text("Vehicle model") ~ select').first().selectOption(value).catch(() => {});
}

module.exports = {
  meta: {
    registryId: 'td_insurance',
    entryUrl:
      'https://www.tdinsurance.com/quote/car/ontario?quoter=auto&website_id=generic&AID=mmi_embperl_quoter&company_name=tdgi_Ext&brand=directmarket_Ext',
  },

  async run(page, ctx) {
    const { lib, params, vaultPassphrase } = ctx;
    const maskSelectors = [];

    // ---- Your vehicle ----
    await page.goto(module.exports.meta.entryUrl, { waitUntil: 'domcontentloaded' });
    // "Manual Input" is the default toggle state per the screenshots — left as-is.
    await page.locator('label:has-text("Vehicle year") ~ select').first().selectOption(String(params['vehicle_identity.model_year'])).catch(() => {});
    await page.locator('label:has-text("Vehicle make") ~ select').first().selectOption({ label: String(params['vehicle_identity.make']).toUpperCase() }).catch(() => {});
    await pickBestModelOption(page, params['vehicle_identity.model']);
    await page.click('text=Next');

    // ---- Vehicle Details ----
    if (params['ownership.new_or_used']) {
      const label = String(params['ownership.new_or_used']).toLowerCase() === 'used' ? 'Used' : 'New';
      await clickChoice(page, 'Vehicle condition when purchased', label);
    }
    if (params['ownership.owned_or_leased']) {
      const map = { owned: 'Owned', financed: 'Owned (financed)', leased: 'Leased' };
      await clickChoice(page, 'Owned or leased?', map[params['ownership.owned_or_leased']] || 'Owned');
    }
    if (params['ownership.purchase_or_lease_month_year']) {
      const [pMonth, pYear] = String(params['ownership.purchase_or_lease_month_year']).split('-');
      if (pYear) await page.locator('label:has-text("Year") ~ select').first().selectOption(pYear).catch(() => {});
      if (pMonth) await page.locator('label:has-text("Month") ~ select').first().selectOption({ index: Number(pMonth) }).catch(() => {});
    }
    await page.click('text=Next');

    // ---- How do you use your vehicle? ----
    const kmLabel = kmBucketLabel(params['use.annual_kilometres']);
    if (kmLabel) await page.click(`text=${kmLabel}`);
    const commutes = Boolean(params['use.one_way_commute_distance']);
    await clickChoice(page, 'commute to school/work', commutes ? 'Yes' : 'No');
    await clickChoice(page, 'business purposes', params['use.use_type'] === 'business' ? 'Yes' : 'No');
    await page.click('text=Next');

    // ---- Coverage Start Date ----
    if (params['coverage_configuration.requested_effective_date']) {
      const [cYear, cMonth, cDay] = String(params['coverage_configuration.requested_effective_date']).split('-');
      if (cYear) await page.locator('label:has-text("Year") ~ select').first().selectOption(cYear).catch(() => {});
      if (cMonth) await page.locator('label:has-text("Month") ~ select').first().selectOption({ index: Number(cMonth) }).catch(() => {});
      if (cDay) await page.locator('label:has-text("Day") ~ select').first().selectOption(String(Number(cDay))).catch(() => {});
    }
    await page.click('text=Next');

    // ---- Ways to Save ----
    await clickChoice(page, 'winter tires', params['risk_details.winter_tires'] ? 'Yes' : 'No');
    await clickChoice(page, 'anti-theft tracking system', params['risk_details.anti_theft_features'] ? 'Yes' : 'No');
    // TD MyAdvantage (telematics) — default No unless explicitly opted in, same
    // rule as everywhere else in this project.
    await clickChoice(page, 'enroll in the TD MyAdvantage', params['discount_eligibility.telematics_opt_in'] ? 'Yes' : 'No');
    await page.click('text=Next');

    // ---- Savings: student/employer discounts ----
    const isStudent = Boolean(params['discount_eligibility.student_status']);
    await clickChoice(page, 'student, a graduate or a faculty member', isStudent ? 'Yes' : 'No');
    const hasGroupDiscount = Array.isArray(params['discount_eligibility.good_driver_or_group_discounts']) && params['discount_eligibility.good_driver_or_group_discounts'].length > 0;
    await clickChoice(page, 'employer benefits, or belong to a professional association', hasGroupDiscount ? 'Yes' : 'No');
    await page.click('text=Next');

    // ---- The Driver — identity/database lookup checkpoint ----
    // "Use your license" is the default selected toggle — followed here
    // deliberately (see header comment), not switched to manual entry.
    await lib.fillFromVault(page, 'input[placeholder*="Ontario driver\'s license number" i]', 'licence_identity.ontario_drivers_licence_number', vaultPassphrase);
    maskSelectors.push('input[placeholder*="Ontario driver\'s license number" i]');
    await page.click('text=Next');

    // This is a real pull of real personal records (name, DOB, address,
    // claims/insurance history) from TD's own systems via the licence
    // number — the single most consequential checkpoint in this recipe.
    await lib.pauseForHuman(
      'TD is about to look up your personal records using the licence number just entered ' +
        '(name, gender, marital status, DOB, address, claims history, insurance history — per the ' +
        'text on this page). Review it yourself, check "I agree" if you consent to that lookup, fill ' +
        'in email/mobile here if this page asks for them, click Next, then come back here and press Enter.'
    );
    await page.waitForTimeout(1500);

    // ---- Your Details — respect whatever the licence lookup already filled ----
    const fullName = await lib.readVaultValue('identity.legal_name', vaultPassphrase);
    const spaceIdx = fullName.indexOf(' ');
    await fillIfEmpty(page, 'label:has-text("First name") ~ input', spaceIdx === -1 ? fullName : fullName.slice(0, spaceIdx), 'identity.legal_name (first)');
    await fillIfEmpty(page, 'label:has-text("Last name") ~ input', spaceIdx === -1 ? '' : fullName.slice(spaceIdx + 1), 'identity.legal_name (last)');
    maskSelectors.push('label:has-text("First name") ~ input', 'label:has-text("Last name") ~ input');

    const dobRaw = await lib.readVaultValue('identity.date_of_birth', vaultPassphrase); // expected YYYY-MM-DD
    const [dobYear, dobMonth, dobDay] = String(dobRaw).split('-');
    // selectIfEmpty's own original leniency (best-effort, don't stop the
    // whole recipe over one field) is preserved with .catch() here — the
    // fix is sanitizing what it throws before that, not making it stop
    // being lenient.
    if (dobYear) await selectIfEmpty(page, 'label:has-text("Date of birth") ~ * select >> nth=0', dobYear, 'identity.date_of_birth (year)').catch(() => {});
    if (dobMonth) await selectIfEmpty(page, 'label:has-text("Date of birth") ~ * select >> nth=1', String(Number(dobMonth)), 'identity.date_of_birth (month)').catch(() => {});
    if (dobDay) await selectIfEmpty(page, 'label:has-text("Date of birth") ~ * select >> nth=2', String(Number(dobDay)), 'identity.date_of_birth (day)').catch(() => {});
    maskSelectors.push('label:has-text("Date of birth") ~ *');

    // Button group, not a text field — clicking the right option again if the
    // licence lookup already selected it is harmless, so no "already filled"
    // check is needed here the way there is for the text inputs above.
    const genderValue = await lib.readVaultValue('identity.gender_field_as_required_by_form', vaultPassphrase);
    if (genderValue) {
      const g = String(genderValue).toUpperCase();
      await clickChoice(page, 'Gender', g.startsWith('F') ? 'Female' : g.startsWith('M') ? 'Male' : 'X');
    }
    if (params['identity.marital_status']) {
      const map = { single: 'Single', married: 'Married' };
      await clickChoice(page, 'Marital status', map[params['identity.marital_status']] || 'Common-law');
    }
    await page.click('text=Next');

    // ---- Your address ----
    const street = await lib.readVaultValue('primary_address.street', vaultPassphrase);
    await fillIfEmpty(page, 'input[placeholder*="Start typing" i]', street, 'primary_address.street');
    maskSelectors.push('input[placeholder*="Start typing" i]');
    // Likely opens an autocomplete suggestion list — best-effort first-result
    // click, not verified live.
    await page.locator('[role="option"], .autocomplete-suggestion').first().click({ timeout: 3000 }).catch(() => {});
    // City/Province/Postal code appeared greyed out/auto-derived from the
    // address suggestion in the screenshots — not filled independently here.
    await clickChoice(page, 'home quote or a tenant quote', 'No thanks'); // decline bundling — out of scope for this project
    await page.click('text=Next');

    // ---- Tell us about your driver's license ----
    if (params['licence_identity.class']) {
      await clickChoice(page, 'class of your current license', params['licence_identity.class']);
    }
    if (params['licensing_timeline.first_licensed_age']) {
      await lib.fillPlanning(page, 'label:has-text("How old were you when you got your G license") ~ input', String(params['licensing_timeline.first_licensed_age']));
    }
    if (params['licensing_timeline.g_date_or_year']) {
      // Field name is "_date_or_year" deliberately - a bare 4-digit year is
      // valid input, not just "MM-YYYY". Splitting on "-" alone treated a
      // bare year as the month index, silently no-opping via the .catch()
      // below rather than actually selecting a month. Only attempt the
      // month select when a real month is actually present.
      const monthYearMatch = String(params['licensing_timeline.g_date_or_year']).match(/^(\d{1,2})-\d{4}$/);
      if (monthYearMatch) {
        await page.locator('label:has-text("Select the month you got this license") ~ select').first().selectOption({ index: Number(monthYearMatch[1]) }).catch(() => {});
      }
    }
    await page.click('text=Next');

    // ---- Driver's License History ----
    const outOfProvince = Boolean(params['licensing_timeline.out_of_country_experience_recognized']);
    await clickChoice(page, 'license from another Canadian province or the USA', outOfProvince ? 'Yes' : 'No');
    await page.click('text=Next');

    // ---- Driving History ----
    const tickets3yr = lib.parseEvents(await lib.readVaultValue('convictions.events_3yr', vaultPassphrase));
    await clickChoice(page, 'Have you had any tickets in the last 3 years', tickets3yr.length > 0 ? 'Yes' : 'No');
    const suspensions6yr = lib.parseEvents(await lib.readVaultValue('licence_and_permit_events.suspension_or_cancellation_events_6yr', vaultPassphrase));
    await clickChoice(page, 'license suspended in the last 6 years', suspensions6yr.length > 0 ? 'Yes' : 'No');
    await page.click('text=Next');

    // ---- Insurance and Claims History ----
    // TD's 10-year window, not the 6-year OAF 1 baseline — see header comment.
    const claims10yr = lib.filterEventsWithinYears(
      lib.parseEvents(await lib.readVaultValue('accidents_and_claims.events', vaultPassphrase)),
      10
    );
    await clickChoice(page, 'auto claims in the last 10 years', claims10yr.length > 0 ? 'Yes' : 'No');
    await page.click('text=Next');

    // ---- Insurance and Claims History (cont'd) ----
    // != null: same falsy-zero fix applied elsewhere tonight (0 years
    // continuously insured is a real, valid answer, not "not provided").
    if (params['current_insurance.years_continuously_insured'] != null) {
      const opts = await page.locator('label:has-text("How long have you been with your current insurer") ~ select').first().evaluate((el) => Array.from(el.options).map((o) => o.value)).catch(() => []);
      if (opts.length > 1) await page.locator('label:has-text("How long have you been with your current insurer") ~ select').first().selectOption(opts[1]).catch(() => {});
    }
    const cancellationsAll = lib.parseEvents(await lib.readVaultValue('insurance_cancellations.events', vaultPassphrase));
    const cancellations3yr = lib.filterEventsWithinYears(cancellationsAll, 3);
    await clickChoice(page, 'auto policy cancelled or refused in the last 3 years', cancellations3yr.length > 0 ? 'Yes' : 'No');
    const fraudFinding = await lib.readVaultValue('fraud_finding.fraud_court_findings', vaultPassphrase).catch(() => '');
    await clickChoice(page, 'convicted of fraud or attempted fraud', fraudFinding ? 'Yes' : 'No');
    await page.click('text=Next');

    // ---- Accident Benefits (household) — derived from existing fields, no new ones needed ----
    const occStatus = String(params['identity.occupational_status'] || '').toLowerCase();
    await clickChoice(page, 'employed or self-employed', occStatus === 'employed' ? 'Yes' : 'No');
    await clickChoice(page, 'unemployed or retired', occStatus === 'unemployed' || occStatus === 'retired' ? 'Yes' : 'No');
    await clickChoice(page, 'a full-time student', isStudent ? 'Yes' : 'No');
    await page.click('text=Next');

    // ---- You're Almost Done! — final consent + submission ----
    await lib.fillFromVault(page, 'input[placeholder*="123) 456-7890" i]', 'contact.mobile_phone', vaultPassphrase);
    await lib.fillFromVault(page, 'input[placeholder*="example@abc.com" i]', 'contact.email', vaultPassphrase);
    maskSelectors.push('input[placeholder*="123) 456-7890" i]', 'input[placeholder*="example@abc.com" i]');

    const originalUrl = page.url();
    await lib.pauseForHuman(
      'Final page. Mobile and email are filled. Review the consent text (credit report soft-pull, ' +
        'quote calculation), check "I agree" yourself, click "Calculate my premium" yourself, then come ' +
        'back here and press Enter.'
    );
    await page.waitForTimeout(2000);
    const currentUrl = page.url();
    const pageText = await page.evaluate(() => document.body.innerText).catch(() => '');
    const looksSubmitted = currentUrl !== originalUrl || /\$[\d,]+|your premium|your quote/i.test(pageText);
    if (!looksSubmitted) {
      throw new lib.HumanCheckpoint(
        'no_submission_detected',
        'Still on the final page after the pause — "Calculate my premium" does not appear to have been clicked.',
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
