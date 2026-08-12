#!/usr/bin/env node
'use strict';
/**
 * Runs one full quote-shopping session end to end, locally:
 *
 *   1. Read your planning_safe vault fields + orchestrator/profiles.json
 *      (non-sensitive vehicle/coverage variants you want to compare).
 *   2. POST to n8n's oqa-plan webhook — Claude (the brain) returns a route
 *      plan per profile.
 *   3. For each planned route, POST to the local worker (worker/server.js),
 *      which alone touches the vault and the actual insurer/broker sites.
 *   4. POST the redacted results to n8n's oqa-compare webhook — Claude
 *      normalizes and compares them.
 *   5. Print the summary and write a redacted run report to
 *      docs/run_reports/<run_id>.json (machine-shaped, for reuse/debugging)
 *      and docs/run_reports/<run_id>.md (the human-readable version of the
 *      same data — this is the one to actually read). Both are safe to
 *      commit and are among the challenge submission deliverables.
 *
 * Nothing sensitive passes through this script or through n8n/Claude at any
 * point — see docs/ARCHITECTURE.md.
 *
 * Error handling / timeouts / retries, by design:
 *   - Calls to n8n (Claude) get a generous timeout and a small exponential
 *     backoff retry — a rate limit or transient 5xx there is safe to retry,
 *     nothing side-effecting happens on the Claude side.
 *   - Calls to the local worker get an even longer timeout (long enough to
 *     comfortably outlast a human-in-the-loop pause inside a route) but are
 *     NEVER retried automatically — retrying a route means re-running a real
 *     browser session against a real site, which could double-submit a form.
 *     A worker-call failure for one route is recorded and the run moves on;
 *     it doesn't retry and it doesn't abort the whole session.
 *
 * Env vars:
 *   N8N_BASE_URL       required, e.g. https://your-n8n-host.example.com
 *   WORKER_BASE_URL     default http://127.0.0.1:8787
 *   CLAUDE_MODEL        default claude-sonnet-5
 *
 * Usage:
 *   N8N_BASE_URL=https://n8n.example.com node orchestrator/run_session.js [profiles.json]
 */
const fs = require('fs');
const path = require('path');
const vault = require('../vault/lib');
const { promptPassphrase } = require('../worker/lib/promptPassphrase');
const logger = require('../worker/lib/logger');

const ROOT = path.join(__dirname, '..');
const N8N_BASE_URL = process.env.N8N_BASE_URL;
const WORKER_BASE_URL = process.env.WORKER_BASE_URL || 'http://127.0.0.1:8787';
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-5';

const N8N_TIMEOUT_MS = Number(process.env.OQA_N8N_TIMEOUT_MS) || 2 * 60 * 1000; // Claude tool-calls + a full registry payload can take a bit
const WORKER_TIMEOUT_MS = Number(process.env.OQA_WORKER_TIMEOUT_MS) || 20 * 60 * 1000; // must comfortably exceed the worker's own ~15 min route bound
const N8N_MAX_RETRIES = 3;

function readJson(relPath) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relPath), 'utf8'));
}

function planningSafeBaseline(passphrase, schema) {
  const status = vault.listFieldStatus(passphrase);
  const out = {};
  for (const fieldPath of Object.keys(status)) {
    if (!status[fieldPath]) continue;
    const [group, field] = fieldPath.split('.');
    const g = schema.groups[group];
    const f = g && g.fields.find((x) => x.name === field);
    if (f && f.sensitivity === 'planning_safe') {
      out[fieldPath] = vault.getField(passphrase, fieldPath);
    }
  }
  return out;
}

function validateProfilesConfig(cfg, sourcePath) {
  const problems = [];
  if (!cfg || typeof cfg !== 'object') problems.push('file does not contain a JSON object');
  if (!Array.isArray(cfg.profiles) || cfg.profiles.length === 0) {
    problems.push('"profiles" must be a non-empty array — see orchestrator/profiles.example.json');
  } else {
    cfg.profiles.forEach((p, i) => {
      if (!p.label) problems.push(`profiles[${i}] is missing "label"`);
    });
  }
  if (!cfg.benchmark_coverage || typeof cfg.benchmark_coverage !== 'object') {
    problems.push('"benchmark_coverage" must be an object — every route is compared against it');
  }
  if (problems.length) {
    throw new Error(`${sourcePath} is invalid:\n  - ${problems.join('\n  - ')}`);
  }
}

/** Fetch with a hard timeout via AbortController — nothing in this script waits forever. */
async function fetchWithTimeout(url, opts, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } catch (e) {
    if (e.name === 'AbortError') {
      const err = new Error(`${url} did not respond within ${Math.round(timeoutMs / 1000)}s`);
      err.isTimeout = true; // always worth retrying — this is a transport-level hiccup, not Claude's answer
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function postJson(url, body, timeoutMs) {
  const res = await fetchWithTimeout(
    url,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    timeoutMs
  );
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    const err = new Error(`${url} returned non-JSON (status ${res.status}): ${text.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  if (!res.ok) {
    // In this design n8n's Respond nodes always answer 200 (see below), so
    // reaching here means something failed before n8n even ran — wrong URL,
    // n8n itself down, a proxy/gateway error. Genuinely worth a retry.
    const err = new Error(`${url} returned ${res.status}: ${JSON.stringify(json)}`);
    err.status = res.status;
    throw err;
  }
  if (json.error) {
    // n8n's Claude-call branches respond 200 with a clean {error, error_status,
    // error_type} body on a Claude API failure, rather than letting the
    // workflow 500 with no usable message — see
    // n8n/ontario_quote_agent.workflow.json's Parse Route Plan / Parse
    // Comparison nodes. error_status/error_type carry through here so
    // isRetryable() below can actually classify the failure.
    const err = new Error(`${url} reported an error: ${json.error}`);
    err.status = json.error_status || null;
    err.apiErrorType = json.error_type || null;
    throw err;
  }
  return json;
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504, 529]);
const RETRYABLE_API_ERROR_TYPES = new Set(['rate_limit_error', 'overloaded_error', 'api_error', 'no_tool_call']);
const NON_RETRYABLE_STATUS = new Set([400, 401, 403, 404, 405, 413, 422]);
const NON_RETRYABLE_API_ERROR_TYPES = new Set(['invalid_request_error', 'authentication_error', 'permission_error', 'not_found_error']);

/**
 * "Worth retrying" vs "will never work no matter how many times you try."
 * Checked in this order: known-transient signals first (always retry those),
 * then known-fatal signals (never retry those), then a best-effort text
 * match on the message when neither status nor error_type came through, and
 * finally an unknown-failure default. Defaulting unknowns to retryable is a
 * deliberate choice — the cost of one wasted retry is a few seconds, the
 * cost of giving up too early on a real transient issue is the whole run.
 */
function isRetryable(e) {
  if (e.isTimeout) return true;
  if (e.status && NON_RETRYABLE_STATUS.has(e.status)) return false;
  if (e.apiErrorType && NON_RETRYABLE_API_ERROR_TYPES.has(e.apiErrorType)) return false;
  if (e.status && RETRYABLE_STATUS.has(e.status)) return true;
  if (e.apiErrorType && RETRYABLE_API_ERROR_TYPES.has(e.apiErrorType)) return true;
  // Neither a status nor a recognized error_type came through — fall back to
  // a heuristic read of the message text.
  if (/rate.?limit|overloaded|\b5\d\d\b|timeout|ECONNRESET|ECONNREFUSED|network/i.test(e.message)) return true;
  if (/\b(400|401|403|404)\b|invalid.?request|authentication|not.?found/i.test(e.message)) return false;
  return true; // unknown shape — default to retrying, see rationale above
}

/**
 * Small exponential backoff + jitter, used only for calls to n8n/Claude —
 * see the header comment for why worker calls are never retried here. Stops
 * immediately, without burning the remaining retry budget, on an error
 * classified as non-retryable (e.g. a bad API key retrying 3 more times
 * would just waste ~10 seconds confirming what the first attempt already
 * told us).
 */
async function postJsonWithRetry(url, body, { timeoutMs, retries = N8N_MAX_RETRIES } = {}) {
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    attempt += 1;
    try {
      return await postJson(url, body, timeoutMs);
    } catch (e) {
      const retryable = isRetryable(e);
      if (!retryable) {
        logger.log('n8n_call_failed_not_retryable', { url, attempt, status: e.status || null, apiErrorType: e.apiErrorType || null, message: e.message });
        throw e;
      }
      if (attempt > retries) {
        logger.log('n8n_call_failed_retries_exhausted', { url, attempt, retries, message: e.message });
        throw e;
      }
      const delay = Math.round(1000 * 2 ** (attempt - 1) * (0.5 + Math.random()));
      logger.log('n8n_call_retry', { url, attempt, retries, delayMs: delay, status: e.status || null, apiErrorType: e.apiErrorType || null, message: e.message });
      console.log(`  (retrying ${url} in ${Math.round(delay / 1000)}s — attempt ${attempt + 1}/${retries + 1}: ${e.message})`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

/** Turns the flat "coverage_configuration.xyz" -> value benchmark object into one readable line. */
function formatBenchmarkCoverage(benchmark) {
  if (!benchmark) return 'Not specified.';
  const b = (key) => benchmark[`coverage_configuration.${key}`];
  const parts = [];
  if (b('third_party_liability_limit') != null) parts.push(`$${Number(b('third_party_liability_limit')).toLocaleString()} third-party liability`);
  if (b('accident_benefits_selection')) parts.push(String(b('accident_benefits_selection')).replace(/_/g, ' '));
  if (b('dcpd')) parts.push(`DCPD ${b('dcpd')}`);
  if (b('own_damage_coverage')) parts.push(String(b('own_damage_coverage')).replace(/_/g, ' '));
  if (Array.isArray(b('endorsements')) && b('endorsements').length > 0) parts.push(`Endorsements: ${b('endorsements').join(', ')}`);
  if (Array.isArray(b('discounts_to_request')) && b('discounts_to_request').length > 0) parts.push(`Discounts requested: ${b('discounts_to_request').map((d) => String(d).replace(/_/g, ' ')).join(', ')}`);
  return parts.length > 0 ? parts.join(' | ') : 'Not specified.';
}

/**
 * Renders a compact, human-readable summary from the same finalReport data
 * the JSON file gets — the .json is the full record (for reuse/debugging),
 * this is the short version meant to actually be read: what vehicle, which
 * routes, what came back, and how each result differs from what was asked
 * for. Gaps/planning-notes/metrics stay JSON-only by design, not repeated
 * here. No new Claude call.
 */
function renderMarkdownReport(finalReport, benchmarkCoverage) {
  // For table cells: a real or literal newline would break Markdown table
  // syntax, so collapse to a space rather than a line break.
  const cleanInline = (s) => (typeof s === 'string' ? s.replace(/\\n/g, ' ').replace(/\n/g, ' ').trim() : s);
  const lines = [];
  lines.push(`# Ontario Quote Agent — Run Report`);
  lines.push('');
  lines.push(`Run: \`${finalReport.run_id}\` · Generated: ${finalReport.generated_at}`);
  lines.push('');
  lines.push(`**Requested coverage:** ${formatBenchmarkCoverage(benchmarkCoverage)}`);
  const effectiveDate = benchmarkCoverage && benchmarkCoverage['coverage_configuration.requested_effective_date'];
  if (effectiveDate) lines.push(`**Effective date:** ${effectiveDate}`);
  lines.push('');

  for (const profile of finalReport.profiles) {
    lines.push(`## ${profile.label}`);
    lines.push('');

    const attempted = (profile.worker_results || []).map((r) => r.registry_id);
    lines.push(`**Routes attempted:** ${attempted.length > 0 ? attempted.join(', ') : 'none'}`);
    lines.push('');

    if (profile.flags && profile.flags.length > 0) {
      lines.push('> **⚠ Safety flag raised during comparison** — the brain detected something anomalous ' +
        '(e.g. a value that looked sensitive where only planning_safe data should be) and stopped short ' +
        'of using it. This is the privacy safeguard working, not a routine gap — review before trusting ' +
        'this run\'s data flow.');
      for (const f of profile.flags) lines.push(`> - ${cleanInline(f.observed_at)} — ${cleanInline(f.description)}`);
      lines.push('');
    }

    if (profile.comparison_error) {
      lines.push(`_Comparison could not be completed: ${profile.comparison_error}_`);
      lines.push('');
      continue;
    }

    const results = profile.comparison && profile.comparison.results;
    if (!results || results.length === 0) {
      lines.push('_No results to report._');
      lines.push('');
      continue;
    }

    lines.push('| Route | Status | Annual Premium | Discounts | Additional Coverage | Deductible | Other Coverage Differences |');
    lines.push('|---|---|---|---|---|---|---|');
    for (const r of results) {
      const premium = r.price && r.price.annual_premium != null ? `$${Number(r.price.annual_premium).toLocaleString()}` : 'Not disclosed';

      let discounts = '—';
      if (r.discounts) {
        if (r.discounts.disclosed === false) discounts = 'Not disclosed';
        else if (Array.isArray(r.discounts.applied)) discounts = r.discounts.applied.length > 0 ? r.discounts.applied.join(', ') : 'None applied';
      }

      let additionalCoverage = '—';
      if (r.coverage && Array.isArray(r.coverage.additional_coverage)) {
        additionalCoverage = r.coverage.additional_coverage.length > 0 ? r.coverage.additional_coverage.join(', ') : 'None';
      }

      let deductible = '—';
      if (r.coverage && r.coverage.deductible_match) {
        deductible = r.coverage.deductible_match === 'matches_benchmark' ? 'Matches benchmark'
          : r.coverage.deductible_match === 'not_disclosed' ? 'Not disclosed'
          : r.coverage.deductible_match;
      }

      let otherDiff = '—';
      if (r.coverage && Array.isArray(r.coverage.variance_from_benchmark)) {
        otherDiff = r.coverage.variance_from_benchmark.length > 0 ? r.coverage.variance_from_benchmark.join('; ') : 'None';
      } else if (typeof r.variance_from_benchmark === 'string') {
        // Fallback for reports generated before results carried structured
        // price/coverage/discounts fields.
        otherDiff = r.variance_from_benchmark;
      }

      lines.push(`| ${r.registry_id} | ${r.status} | ${cleanInline(premium)} | ${cleanInline(discounts)} | ${cleanInline(additionalCoverage)} | ${cleanInline(deductible)} | ${cleanInline(otherDiff)} |`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

async function main() {
  if (!N8N_BASE_URL) {
    console.error('Set N8N_BASE_URL to your self-hosted n8n instance first.');
    process.exit(1);
  }

  const profilesPath = process.argv[2] || path.join(__dirname, 'profiles.json');
  if (!fs.existsSync(profilesPath)) {
    console.error(
      `No profiles file at ${profilesPath}. Copy orchestrator/profiles.example.json to ` +
        'orchestrator/profiles.json and edit it (vehicle/coverage variants only — no sensitive fields).'
    );
    process.exit(1);
  }
  const profilesConfig = JSON.parse(fs.readFileSync(profilesPath, 'utf8'));
  try {
    validateProfilesConfig(profilesConfig, profilesPath);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }

  const health = await fetchWithTimeout(`${WORKER_BASE_URL}/health`, {}, 5000).catch(() => null);
  if (!health || !health.ok) {
    console.error(`Local worker not reachable at ${WORKER_BASE_URL}. Start it first: cd worker && node server.js`);
    process.exit(1);
  }

  const schema = readJson('schema/intake_schema.json');
  const registry = readJson('registry/market_registry.json');
  const systemPrompt = fs.readFileSync(path.join(ROOT, 'brain', 'system_prompt.md'), 'utf8');
  const toolsSchema = readJson('brain/tools_schema.json');

  const passphrase = await promptPassphrase('Vault passphrase (kept in memory only): ');
  const baseline = planningSafeBaseline(passphrase, schema);

  const profiles = profilesConfig.profiles.map((p) => ({
    label: p.label,
    fields: { ...baseline, ...(p.overrides || {}) },
  }));

  const sessionElapsed = logger.timer();
  logger.log('session_started', { profileCount: profiles.length, n8nBaseUrl: N8N_BASE_URL });

  // Only send Claude the routes this session could actually run. The full
  // registry maps the whole Ontario market (32 rows) for the project's own
  // documentation purposes, but the brain's tool schema requires a reasoned
  // `excluded_routes` entry for every route it's given and doesn't plan —
  // asking it to individually justify skipping 27 routes with no recipe at
  // all (which requested_routes would silently discard downstream anyway)
  // is wasted reasoning that risks eating the response's token budget before
  // it gets to the routes that matter. mvp_routes is filtered the same way
  // routes is, so the two stay consistent — otherwise Claude sees routes
  // listed in mvp_routes with no matching entry in routes[] and reasonably
  // (but misleadingly) concludes they're "unresolved in the registry" when
  // they're really just outside this session's requested_routes. The
  // canonical registry.json on disk is never touched — this filtering is
  // request-scoped only.
  const allowedRoutes = new Set(profilesConfig.requested_routes || registry.mvp_routes || []);
  const filteredRegistry = {
    ...registry,
    routes: registry.routes.filter((r) => allowedRoutes.has(r.registry_id)),
    mvp_routes: (registry.mvp_routes || []).filter((id) => allowedRoutes.has(id)),
  };

  console.log(`\nRequesting route plan for ${profiles.length} profile(s) from ${N8N_BASE_URL} ...`);
  console.log(`  (registry filtered to ${filteredRegistry.routes.length}/${registry.routes.length} routes this session can actually run)`);
  let planResp;
  try {
    planResp = await postJsonWithRetry(
      `${N8N_BASE_URL}/webhook/oqa-plan`,
      { model: CLAUDE_MODEL, system_prompt: systemPrompt, tools: toolsSchema.tools, registry: filteredRegistry, profiles },
      { timeoutMs: N8N_TIMEOUT_MS }
    );
  } catch (e) {
    logger.log('plan_call_failed', { message: e.message });
    console.error(`\nCould not get a route plan: ${e.message}`);
    process.exit(1);
  }

  if (planResp.flags && planResp.flags.length > 0) {
    logger.log('plan_flagged_anomaly', { count: planResp.flags.length });
    console.error('\nThe brain flagged something anomalous in the plan request — aborting run:');
    for (const f of planResp.flags) console.error(' -', f.observed_at, '—', f.description);
    process.exit(1);
  }

  if (planResp.raw_stop_reason === 'max_tokens') {
    logger.log('plan_response_truncated', { runId: planResp.run_id });
    console.error(
      '\nWARNING: Claude\'s planning response was cut off by the max_tokens limit before it finished — ' +
        'the route plan below is likely incomplete or missing entirely (this is NOT the same as Claude ' +
        'deciding to plan zero routes). Raise max_tokens on the "Claude — Plan Routes" node in the n8n ' +
        'workflow and try again.'
    );
  }

  const runId = planResp.run_id;
  const finalReport = { run_id: runId, generated_at: new Date().toISOString(), profiles: [] };
  // Rough usage visibility, not a hard cost control — every Claude call's
  // token usage (from the Messages API response) gets tallied into the run
  // report so at least nothing about spend is invisible after the fact.
  const claudeUsageByCall = [{ call: 'plan', usage: planResp.usage || null }];

  for (const routePlan of planResp.route_plans || []) {
    const profileLabel = routePlan.profile_label;
    console.log(`\n[${profileLabel}] Planned routes:`);
    const plannedRoutes = (routePlan.routes || []).filter((r) => allowedRoutes.has(r.registry_id));
    for (const r of routePlan.routes || []) {
      const inScope = allowedRoutes.has(r.registry_id) ? '' : '  (skipped — not in requested_routes)';
      console.log(`  - ${r.registry_id} (priority ${r.priority})${inScope}`);
    }
    if ((routePlan.routes || []).length === 0) {
      console.log('  (none)');
    }
    for (const ex of routePlan.excluded_routes || []) {
      console.log(`  x ${ex.registry_id} — excluded: ${ex.reason}`);
    }
    if (routePlan.notes) {
      console.log(`  Notes: ${routePlan.notes}`);
    }

    const results = [];
    for (const r of plannedRoutes) {
      console.log(`  Running ${r.registry_id} ...`);
      const routeElapsed = logger.timer();
      try {
        // No retry here by design — see header comment. A single worker call,
        // with a timeout long enough to include a human-in-the-loop pause.
        const result = await postJson(`${WORKER_BASE_URL}/run/${r.registry_id}`, { params: r.params }, WORKER_TIMEOUT_MS);
        results.push(result);
        logger.log('orchestrator_route_result', { registryId: r.registry_id, status: result.status, durationMs: routeElapsed() });
        console.log(`    -> ${result.status}`);
      } catch (e) {
        logger.log('orchestrator_route_call_failed', { registryId: r.registry_id, message: e.message, durationMs: routeElapsed() });
        console.log(`    -> unreachable (${e.message})`);
        results.push({ registry_id: r.registry_id, status: 'unreachable', failure_reason: e.message });
      }
    }

    console.log(`  Requesting comparison for [${profileLabel}] ...`);
    let compareResp;
    try {
      compareResp = await postJsonWithRetry(
        `${N8N_BASE_URL}/webhook/oqa-compare`,
        {
          model: CLAUDE_MODEL,
          system_prompt: systemPrompt,
          tools: toolsSchema.tools,
          run_id: runId,
          profile_label: profileLabel,
          benchmark_coverage: profilesConfig.benchmark_coverage,
          results,
        },
        { timeoutMs: N8N_TIMEOUT_MS }
      );
    } catch (e) {
      logger.log('compare_call_failed', { profileLabel, message: e.message });
      console.error(`  Could not get a comparison for [${profileLabel}]: ${e.message}`);
      finalReport.profiles.push({ label: profileLabel, route_plan: routePlan, worker_results: results, comparison: null, comparison_error: e.message });
      continue;
    }

    if (compareResp.flags && compareResp.flags.length > 0) {
      logger.log('compare_flagged_anomaly', { profileLabel, count: compareResp.flags.length });
      console.error(`  The brain flagged something anomalous while comparing [${profileLabel}]:`);
      for (const f of compareResp.flags) console.error('   -', f.observed_at, '—', f.description);
    }

    if (compareResp.raw_stop_reason === 'max_tokens') {
      logger.log('compare_response_truncated', { profileLabel });
      console.error(
        `  WARNING: Claude's comparison response for [${profileLabel}] was cut off by the max_tokens ` +
          'limit — the comparison below is likely incomplete. Raise max_tokens on the "Claude — Compare" ' +
          'node in the n8n workflow and re-run the comparison.'
      );
    }

    claudeUsageByCall.push({ call: `compare:${profileLabel}`, usage: compareResp.usage || null });

    finalReport.profiles.push({
      label: profileLabel,
      route_plan: routePlan,
      worker_results: results,
      comparison: compareResp.comparison,
      flags: compareResp.flags || [],
    });

    if (compareResp.comparison && compareResp.comparison.summary_text) {
      console.log(`\n[${profileLabel}] Summary:\n${compareResp.comparison.summary_text}\n`);
    }
  }

  const totalTokens = claudeUsageByCall.reduce(
    (sum, c) => sum + (c.usage ? (c.usage.input_tokens || 0) + (c.usage.output_tokens || 0) : 0),
    0
  );
  finalReport.claude_usage = { by_call: claudeUsageByCall, total_tokens: totalTokens };
  console.log(`\nClaude usage this run: ~${totalTokens} tokens across ${claudeUsageByCall.length} call(s).`);

  logger.log('session_finished', { runId, durationMs: sessionElapsed(), totalTokens });

  const reportDir = path.join(ROOT, 'docs', 'run_reports');
  fs.mkdirSync(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, `${runId}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(finalReport, null, 2));
  console.log(`\nRedacted run report written to ${path.relative(ROOT, reportPath)}`);

  const mdReportPath = path.join(reportDir, `summary_${runId.replace(/^run_/, '')}.md`);
  fs.writeFileSync(mdReportPath, renderMarkdownReport(finalReport, profilesConfig.benchmark_coverage));
  console.log(`Human-readable summary written to ${path.relative(ROOT, mdReportPath)}`);
}

main().catch((e) => {
  logger.log('session_crashed', { message: e.message });
  console.error(e.message);
  process.exit(1);
});
