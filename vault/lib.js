'use strict';
/**
 * Local-only encrypted vault for sensitive intake fields.
 *
 * No network calls. No npm dependencies (Node's built-in `crypto` only, so there's
 * nothing to `npm install` before this can hold real data). Nothing in this file
 * ever prints a decrypted value — callers are responsible for not doing so either.
 *
 * Storage format: AES-256-GCM, key derived from a passphrase via scrypt with a
 * per-vault random salt. The encrypted blob lives at vault/store/vault.enc, which
 * is git-ignored.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const STORE_DIR = path.join(__dirname, 'store');
const STORE_FILE = path.join(STORE_DIR, 'vault.enc');

function deriveKey(passphrase, salt) {
  // N=2**14, r=8, p=1 needs ~16MB (128*N*r), safely under Node's default 32MB
  // scrypt maxmem. A higher N here trips ERR_CRYPTO_INVALID_SCRYPT_PARAMS.
  return crypto.scryptSync(passphrase, salt, 32, { N: 2 ** 14, r: 8, p: 1 });
}

function emptyStore() {
  return { fields: {}, created_at: new Date().toISOString() };
}

function exists() {
  return fs.existsSync(STORE_FILE);
}

function load(passphrase) {
  if (!exists()) return emptyStore();
  const raw = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
  const salt = Buffer.from(raw.salt, 'base64');
  const iv = Buffer.from(raw.iv, 'base64');
  const authTag = Buffer.from(raw.authTag, 'base64');
  const ciphertext = Buffer.from(raw.ciphertext, 'base64');
  const key = deriveKey(passphrase, salt);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  let plaintext;
  try {
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (e) {
    throw new Error('Could not decrypt vault — wrong passphrase or corrupted store.');
  }
  return JSON.parse(plaintext.toString('utf8'));
}

function save(passphrase, storeObj) {
  fs.mkdirSync(STORE_DIR, { recursive: true, mode: 0o700 });
  // Reuse the existing salt if the vault already exists, so the passphrase check
  // stays consistent across saves.
  let salt;
  if (exists()) {
    const raw = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    salt = Buffer.from(raw.salt, 'base64');
  } else {
    salt = crypto.randomBytes(16);
  }
  const key = deriveKey(passphrase, salt);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(storeObj), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const record = {
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
  fs.writeFileSync(STORE_FILE, JSON.stringify(record), { mode: 0o600 });
}

/** Set a single field. path is "group.field", e.g. "licence_identity.ontario_drivers_licence_number". */
function setField(passphrase, fieldPath, value) {
  const store = load(passphrase);
  store.fields[fieldPath] = value;
  store.updated_at = new Date().toISOString();
  save(passphrase, store);
}

/** Read a single field's raw value. Intended to be called only by the local worker, in-process. */
function getField(passphrase, fieldPath) {
  const store = load(passphrase);
  return store.fields[fieldPath];
}

/** List which fields are populated, WITHOUT returning their values. Safe to print. */
function listFieldStatus(passphrase) {
  const store = load(passphrase);
  return Object.keys(store.fields).sort().reduce((acc, k) => {
    const v = store.fields[k];
    acc[k] = v !== undefined && v !== null && v !== '';
    return acc;
  }, {});
}

function deleteAll() {
  if (exists()) fs.unlinkSync(STORE_FILE);
}

module.exports = { setField, getField, listFieldStatus, deleteAll, exists, STORE_FILE };
