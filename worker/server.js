'use strict';
/**
 * Local-only automation worker HTTP API. Run this ONLY on your own machine —
 * never deploy it to the n8n cloud host or anywhere else reachable from the
 * internet. n8n calls this over your local network (or an SSH tunnel you
 * control) and receives back only redacted results — see
 * docs/ARCHITECTURE.md for the full trust-boundary explanation.
 *
 * Start: node server.js
 *   - Prompts once for your vault passphrase (hidden input), kept in memory
 *     for the life of this process only. Never written to disk, never logged,
 *     never included in an HTTP response.
 *   - Runs the browser headful (visible) by default, since human-in-the-loop
 *     checkpoints need you to actually see and act in the page. Set
 *     OQA_HEADLESS=true to run headless instead (fine for routes you know
 *     won't hit a human checkpoint, e.g. the still-incomplete stub recipes).
 *
 * API:
 *   GET  /health
 *   GET  /routes                       list available recipes
 *   POST /run/:routeId  { params }     run one route, params = non-sensitive
 *                                      job params only (see schema/intake_schema.json)
 */
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const { promptPassphrase } = require('./lib/promptPassphrase');
const lib = require('./lib/recipe_lib');
const logger = require('./lib/logger');

const PORT = process.env.OQA_WORKER_PORT || 8787;
const HEADLESS = process.env.OQA_HEADLESS === 'true';
const ROUTE_TIMEOUT_MS = Number(process.env.OQA_ROUTE_TIMEOUT_MS) || 15 * 60 * 1000; // 15 min — comfortably longer than pauseForHuman's default 10 min wait
const ACTION_TIMEOUT_MS = Number(process.env.OQA_ACTION_TIMEOUT_MS) || 20 * 1000; // per fill/click
const NAV_TIMEOUT_MS = Number(process.env.OQA_NAV_TIMEOUT_MS) || 30 * 1000; // per page navigation
const RECIPES_DIR = path.join(__dirname, 'recipes');

function loadRecipes() {
  const recipes = {};
  for (const file of fs.readdirSync(RECIPES_DIR)) {
    if (!file.endsWith('.js') || file.startsWith('_')) continue;
    const mod = require(path.join(RECIPES_DIR, file));
    recipes[mod.meta.registryId] = mod;
  }
  return recipes;
}

async function runRoute(recipes, routeId, params, vaultPassphrase) {
  const recipe = recipes[routeId];
  const runId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  const elapsed = logger.timer();

  if (!recipe) {
    logger.log('route_not_found', { routeId });
    return {
      registry_id: routeId,
      status: lib.STATUS.UNRESOLVED,
      failure_reason: `No recipe registered for "${routeId}". Check worker/recipes/.`,
      evidence: { timestamp: startedAt },
    };
  }

  logger.log('route_started', { routeId, runId, headless: HEADLESS });

  let browser;
  try {
    browser = await chromium.launch({ headless: HEADLESS });
  } catch (e) {
    // A launch failure is an infrastructure problem, not a market outcome —
    // keep it distinguishable from a route's own result via failure_reason,
    // but still return a normal (non-500) response the orchestrator can log.
    logger.log('browser_launch_failed', { routeId, message: e.message });
    return {
      registry_id: routeId,
      status: lib.STATUS.UNRESOLVED,
      failure_reason: `Browser failed to launch: ${e.message}. Try: npx playwright install chromium`,
      evidence: { timestamp: startedAt },
    };
  }

  const page = await browser.newPage();
  page.setDefaultTimeout(ACTION_TIMEOUT_MS);
  page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);

  let result;
  try {
    const outcome = await lib.boundedAttempt(() =>
      lib.withTimeout(
        recipe.run(page, { lib, params, vaultPassphrase, routeId, runId }),
        ROUTE_TIMEOUT_MS,
        new lib.RouteTimeout(`Route exceeded ${Math.round(ROUTE_TIMEOUT_MS / 1000)}s overall.`)
      )
    );
    result = {
      registry_id: routeId,
      status: outcome.status || lib.STATUS.UNRESOLVED,
      ...outcome,
    };
    logger.log('route_finished', { routeId, runId, status: result.status, durationMs: elapsed() });
  } catch (e) {
    const status = e.status || lib.STATUS.UNRESOLVED;
    result = {
      registry_id: routeId,
      status,
      failure_reason: e.message,
      // A HumanCheckpoint/Blocked/RouteTimeout/HumanTimeout/HumanAborted
      // thrown after a recipe already typed a vault_only value into the page
      // carries its own maskSelectors — the evidence screenshot below must
      // still redact those fields even though the recipe stopped via an
      // exception rather than a normal return.
      maskSelectors: e.maskSelectors || [],
    };
    logger.log('route_ended_with_error', { routeId, runId, status, errorType: e.name || 'Error', durationMs: elapsed() });
  }

  let evidenceRef = null;
  try {
    evidenceRef = await lib.captureRedactedEvidence(page, {
      routeId,
      runId,
      label: 'final',
      maskSelectors: (result && result.maskSelectors) || [],
    });
  } catch (e) {
    logger.log('evidence_capture_failed', { routeId, runId, message: e.message });
    // evidence capture failing shouldn't hide the underlying result
  }

  await browser.close().catch(() => {});

  delete result.maskSelectors;
  return {
    ...result,
    evidence: {
      timestamp: startedAt,
      redacted_artifact_ref: evidenceRef,
    },
  };
}

function send(res, code, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(body);
}

async function main() {
  const vaultPassphrase = await promptPassphrase('Vault passphrase (kept in memory only): ');
  const recipes = loadRecipes();

  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      return send(res, 200, { ok: true, routes: Object.keys(recipes), headless: HEADLESS });
    }
    if (req.method === 'GET' && req.url === '/routes') {
      return send(res, 200, { routes: Object.keys(recipes) });
    }
    const match = req.method === 'POST' && req.url.match(/^\/run\/([a-z0-9_]+)$/i);
    if (match) {
      const routeId = match[1];
      let body = '';
      let tooLarge = false;
      req.on('data', (chunk) => {
        body += chunk;
        if (body.length > 1e6) {
          tooLarge = true;
          req.destroy();
        }
      });
      req.on('end', async () => {
        if (tooLarge) return; // connection already destroyed, nothing to respond to
        let params = {};
        try {
          const parsed = body ? JSON.parse(body) : {};
          params = parsed.params || {};
          if (typeof params !== 'object' || Array.isArray(params) || params === null) {
            return send(res, 400, { error: '"params" must be a JSON object of planning_safe field -> value.' });
          }
        } catch (e) {
          return send(res, 400, { error: 'Invalid JSON body' });
        }
        try {
          const result = await runRoute(recipes, routeId, params, vaultPassphrase);
          send(res, 200, result);
        } catch (e) {
          logger.log('unhandled_worker_error', { routeId, message: e.message });
          send(res, 500, { error: e.message });
        }
      });
      req.on('error', (e) => {
        logger.log('request_stream_error', { routeId, message: e.message });
      });
      return;
    }
    send(res, 404, { error: 'Not found' });
  });

  // Node's own default requestTimeout (5 min as of Node 18+) would otherwise
  // kill a connection mid-route if a human checkpoint is taking its time —
  // raise it comfortably past ROUTE_TIMEOUT_MS so our own timeout logic is
  // what actually governs, not an unrelated HTTP-layer default.
  server.requestTimeout = ROUTE_TIMEOUT_MS + 5 * 60 * 1000;

  server.listen(PORT, '127.0.0.1', () => {
    logger.log('worker_started', { port: PORT, headless: HEADLESS, routes: Object.keys(recipes) });
    console.log(`Worker listening on http://127.0.0.1:${PORT} (loopback only)`);
    console.log(`Routes: ${Object.keys(recipes).join(', ')}`);
    console.log(`Browser mode: ${HEADLESS ? 'headless' : 'headful (visible)'}`);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
