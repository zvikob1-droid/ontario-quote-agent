'use strict';
/**
 * Rates.ca — aggregator route. registry_id: rates_ca (MVP).
 *
 * Verified live on 2026-08-12 via a discovery-only pass using placeholder
 * data (never a real applicant), walking Vehicle Info → Driver Info →
 * Discount Info. Stopped deliberately at the consent checkbox on the
 * Discount Info page — never checked it, never clicked "Get Free Quotes" —
 * since that checkbox is a consent attestation under the brief's own rule
 * ("pause before any identity lookup, consent attestation, signature,
 * payment or purchase action"), not something this recipe decides on my
 * behalf. See the pauseForHuman() call below.
 *
 * Real flow, confirmed selectors (ids are stable, verified live):
 *   1. https://rates.ca/  — #postal-code-input, #submitBtn -> navigates to
 *      ratesinsuranceservices.rates.ca/autoquote/on/vehicle
 *   2. Vehicle Info (.../autoquote/on/vehicle) — cascading selects:
 *      vehicle-year0 -> vehicle-make0 -> vehicle-model0 (each unlocks the
 *      next). vehicle-model0's options are full trim strings (e.g.
 *      "BLAZER LT 4DR AWD"), not a plain model name — see pickBestModelOption()
 *      below for how this recipe approximates a match; this is a real
 *      limitation, not a guess dressed up as certainty.
 *      Also: is-leased0, acquired-month0/year0, winter-tires0,
 *      overnight-parking0, primary-use0, daily-distance0, annual-distance0,
 *      comprehensive-coverage0, collision-coverage0. Anti-theft checkboxes
 *      (anti-theft-10/20/30) exist but weren't mapped — left unchecked
 *      (matches "No" default), a real gap if winter_tires/anti-theft
 *      discounts matter to the comparison.
 *   3. Driver Info (.../autoquote/on/driver) — first-name0, last-name[0],
 *      dob-month0/day0/year0, gender0, marital-status0,
 *      occupational-status0 (numeric codes, see OCCUPATION_CODES below),
 *      license-class0, has-foreign-license0, first-license-age0,
 *      full-license-month0/year0, has-driver-education0, first-insured-year0,
 *      time-with-insurer0, then Yes/No + repeating detail groups for
 *      cancellations/suspensions/accidents/tickets, then policy-start-date0.
 *      IMPORTANT: only the "0 events" path (num-cancellations=0,
 *      num-suspensions0=0, num-accidents0=0, num-tickets0=0) was actually
 *      exercised live. The >0 path below is a best-effort implementation of
 *      what the DOM structure implies (per-event reason/month/year selects
 *      named e.g. accident-year0-0, accident-month0-0), not something I
 *      watched unlock and fill in a real session — verify it before relying
 *      on it for anyone with a real driving history to report.
 *   4. Discount Info (.../autoquote/on/discounts) — bundle-discount (radio
 *      group: bundle-homeowners/bundle-condominium/bundle-tenants/bundle-0),
 *      caa-member, telematics-discount, group-discount (text, optional),
 *      email, phone, then #signup-weekly-mandatory (the consent checkbox —
 *      confirmed via its own label/parent text to be the exact "I agree..."
 *      paragraph), then #discount-form-submit ("Get Free Quotes").
 */

const OCCUPATION_CODES = {
  employed: '998',
  unemployed: '800',
  student: '700',
  retired: '640',
};

/**
 * vehicle-model0's options are full trim strings. Pick the first option whose
 * text starts with the requested model name (case-insensitive) — an
 * approximation, not an exact trim match. Logged so it shows up in evidence.
 */
async function pickBestModelOption(page, requestedModel) {
  const value = await page.evaluate((wanted) => {
    const el = document.getElementById('vehicle-model0');
    const match = Array.from(el.options).find(
      (o) => o.value && o.value.toUpperCase().startsWith(String(wanted).toUpperCase())
    );
    return match ? match.value : null;
  }, requestedModel);
  if (!value) {
    throw new Error(`No vehicle-model0 option starts with "${requestedModel}" — model list may have changed.`);
  }
  await page.selectOption('#vehicle-model0', value);
  return value;
}

module.exports = {
  meta: {
    registryId: 'rates_ca',
    entryUrl: 'https://rates.ca/',
  },

  async run(page, ctx) {
    const { lib, params, vaultPassphrase } = ctx;
    const maskSelectors = [];

    // ---- Entry: postal code ----
    await page.goto(module.exports.meta.entryUrl, { waitUntil: 'domcontentloaded' });
    await lib.fillFromVault(page, '#postal-code-input', 'primary_address.postal_code', vaultPassphrase);
    maskSelectors.push('#postal-code-input');
    await page.click('#submitBtn');
    await page.waitForURL('**/autoquote/on/vehicle');

    // ---- Vehicle Info ----
    await lib.selectPlanning(page, '#vehicle-year0', String(params['vehicle_identity.model_year']));
    await page.waitForSelector('#vehicle-make0 option:not([value=""])');
    await lib.selectPlanning(page, '#vehicle-make0', String(params['vehicle_identity.make']).toUpperCase());
    await page.waitForSelector('#vehicle-model0 option:not([value=""])');
    await pickBestModelOption(page, params['vehicle_identity.model']);

    if (params['ownership.owned_or_leased']) {
      const leaseMap = { owned: '0', leased: '1', financed: '2' };
      await lib.selectPlanning(page, '#is-leased0', leaseMap[params['ownership.owned_or_leased']] || '0');
    }
    if (params['ownership.purchase_or_lease_month_year']) {
      const [pMonth, pYear] = String(params['ownership.purchase_or_lease_month_year']).split('-');
      if (pMonth) await lib.selectPlanning(page, '#acquired-month0', String(Number(pMonth)));
      if (pYear) await lib.selectPlanning(page, '#acquired-year0', pYear);
    }
    await lib.selectPlanning(page, '#winter-tires0', params['risk_details.winter_tires'] ? '1' : '0');
    if (params['risk_details.overnight_parking_location']) {
      await lib.selectPlanning(page, '#overnight-parking0', params['risk_details.overnight_parking_location']);
    }
    // Anti-theft checkboxes (anti-theft-10/20/30) intentionally left unchecked —
    // not yet mapped to a schema field. Leaving as "No" is honest (matches the
    // discovery-pass default) but may undercount a real discount.
    await lib.selectPlanning(page, '#primary-use0', params['use.use_type'] === 'business' ? 'business' : 'personal');
    if (params['use.one_way_commute_distance']) {
      await lib.selectPlanning(page, '#daily-distance0', String(params['use.one_way_commute_distance']));
    }
    if (params['use.annual_kilometres']) {
      await lib.selectPlanning(page, '#annual-distance0', String(params['use.annual_kilometres']));
    }
    const ownDamage = String(params['coverage_configuration.own_damage_coverage'] || '');
    await lib.selectPlanning(page, '#comprehensive-coverage0', /comprehensive/i.test(ownDamage) ? '1' : '0');
    await lib.selectPlanning(page, '#collision-coverage0', /collision/i.test(ownDamage) ? '1' : '0');

    await page.click('button:has-text("Continue")');
    await page.waitForURL('**/autoquote/on/driver');

    // ---- Driver Info ----
    // legal_name/date_of_birth/gender are each ONE vault field but need
    // splitting across multiple selects here — read the raw value directly
    // (readVaultValue carries the same missing-field pause as fillFromVault)
    // rather than forcing it through an unrelated page field as scratch
    // storage, which risks tripping that field's own validation/side effects.
    const fullName = await lib.readVaultValue('identity.legal_name', vaultPassphrase);
    const spaceIdx = fullName.indexOf(' ');
    const first = spaceIdx === -1 ? fullName : fullName.slice(0, spaceIdx);
    const last = spaceIdx === -1 ? '' : fullName.slice(spaceIdx + 1);
    await page.fill('#first-name0', first);
    await page.fill('#last-name\\[0\\]', last);
    maskSelectors.push('#first-name0', '#last-name\\[0\\]');

    // Expected vault format: YYYY-MM-DD.
    const dobRaw = await lib.readVaultValue('identity.date_of_birth', vaultPassphrase);
    const [dobYear, dobMonth, dobDay] = String(dobRaw).split('-');
    if (dobYear && dobMonth && dobDay) {
      await lib.selectPlanning(page, '#dob-month0', String(Number(dobMonth)));
      await lib.selectPlanning(page, '#dob-day0', String(Number(dobDay)));
      await lib.selectPlanning(page, '#dob-year0', dobYear);
    }
    maskSelectors.push('#dob-month0', '#dob-day0', '#dob-year0');

    const genderValue = await lib.readVaultValue('identity.gender_field_as_required_by_form', vaultPassphrase);
    if (genderValue) {
      const g = String(genderValue).toUpperCase();
      await lib.selectPlanning(page, '#gender0', g.startsWith('F') ? 'F' : g.startsWith('M') ? 'M' : 'X');
    }
    maskSelectors.push('#gender0');

    if (params['identity.marital_status']) {
      const maritalMap = { single: 'single', married: 'married' };
      await lib.selectPlanning(page, '#marital-status0', maritalMap[params['identity.marital_status']] || 'other');
    }
    if (params['identity.occupational_status']) {
      const code = OCCUPATION_CODES[String(params['identity.occupational_status']).toLowerCase()];
      if (code) await lib.selectPlanning(page, '#occupational-status0', code);
    }
    if (params['licence_identity.class']) {
      const classMap = { G1: 'provisional', G2: 'probationary', G: 'full' };
      await lib.selectPlanning(page, '#license-class0', classMap[params['licence_identity.class']] || 'full');
    }
    await lib.selectPlanning(page, '#has-foreign-license0', params['licensing_timeline.out_of_country_experience_recognized'] ? '1' : '0');
    if (params['licensing_timeline.first_licensed_age']) {
      await lib.fillPlanning(page, '#first-license-age0', String(params['licensing_timeline.first_licensed_age']));
    }
    if (params['licensing_timeline.g_date_or_year']) {
      const [gMonth, gYear] = String(params['licensing_timeline.g_date_or_year']).split('-');
      if (gMonth) await lib.selectPlanning(page, '#full-license-month0', String(Number(gMonth)));
      if (gYear) await lib.selectPlanning(page, '#full-license-year0', gYear);
    }
    await lib.selectPlanning(page, '#has-driver-education0', params['training.approved_driver_training_completed'] ? '1' : '0');
    if (params['current_insurance.first_insured_year']) {
      await lib.selectPlanning(page, '#first-insured-year0', String(params['current_insurance.first_insured_year']));
    }
    if (params['current_insurance.years_continuously_insured']) {
      const opts = await page.evaluate(() => Array.from(document.getElementById('time-with-insurer0').options).map((o) => o.value));
      if (opts.length > 1) await lib.selectPlanning(page, '#time-with-insurer0', opts[1]);
    }

    // ---- History: cancellations / suspensions / accidents / tickets ----
    // Only the zero-events path (all four "No") is live-verified. The >0
    // path's per-event selects (e.g. accident-month0-0) are implemented from
    // what the DOM structure implies, not from watching them actually unlock
    // in a live run — verify before relying on this for a real history.
    const cancellationsAll = lib.parseEvents(
      await lib.readVaultValue('insurance_cancellations.events', vaultPassphrase)
    );
    const cancellations = lib.filterEventsWithinYears(cancellationsAll, 3);
    await page.click(`input[name="num-cancellations[0]"][value="${cancellations.length > 0 ? '1' : '0'}"]`);

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

    await page.click('button:has-text("Continue")');
    await page.waitForURL('**/autoquote/on/discounts');

    // ---- Discount Info ----
    await page.click('#bundle-0'); // "No, I don't want this discount" — safest default, no household-composition data assumed
    if (params['discount_eligibility.good_driver_or_group_discounts']) {
      const discounts = params['discount_eligibility.good_driver_or_group_discounts'];
      await lib.selectPlanning(page, '#caa-member', Array.isArray(discounts) && discounts.includes('CAA') ? '1' : '0');
    }
    await lib.selectPlanning(page, '#telematics-discount', params['discount_eligibility.telematics_opt_in'] ? '1' : '0');
    await lib.fillFromVault(page, '#email', 'contact.email', vaultPassphrase);
    await lib.fillFromVault(page, '#phone', 'contact.mobile_phone', vaultPassphrase);
    maskSelectors.push('#email', '#phone');

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

    return {
      status: lib.STATUS.QUOTED_NON_COMPARABLE,
      failure_reason: null,
      outcome: {
        exact_quote_or_estimate: 'quote',
        eligibility_result: 'returned_a_result_page',
        next_action:
          'Capture the actual returned premiums/underwriters from the Your Quotes page — this recipe stops at ' +
          'detecting a successful submission and has not yet been extended to parse the results table itself.',
      },
      maskSelectors,
    };
  },
};
