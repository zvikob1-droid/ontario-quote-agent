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

// Loaded once at require time — same files the orchestrator sends to n8n
// for planning/comparison, read locally here since the worker is a local
// process with its own filesystem access (same reasoning n8n/README.md
// gives for why the orchestrator, not n8n, reads these off disk).
const SCHEMA = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'schema', 'intake_schema.json'), 'utf8'));
const SYSTEM_PROMPT = fs.readFileSync(path.join(__dirname, '..', '..', 'brain', 'system_prompt.md'), 'utf8');
const TOOLS_SCHEMA = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'brain', 'tools_schema.json'), 'utf8'));

function flatSchemaFieldPaths() {
  const paths = [];
  for (const [group, g] of Object.entries(SCHEMA.groups)) {
    for (const f of g.fields || []) {
      paths.push(`${group}.${f.name}`);
    }
  }
  return paths;
}

function fieldSensitivity(fieldPath) {
  const [group, field] = fieldPath.split('.');
  const g = SCHEMA.groups[group];
  if (!g) return null;
  const f = g.fields.find((x) => x.name === field);
  return f ? f.sensitivity : null;
}

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

/**
 * page.fill() sets the value directly and only fires 'input'/'change' —
 * confirmed live on Rates.ca that a site can gate a submit button's
 * disabled state on a real 'keyup' event specifically
 * (pincodeElement.addEventListener('keyup', ...) in its own JS), which
 * fill() never triggers no matter what value is set. A synthetic keyup
 * after fill is a harmless no-op on any site that doesn't need it, so this
 * runs unconditionally rather than only where it's been confirmed necessary.
 */
async function dispatchKeyupDefensively(page, selector) {
  await page.dispatchEvent(selector, 'keyup').catch(() => {});
}

/**
 * Confirmed live on Rates.ca: the same field id can appear 3 times on one
 * page (plausibly duplicate markup across responsive breakpoints), and
 * Playwright's default behaviour is to silently proceed with the first
 * match rather than the one actually on screen — which then hangs waiting
 * for a hidden element to become interactable. Every recipe interaction
 * goes through these functions, so scoping to :visible here fixes this
 * class of bug everywhere at once rather than requiring each recipe to
 * remember to add it per selector. Idempotent if a selector already ends
 * in :visible.
 */
function scopeToVisible(selector) {
  const trimmed = selector.trim();
  if (trimmed.endsWith(':visible')) return trimmed;
  // Confirmed live: Playwright's `>> nth=N` chains an index onto the prior
  // selector segment (used throughout this recipe for date-group fields —
  // one label, several selects, addressed by position). Appending :visible
  // to the very end produces `...>> nth=0:visible`, which is invalid syntax
  // and matches nothing — :visible has to attach to the element clause
  // *before* the >> nth=N chain, not after it.
  const chainSplit = trimmed.lastIndexOf(' >> ');
  if (chainSplit !== -1 && /^nth=\d+$/.test(trimmed.slice(chainSplit + 4).trim())) {
    return `${trimmed.slice(0, chainSplit)}:visible${trimmed.slice(chainSplit)}`;
  }
  return `${trimmed}:visible`;
}

async function fillFromVault(page, selector, vaultFieldPath, vaultPassphrase) {
  const value = await resolveVaultValue(vaultFieldPath, vaultPassphrase);
  const scoped = scopeToVisible(selector);
  // Tracked before the attempt, not after — a fill that "fails" can still
  // have partially entered characters into the page before erroring out, so
  // the selector must be masked regardless of whether this call succeeds.
  trackMaskSelector(page, scoped);
  try {
    await page.fill(scoped, String(value));
  } catch (e) {
    throw sanitizedFillError(e, vaultFieldPath);
  }
  await dispatchKeyupDefensively(page, scoped);
  logger.log('field_filled', { field: vaultFieldPath, sensitivity: 'vault_only' });
}

/** Non-sensitive fill — value comes from the job params (n8n), not the vault. */
async function fillPlanning(page, selector, value) {
  const scoped = scopeToVisible(selector);
  await page.fill(scoped, String(value));
  await dispatchKeyupDefensively(page, scoped);
}

/**
 * Same as fillFromVault, but for a <select> dropdown — Playwright needs
 * selectOption(), not fill(), for these. Same missing-field pause behaviour.
 */
async function selectFromVault(page, selector, vaultFieldPath, vaultPassphrase) {
  const value = await resolveVaultValue(vaultFieldPath, vaultPassphrase);
  const scoped = scopeToVisible(selector);
  trackMaskSelector(page, scoped);
  try {
    await page.selectOption(scoped, String(value));
  } catch (e) {
    throw sanitizedFillError(e, vaultFieldPath);
  }
  logger.log('field_filled', { field: vaultFieldPath, sensitivity: 'vault_only', kind: 'select' });
}

/** Non-sensitive <select> — value comes from job params, not the vault. */
async function selectPlanning(page, selector, value) {
  await page.selectOption(scopeToVisible(selector), String(value));
}

/** Non-sensitive checkbox/radio toggle — never used for a consent/agreement control (see pauseForHuman). */
async function checkPlanning(page, selector, checked = true) {
  const scoped = scopeToVisible(selector);
  if (checked) await page.check(scoped);
  else await page.uncheck(scoped);
}

/**
 * For a vault_only value a recipe already resolved and derived locally
 * (e.g. splitting identity.legal_name into first/last, or
 * identity.date_of_birth into month/day/year) rather than reading fresh
 * via fillFromVault/selectFromVault. Using fillPlanning/selectPlanning for
 * these would skip the sanitized-error protection those values need just
 * as much as any other vault_only field — a failed fill/select could leak
 * the real name/DOB/etc. into failure_reason exactly like the postal code
 * incident. fieldLabel is only ever used in the error message, never the
 * value.
 */
async function fillSensitive(page, selector, value, fieldLabel) {
  const scoped = scopeToVisible(selector);
  trackMaskSelector(page, scoped);
  try {
    await page.fill(scoped, String(value));
  } catch (e) {
    throw sanitizedFillError(e, fieldLabel);
  }
  await dispatchKeyupDefensively(page, scoped);
  logger.log('field_filled', { field: fieldLabel, sensitivity: 'vault_only' });
}

/** Same as fillSensitive, but for a <select> dropdown. */
async function selectSensitive(page, selector, value, fieldLabel) {
  const scoped = scopeToVisible(selector);
  trackMaskSelector(page, scoped);
  try {
    await page.selectOption(scoped, String(value));
  } catch (e) {
    throw sanitizedFillError(e, fieldLabel);
  }
  logger.log('field_filled', { field: fieldLabel, sensitivity: 'vault_only', kind: 'select' });
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

// Same three patterns the n8n workflow's own input guardrail checks —
// duplicated here deliberately (defense in depth, not trust-the-network):
// even if n8n's check were ever bypassed, disabled, or out of sync, this
// worker-local check still stands between a live page and the outbound
// request that leaves this machine.
const RESOLVE_FIELDS_SUSPECT_PATTERNS = [
  /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/, // email
  /(\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/, // phone number
  /\b[A-Za-z][0-9][A-Za-z]\s?[0-9][A-Za-z][0-9]\b/, // Canadian postal code
  /\d{9,}/, // long digit run — SIN/card/licence-shaped
];

const VALID_RESOLVE_STRATEGIES = new Set([
  'use_mapped_field_value',
  'use_today_date',
  'use_zero',
  'use_inferred_value',
  'pause_and_ask',
  'skip_and_disclose',
  'unresolved',
]);

/**
 * Mid-route consultation: the recipe hit a page question its static mapping
 * doesn't recognize (a changed field, a new validation rule, a format
 * mismatch, or a genuinely new question) and wants to know what to do.
 * `questions` must be plain structural facts only — label text, field type,
 * the site's own option list, visible validation error text, whether the
 * recipe could tell it's mandatory — built from the page's own labels/DOM,
 * never from an input's .value. `profileContext` is the same planning_safe
 * params the recipe already has (not new exposure — it's what this route
 * was already planned with), passed along so use_inferred_value has real
 * facts to reason from instead of guessing. This function never reads the
 * vault and never receives a vaultPassphrase; it structurally cannot leak a
 * vault_only value, regardless of what a recipe passes in, because it has
 * no path to one.
 *
 * Guardrails, both directions, both re-checked here even though n8n's own
 * workflow (n8n/ontario_quote_agent.workflow.json) already applies the same
 * checks — this is defense in depth, not a substitute for the network-side
 * checks:
 *   INPUT: the outbound payload (questions + profileContext) is scanned for
 *     value-shaped patterns (email/phone/postal code/long digit run) before
 *     it's ever sent: if any hit, nothing goes out and every question
 *     resolves to 'unresolved' locally.
 *   OUTPUT: every returned field_mapping is re-validated against the real
 *     schema field list, every strategy against the fixed keyword set, and
 *     every inferred_value against that specific question's own disclosed
 *     options — Claude cannot introduce a value the worker didn't already
 *     disclose as one of the site's own choices. Anything that doesn't
 *     match is discarded and forced to 'unresolved' rather than trusted.
 *
 * Returns one resolution per question: { question_id, field_mapping,
 * strategy, inferred_value, reason }. inferred_value is only ever one of
 * that question's own options, never invented text. Acting on
 * 'use_mapped_field_value' is still the recipe's job, reading the real
 * value itself (vault or params) exactly as it already does everywhere
 * else — this function never does that lookup itself.
 */
async function resolveFieldsWithBrain(questions, { n8nBaseUrl, routeId, runId, profileContext = {} }) {
  const unresolvedFallback = (reason) => questions.map((q) => ({
    question_id: q.question_id,
    field_mapping: null,
    strategy: 'unresolved',
    inferred_value: null,
    reason,
  }));

  if (!n8nBaseUrl) {
    logger.log('resolve_fields_no_n8n_url', { routeId });
    return unresolvedFallback('N8N_BASE_URL was not set on the worker — could not consult the brain.');
  }

  const flatText = JSON.stringify(questions) + JSON.stringify(profileContext);
  const tripped = RESOLVE_FIELDS_SUSPECT_PATTERNS.some((p) => p.test(flatText));
  if (tripped) {
    logger.log('resolve_fields_blocked_by_worker_guardrail', { routeId, runId });
    return unresolvedFallback('Blocked locally before being sent anywhere — the payload matched a pattern suggesting a real value rather than page structure.');
  }

  let data;
  try {
    const res = await fetch(`${n8nBaseUrl}/webhook/oqa-resolve-field`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        run_id: runId,
        system_prompt: SYSTEM_PROMPT,
        tools: TOOLS_SCHEMA.tools,
        valid_field_paths: flatSchemaFieldPaths(),
        questions,
        profile_context: profileContext,
      }),
    });
    data = await res.json();
  } catch (e) {
    logger.log('resolve_fields_call_failed', { routeId, runId, message: e.message });
    return unresolvedFallback(`Could not consult the brain: ${e.message}`);
  }

  if (data.error) {
    logger.log('resolve_fields_call_failed', { routeId, runId, message: data.error });
    return unresolvedFallback(`Could not consult the brain: ${data.error}`);
  }
  if (data.blocked_by_input_guardrail) {
    logger.log('resolve_fields_blocked_by_n8n_guardrail', { routeId, runId });
    return unresolvedFallback('Blocked by the n8n-side input guardrail before reaching Claude.');
  }

  const validFieldPaths = new Set(flatSchemaFieldPaths());
  const questionsById = new Map(questions.map((q) => [q.question_id, q]));
  return (data.resolutions || []).map((r) => {
    let fieldMapping = r.field_mapping;
    let strategy = r.strategy;
    let inferredValue = typeof r.inferred_value === 'string' ? r.inferred_value : null;
    let reason = typeof r.reason === 'string' ? r.reason : '';

    if (fieldMapping != null && !validFieldPaths.has(fieldMapping)) {
      reason = `(output guardrail discarded an invalid field_mapping) ${reason}`;
      fieldMapping = null;
      strategy = 'unresolved';
    }
    if (!VALID_RESOLVE_STRATEGIES.has(strategy)) {
      reason = `(output guardrail discarded an invalid strategy) ${reason}`;
      strategy = 'unresolved';
    }
    if (strategy === 'use_mapped_field_value' && !fieldMapping) {
      strategy = 'unresolved';
    }
    if (strategy === 'use_inferred_value') {
      const question = questionsById.get(r.question_id);
      const allowedOptions = new Set(Array.isArray(question && question.options) ? question.options : []);
      if (!inferredValue || !allowedOptions.has(inferredValue)) {
        reason = `(output guardrail discarded an inferred_value not present in this question's own options) ${reason}`;
        inferredValue = null;
        strategy = 'unresolved';
      }
    } else {
      inferredValue = null;
    }
    return { question_id: r.question_id, field_mapping: fieldMapping, strategy, inferred_value: inferredValue, reason };
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
  fillSensitive,
  selectSensitive,
  resolveFieldsWithBrain,
  fieldSensitivity,
  readVaultValue: resolveVaultValue,
  parseEvents,
  filterEventsWithinYears,
  boundedAttempt,
  withTimeout,
  pauseForHuman,
  logger,
};
