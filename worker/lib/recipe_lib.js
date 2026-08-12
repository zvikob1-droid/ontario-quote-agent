'use strict';
/**
 * Shared helpers for per-site recipes. A recipe is a plain async function
 * `run(page, ctx)` — see recipes/_template.js. Everything here exists to make
 * four things hard to get wrong: (1) sensitive values never leave the vault
 * except as a direct keystroke into the page, (2) a human checkpoint always
 * either pauses for a real person or stops outright — never gets automated
 * past, (3) every outcome ends with an evidence artifact and a status from
 * schema/quote_result_schema.json, (4) nothing hangs forever.
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const vault = require('../../vault/lib');
const logger = require('./logger');

const STATUS = Object.freeze({
  QUOTED_COMPARABLE: 'quoted_comparable',
  QUOTED_NON_COMPARABLE: 'quoted_non_comparable',
  ESTIMATE_ONLY: 'estimate_only',
  CALLBACK_REQUIRED: 'callback_required',
  MANUAL_HANDOFF: 'manual_handoff',
  INELIGIBLE: 'ineligible',
  AFFINITY_RESTRICTED: 'affinity_restricted',
  SPECIALTY_ONLY: 'specialty_only',
  DUPLICATE_RATE_SOURCE: 'duplicate_rate_source',
  NOT_CURRENTLY_WRITING: 'not_currently_writing',
  BLOCKED: 'blocked',
  UNREACHABLE: 'unreachable',
  UNRESOLVED: 'unresolved',
});

/** Thrown by a recipe when it reaches a required human checkpoint. Never caught-and-bypassed. */
class HumanCheckpoint extends Error {
  constructor(checkpointName, detail, maskSelectors = []) {
    super(`Human checkpoint reached: ${checkpointName}${detail ? ' — ' + detail : ''}`);
    this.name = 'HumanCheckpoint';
    this.checkpointName = checkpointName;
    this.status = STATUS.MANUAL_HANDOFF;
    // Selectors for any vault_only value already typed into the page before this
    // was thrown — the evidence screenshot must mask these. Pass them whenever a
    // recipe stops *after* filling a sensitive field, not just before.
    this.maskSelectors = maskSelectors;
  }
}

/** Thrown when a CAPTCHA or explicit anti-automation barrier is hit and can't be human-solved. Never bypassed. */
class Blocked extends Error {
  constructor(detail, maskSelectors = []) {
    super(`Blocked: ${detail}`);
    this.name = 'Blocked';
    this.status = STATUS.BLOCKED;
    this.maskSelectors = maskSelectors;
  }
}

/** An automated step (navigation/action) ran past its own timeout. Not a human wait. */
class RouteTimeout extends Error {
  constructor(detail, maskSelectors = []) {
    super(`Timed out: ${detail}`);
    this.name = 'RouteTimeout';
    this.status = STATUS.UNREACHABLE;
    this.maskSelectors = maskSelectors;
  }
}

/** A human checkpoint was raised but nobody responded within the wait window. */
class HumanTimeout extends Error {
  constructor(detail, maskSelectors = []) {
    super(`No human response: ${detail}`);
    this.name = 'HumanTimeout';
    this.status = STATUS.UNRESOLVED;
    this.maskSelectors = maskSelectors;
  }
}

/** A human explicitly declined to continue at a checkpoint. Not a technical failure. */
class HumanAborted extends Error {
  constructor(detail, maskSelectors = []) {
    super(`Aborted by human: ${detail}`);
    this.name = 'HumanAborted';
    this.status = STATUS.MANUAL_HANDOFF;
    this.maskSelectors = maskSelectors;
  }
}

const EVIDENCE_DIR = path.join(__dirname, '..', 'evidence'); // git-ignored

function evidenceDirFor(routeId, runId) {
  const dir = path.join(EVIDENCE_DIR, routeId, runId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Screenshot the page and mask known sensitive on-screen regions before saving.
 * `maskSelectors` should include every field the recipe just filled with a
 * vault_only value (licence #, DOB, VIN, address, etc.).
 *
 * Masking works by covering each element with an opaque overlay box, not by
 * styling the element itself (e.g. -webkit-text-security). That trick only
 * ever obscured text/password-style inputs — it does nothing to a <select>,
 * whose chosen option renders via native OS/browser chrome the page can't
 * style. An overlay covers any element type the same way, so a masked
 * dropdown (DOB, gender, etc.) is actually hidden, not just assumed to be.
 */
async function captureRedactedEvidence(page, { routeId, runId, label, maskSelectors = [] }) {
  const overlayIds = [];
  for (const selector of maskSelectors) {
    const els = await page.$$(selector).catch(() => []);
    for (const el of els) {
      const overlayId = await el.evaluate((node) => {
        // Document-relative (not viewport-relative) coordinates — a fullPage
        // screenshot stitches together a scrolled capture, and a
        // position:fixed overlay only lines up correctly for one scroll
        // position, not the whole stitched image.
        const rect = node.getBoundingClientRect();
        const overlay = document.createElement('div');
        overlay.id = `oqa-mask-${Math.random().toString(36).slice(2)}`;
        overlay.style.cssText = [
          'position:absolute',
          `top:${rect.top + window.scrollY}px`,
          `left:${rect.left + window.scrollX}px`,
          `width:${rect.width}px`,
          `height:${rect.height}px`,
          'background:#111',
          'z-index:2147483647',
          'pointer-events:none',
        ].join(';');
        document.body.appendChild(overlay);
        return overlay.id;
      }).catch(() => null);
      if (overlayId) overlayIds.push(overlayId);
    }
  }
  const dir = evidenceDirFor(routeId, runId);
  const file = path.join(dir, `${Date.now()}_${label}.png`);
  await page.screenshot({ path: file, fullPage: true });
  // Clean up overlays in case the page/browser is reused after this call.
  await page.evaluate((ids) => {
    ids.forEach((id) => { const el = document.getElementById(id); if (el) el.remove(); });
  }, overlayIds).catch(() => {});
  logger.log('evidence_captured', { routeId, runId, label, maskedFieldCount: maskSelectors.length });
  return file; // reference only — never the raw pixel data goes back over HTTP
}

/**
 * Read one sensitive field from the vault and type it into a field, without
 * ever returning the value to the caller or logging it.
 *
 * If the field isn't set yet — a site asked a question your vault doesn't
 * have an answer for — this doesn't just kill the run. It pauses (same
 * mechanism as pauseForHuman elsewhere) so you can open another terminal,
 * run `node vault/cli.js set <field>` right then, and come back and press
 * Enter to let this route carry on from exactly where it stopped. The vault
 * file is shared on disk, so a value set in that other terminal is visible
 * here the moment you resume — no restart needed. Only if you abort, time
 * out, or the field is still empty after resuming does this route actually
 * end (as a manual_handoff/unresolved status) — and only *this* route ends;
 * other routes in the same run are unaffected.
 */
async function resolveVaultValue(vaultFieldPath, vaultPassphrase) {
  let value = vault.getField(vaultPassphrase, vaultFieldPath);
  if (value === undefined || value === null || value === '') {
    logger.log('vault_field_missing_pausing', { field: vaultFieldPath });
    await pauseForHuman(
      `This site is asking for "${vaultFieldPath}", which isn't in your vault yet.\n` +
        `  Open another terminal and run:\n` +
        `    node vault/cli.js set ${vaultFieldPath}\n` +
        `  Then come back here and press Enter to continue — or type "abort" to skip this route for now.`
    );
    // pauseForHuman only resolves (doesn't reject) if you didn't abort/time
    // out — re-read the vault now that you've had a chance to set it.
    value = vault.getField(vaultPassphrase, vaultFieldPath);
    if (value === undefined || value === null || value === '') {
      throw new HumanCheckpoint(
        'missing_vault_field_still_unset',
        `${vaultFieldPath} is still not set after the pause. Run: node vault/cli.js set ${vaultFieldPath}`
      );
    }
  }
  return value;
}

/**
 * Automatic, centralized tracking of every selector ever filled/selected
 * with a vault_only value on a given page — keyed by the page object so
 * each route's own Playwright page tracks independently. This exists
 * because relying on each recipe to remember to push into its own local
 * maskSelectors array, and on every thrown error to carry it, is fragile:
 * confirmed live, an unexpected failure partway through a recipe (after
 * earlier vault_only fields were already filled and still visible) would
 * reach worker/server.js's evidence capture with zero masking, since a
 * plain error has no maskSelectors of its own. Tracking here instead means
 * the evidence screenshot can always be masked correctly regardless of
 * which fields a recipe/error explicitly remembered to report.
 */
const pageMaskSelectors = new WeakMap();

function trackMaskSelector(page, selector) {
  if (!pageMaskSelectors.has(page)) pageMaskSelectors.set(page, []);
  pageMaskSelectors.get(page).push(selector);
}

/** Every selector automatically tracked as vault_only for this page so far. */
function getTrackedMaskSelectors(page) {
  return pageMaskSelectors.get(page) || [];
}

/**
 * A failed Playwright action on a vault_only value must never let the
 * caller see Playwright's own error message — a TimeoutError's message
 * embeds a full call log that echoes back the literal value the action
 * tried to type/select, which would leak a vault_only value into
 * failure_reason and from there toward n8n/Claude, a planning_safe-only
 * channel. Confirmed live: a postal code leaked this way when a Rates.ca
 * selector matched multiple elements and the fill timed out. Re-thrown
 * with the original error's name (retry classification and logging both
 * key off e.name) but a message that names only the field, never the
 * value or Playwright's raw call log.
 */
function sanitizedFillError(e, vaultFieldPath) {
  const sanitized = new Error(
    `Failed to fill vault_only field "${vaultFieldPath}" (${e.name || 'Error'}) — the value itself is never included in this error.`
  );
  sanitized.name = e.name || 'Error';
  return sanitized;
}

async function fillFromVault(page, selector, vaultFieldPath, vaultPassphrase) {
  const value = await resolveVaultValue(vaultFieldPath, vaultPassphrase);
  // Tracked before the attempt, not after — a fill that "fails" can still
  // have partially entered characters into the page before erroring out, so
  // the selector must be masked regardless of whether this call succeeds.
  trackMaskSelector(page, selector);
  try {
    await page.fill(selector, String(value));
  } catch (e) {
    throw sanitizedFillError(e, vaultFieldPath);
  }
  logger.log('field_filled', { field: vaultFieldPath, sensitivity: 'vault_only' });
}

/** Non-sensitive fill — value comes from the job params (n8n), not the vault. */
async function fillPlanning(page, selector, value) {
  await page.fill(selector, String(value));
}

/**
 * Same as fillFromVault, but for a <select> dropdown — Playwright needs
 * selectOption(), not fill(), for these. Same missing-field pause behaviour.
 */
async function selectFromVault(page, selector, vaultFieldPath, vaultPassphrase) {
  const value = await resolveVaultValue(vaultFieldPath, vaultPassphrase);
  trackMaskSelector(page, selector);
  try {
    await page.selectOption(selector, String(value));
  } catch (e) {
    throw sanitizedFillError(e, vaultFieldPath);
  }
  logger.log('field_filled', { field: vaultFieldPath, sensitivity: 'vault_only', kind: 'select' });
}

/** Non-sensitive <select> — value comes from job params, not the vault. */
async function selectPlanning(page, selector, value) {
  await page.selectOption(selector, String(value));
}

/** Non-sensitive checkbox/radio toggle — never used for a consent/agreement control (see pauseForHuman). */
async function checkPlanning(page, selector, checked = true) {
  if (checked) await page.check(selector);
  else await page.uncheck(selector);
}

/**
 * Bounded-attempt policy per the brief: one normal attempt plus one retry for
 * a transient technical error only. Never retries a rejection, CAPTCHA, or
 * human-checkpoint outcome (those propagate immediately without a retry) —
 * this is a deliberate politeness constraint on live insurer/broker sites,
 * not a gap. A short fixed delay (not exponential backoff) precedes the one
 * retry, since this is about tolerating a single flaky moment, not working
 * through sustained failure.
 */
async function boundedAttempt(fn, { retryDelayMs = 2000 } = {}) {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof Blocked || e instanceof HumanCheckpoint || e instanceof HumanTimeout || e instanceof HumanAborted) {
      throw e;
    }
    logger.log('bounded_attempt_retry', { reason: e.name || 'Error', message: e.message });
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    return await fn();
  }
}

/**
 * Parses a vault_only JSON-array-of-events field (accidents, tickets,
 * suspensions, cancellations — each event a plain object with at least a
 * `year`, ideally `month` too). Defaults to [] on anything unparseable.
 * Never logs contents.
 */
function parseEvents(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

/**
 * The vault stores every known event with its real date, not truncated to
 * any one lookback window — different sites ask different windows for the
 * same kind of history (e.g. accidents: 6 years per the OAF 1 baseline, but
 * 10 years on TD Insurance's form). Each recipe calls this with whatever
 * window *that* site actually asks for, rather than the vault deciding a
 * window up front and silently under-reporting to a site that asks further
 * back.
 */
function filterEventsWithinYears(events, years) {
  const cutoffYear = new Date().getFullYear() - years;
  return (events || []).filter((ev) => {
    const y = Number(ev && ev.year);
    return !Number.isNaN(y) && y >= cutoffYear;
  });
}

/**
 * Race any promise against a timeout, throwing `timeoutError` if it fires
 * first. Used to bound automated steps — never used to bound a human wait,
 * which has its own, more generous window via pauseForHuman.
 */
function withTimeout(promise, ms, timeoutError) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(timeoutError), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Pause the recipe and wait for a real person at the keyboard — used for a
 * CAPTCHA that needs solving, or a final review-and-click-Submit step the
 * automation deliberately leaves to a human. Runs in the worker process's own
 * terminal (the one running `node server.js`), not over HTTP, so nothing
 * about the pause or the wait crosses into n8n or Claude.
 *
 * Resolves once the human presses Enter. Rejects with HumanAborted if they
 * type "abort", or HumanTimeout if nobody responds within `timeoutMs`
 * (default 10 minutes — generous, since solving a CAPTCHA or reviewing a form
 * takes real human time, not automation time).
 */
function pauseForHuman(message, { timeoutMs = 10 * 60 * 1000 } = {}) {
  logger.log('human_checkpoint_opened', { message, timeoutMs });
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    process.stdout.write(`\n[HUMAN CHECKPOINT] ${message}\n`);
    process.stdout.write('Press Enter here once done, or type "abort" to cancel this route.\n> ');
    const timer = setTimeout(() => {
      rl.close();
      logger.log('human_checkpoint_timed_out', { timeoutMs });
      reject(new HumanTimeout(`No response within ${Math.round(timeoutMs / 1000)}s.`));
    }, timeoutMs);
    rl.question('', (answer) => {
      clearTimeout(timer);
      rl.close();
      if (String(answer).trim().toLowerCase() === 'abort') {
        logger.log('human_checkpoint_aborted', {});
        reject(new HumanAborted('You chose to abort at a human checkpoint.'));
      } else {
        logger.log('human_checkpoint_resumed', {});
        resolve();
      }
    });
  });
}

module.exports = {
  STATUS,
  HumanCheckpoint,
  Blocked,
  RouteTimeout,
  HumanTimeout,
  HumanAborted,
  captureRedactedEvidence,
  getTrackedMaskSelectors,
  fillFromVault,
  fillPlanning,
  selectFromVault,
  selectPlanning,
  checkPlanning,
  readVaultValue: resolveVaultValue,
  parseEvents,
  filterEventsWithinYears,
  boundedAttempt,
  withTimeout,
  pauseForHuman,
  logger,
};
