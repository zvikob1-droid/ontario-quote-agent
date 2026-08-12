'use strict';
/**
 * Structured JSON-lines logger for the worker. Every entry is a flat object
 * of NAMES and STATUSES, never values — the same discipline as the rest of
 * this project: field names like "licence_identity.ontario_drivers_licence_number"
 * are fine to log, the actual licence number is not. Callers are responsible
 * for never passing a real field value into `fields`.
 *
 * Writes to both stdout (so `node server.js` shows live activity) and a local
 * append-only file at worker/logs/worker.jsonl (git-ignored).
 */
const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, '..', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'worker.jsonl');

function ensureLogDir() {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

function log(event, fields = {}) {
  const entry = { ts: new Date().toISOString(), event, ...fields };
  const line = JSON.stringify(entry);
  console.log(`[${entry.ts}] ${event}${Object.keys(fields).length ? ' ' + JSON.stringify(fields) : ''}`);
  try {
    ensureLogDir();
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch (e) {
    // logging must never crash the run it's observing
  }
}

function timer() {
  const start = Date.now();
  return () => Date.now() - start;
}

module.exports = { log, timer, LOG_FILE };
