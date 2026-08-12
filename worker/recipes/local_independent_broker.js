'use strict';
/**
 * Local independent broker route — Staebler Insurance. registry_id:
 * local_independent_broker (MVP).
 *
 * Confirmed by direct navigation and DOM inspection on 2026-08-11 (read-only,
 * no data entered): https://www.staebler.com/get-a-quote/ is a single-page
 * lead form (a Divi/WordPress contact form module) — Name, Email Address,
 * Phone Number, and a free-text "Describe the types of insurance you need"
 * field, then Submit. Staebler's own site describes their process as three
 * steps: (1) submit this form, (2) get paired with a licensed broker who
 * calls to gather details, (3) the broker compares prices and presents
 * options. There is no automated instant quote here by design — this route
 * is built to correctly end at callback_required, matching how a
 * traditional independent broker actually operates (see
 * docs/KNOWN_LIMITATIONS.md).
 *
 * Real field selectors, confirmed via DOM inspection (no data entered):
 *   #et_pb_contact_myname_0            Name
 *   #et_pb_contact_email_address_0     Email Address
 *   #et_pb_contact_phone_number_0      Phone Number
 *   #et_pb_contact_mymessage_0         Describe the types of insurance you need (textarea)
 *   button[name="et_builder_submit_button"]   Submit
 *
 * The form also sits behind CleanTalk anti-spam (hidden honeypot fields
 * present in the DOM) — one more reason the final Submit click below is left
 * to a human rather than automated, on top of this being an
 * identity-disclosure checkpoint under the brief's own rules.
 *
 * Uses lib.pauseForHuman() for a real pause-and-resume: the recipe fills the
 * form, waits for you to review and click Submit yourself in the visible
 * browser window, then keeps running in the *same* browser session to check
 * whether a submission actually happened, rather than ending the run outright.
 */
module.exports = {
  meta: {
    registryId: 'local_independent_broker',
    entryUrl: 'https://www.staebler.com/get-a-quote/',
  },

  async run(page, ctx) {
    const { lib, params, vaultPassphrase } = ctx;
    const NAME = '#et_pb_contact_myname_0';
    const EMAIL = '#et_pb_contact_email_address_0';
    const PHONE = '#et_pb_contact_phone_number_0';
    const MESSAGE = '#et_pb_contact_mymessage_0';
    const maskSelectors = [NAME, EMAIL, PHONE];

    await page.goto(module.exports.meta.entryUrl, { waitUntil: 'domcontentloaded' });

    await lib.fillFromVault(page, NAME, 'identity.legal_name', vaultPassphrase);
    await lib.fillFromVault(page, EMAIL, 'contact.email', vaultPassphrase);
    await lib.fillFromVault(page, PHONE, 'contact.mobile_phone', vaultPassphrase);

    const vehicleDesc = [
      params['vehicle_identity.model_year'],
      params['vehicle_identity.make'],
      params['vehicle_identity.model'],
    ]
      .filter(Boolean)
      .join(' ');
    await lib.fillPlanning(
      page,
      MESSAGE,
      `Auto insurance quote request${vehicleDesc ? ' — ' + vehicleDesc : ''}. Please call to discuss.`
    );

    const originalUrl = page.url();

    // Identity-disclosure checkpoint: this form is about to send my real
    // name/email/phone to a real business. Per the brief, that pauses for my
    // explicit confirmation before submission — and the actual Submit click
    // is mine to make, in the visible browser window, not automated. This
    // also sidesteps the CleanTalk honeypot fields, which a normal human
    // submission won't trip. pauseForHuman() blocks here (in the worker's own
    // terminal) until I press Enter or type "abort" — if I abort or don't
    // respond, it rejects and this function never reaches the check below.
    await lib.pauseForHuman(
      'Form filled (name, email, phone, message). Review it in the browser window and click ' +
        'Submit yourself — this recipe does not submit on your behalf.'
    );

    // Give any post-click navigation or AJAX confirmation a moment to settle,
    // then check whether a submission actually appears to have happened —
    // don't just assume it did because the pause resolved.
    await page.waitForTimeout(1500);
    const currentUrl = page.url();
    const pageText = await page.evaluate(() => document.body.innerText).catch(() => '');
    const looksSubmitted =
      currentUrl !== originalUrl || /thank you|message sent|we.?ll be in touch|successfully/i.test(pageText);

    if (!looksSubmitted) {
      throw new lib.HumanCheckpoint(
        'no_submission_detected',
        'No submission was detected after the pause — the page did not navigate and no confirmation ' +
          'text was found. If you did submit and this is a false negative, check manually; otherwise ' +
          'the form was filled but never sent.',
        maskSelectors
      );
    }

    return {
      status: lib.STATUS.CALLBACK_REQUIRED,
      failure_reason: null,
      outcome: {
        exact_quote_or_estimate: 'estimate',
        eligibility_result: 'pending_broker_callback',
        next_action: 'Await a callback from a Staebler broker — no price or coverage is disclosed at this step.',
      },
      maskSelectors,
    };
  },
};
