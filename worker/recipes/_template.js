'use strict';
/**
 * TEMPLATE — copy this file to add a new route recipe.
 *
 * A recipe exports:
 *   - meta: { registryId, entryUrl }   registryId must match registry/market_registry.json
 *   - run(page, ctx): async function that drives a Playwright `page` and returns
 *     a partial result (server.js fills in evidence/confidence/timestamps).
 *
 * ctx = {
 *   params,           non-sensitive job params sent by n8n (vehicle year/make/
 *                     model, coverage config, postal FSA, etc.) — see
 *                     schema/intake_schema.json for what's planning_safe
 *   vaultPassphrase,  held in memory by server.js, passed through so this
 *                     recipe can call lib.fillFromVault() — never log it,
 *                     never put it in an error message
 *   routeId, runId,   for evidence file naming
 *   lib,              worker/lib/recipe_lib.js — fillFromVault, fillPlanning,
 *                     captureRedactedEvidence, pauseForHuman, HumanCheckpoint,
 *                     Blocked, RouteTimeout, HumanTimeout, HumanAborted, STATUS
 * }
 *
 * Rules every recipe must follow (see docs/ARCHITECTURE.md §5):
 *   - For a CAPTCHA that a human could plausibly solve, or a final
 *     review-before-submit step, prefer `await ctx.lib.pauseForHuman(message)`
 *     over throwing outright — it pauses in the worker's own terminal until
 *     you press Enter (or "abort"), then lets the recipe keep running in the
 *     *same* browser session to check what happened next. See
 *     recipes/local_independent_broker.js for a worked example, including
 *     the after-the-pause outcome check.
 *   - Stop with `throw new ctx.lib.HumanCheckpoint(name, detail)` before any
 *     identity/database lookup, consent attestation, signature, payment, or
 *     purchase action that pauseForHuman doesn't cover. Never click through
 *     one.
 *   - Stop with `throw new ctx.lib.Blocked(detail)` at a hard anti-automation
 *     barrier with no human-solvable challenge. Never attempt to solve or
 *     bypass an access control yourself — a human solving their own CAPTCHA
 *     via pauseForHuman is not the same thing as automating past one.
 *   - Never invent, fabricate, or reuse someone else's licence number. If a
 *     required vault field is empty, fillFromVault() already throws
 *     HumanCheckpoint('missing_vault_field', ...) for you.
 *   - Page actions already carry default timeouts (~20s) and the whole route
 *     is bounded (~15 min) by server.js — no need to add your own timeouts
 *     unless a specific step needs something different.
 *   - Call ctx.lib.captureRedactedEvidence() with a maskSelectors list
 *     covering every field you just filled from the vault, before returning
 *     — or pass `maskSelectors` on a thrown HumanCheckpoint/Blocked if you're
 *     stopping instead of returning (see recipe_lib.js).
 */
module.exports = {
  meta: {
    registryId: 'REPLACE_ME',
    entryUrl: 'https://example.com/quote',
  },

  async run(page, ctx) {
    const { lib, params, vaultPassphrase, routeId, runId } = ctx;

    await page.goto(module.exports.meta.entryUrl, { waitUntil: 'domcontentloaded' });

    // TODO: handle cookie/consent banner if present (decline non-essential).
    // TODO: fill non-sensitive fields via lib.fillPlanning(page, selector, params.field)
    // TODO: fill sensitive fields via await lib.fillFromVault(page, selector, 'group.field', vaultPassphrase)
    // TODO: stop before any identity/declaration/payment step:
    //   throw new lib.HumanCheckpoint('application_declaration');

    throw new lib.HumanCheckpoint(
      'recipe_incomplete',
      'This recipe has not been captured against the live site yet. Run: ' +
        `npx playwright codegen ${module.exports.meta.entryUrl}`
    );
  },
};
