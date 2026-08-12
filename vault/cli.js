#!/usr/bin/env node
'use strict';
/**
 * Local-only vault CLI. Run this directly on your own machine — never pipe its
 * output anywhere, never run it inside n8n, never paste values from it into a
 * chat with Claude or anyone else.
 *
 * Usage:
 *   node cli.js set <group.field>            Prompt (hidden input) and store one field
 *   node cli.js set-many <field> <field> ... Prompt for the passphrase once, then
 *                                             walk through each field's value in turn
 *   node cli.js list                         Show which fields are set (not their values)
 *   node cli.js delete-all                   Wipe the vault
 *   node cli.js export-planning-safe         Print only the non-sensitive fields, for
 *                                             pasting into n8n as the profile the brain
 *                                             is allowed to see
 */
const readline = require('readline');
const fs = require('fs');
const path = require('path');
const vault = require('./lib');

const SCHEMA = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'schema', 'intake_schema.json'), 'utf8')
);

function sensitivityOf(fieldPath) {
  const [group, field] = fieldPath.split('.');
  const g = SCHEMA.groups[group];
  if (!g) return null;
  const f = g.fields.find((x) => x.name === field);
  return f ? f.sensitivity : null;
}

const isTTY = !!process.stdin.isTTY;

// Piped/non-interactive stdin (scripted or testing use): readline's 'line'
// events for buffered input can fire before an await-deferred second
// question() call re-arms its listener, silently dropping the answer. Side-step
// that entirely by reading all of stdin up front and consuming it as a queue —
// there's no terminal echo to hide in this mode anyway.
let pipedLines = null;
function nextPipedLine() {
  if (pipedLines === null) {
    let raw = '';
    try {
      raw = fs.readFileSync(0, 'utf8');
    } catch (e) {
      raw = '';
    }
    pipedLines = raw.split('\n');
  }
  return pipedLines.shift() || '';
}

let sharedRl = null;
function getRl() {
  if (!sharedRl) {
    sharedRl = readline.createInterface({ input: process.stdin, output: process.stdout });
  }
  return sharedRl;
}

function promptHidden(question) {
  if (!isTTY) {
    process.stdout.write(question + '\n');
    return Promise.resolve(nextPipedLine());
  }
  const rl = getRl();
  return new Promise((resolve) => {
    process.stdout.write(question);
    let muted = false;
    // eslint-disable-next-line no-underscore-dangle
    const original = rl._writeToOutput.bind(rl);
    // eslint-disable-next-line no-underscore-dangle
    rl._writeToOutput = (str) => {
      if (!muted) original(str);
    };
    muted = true;
    rl.question('', (answer) => {
      // eslint-disable-next-line no-underscore-dangle
      rl._writeToOutput = original;
      rl.history = rl.history.slice(1);
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

function promptVisible(question) {
  if (!isTTY) {
    process.stdout.write(question + '\n');
    return Promise.resolve(nextPipedLine());
  }
  const rl = getRl();
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer));
  });
}

function closeRl() {
  if (sharedRl) sharedRl.close();
}

async function main() {
  const [, , cmd, arg] = process.argv;

  if (cmd === 'set') {
    if (!arg) {
      console.error('Usage: node cli.js set <group.field>');
      process.exit(1);
    }
    const sensitivity = sensitivityOf(arg);
    if (!sensitivity) {
      console.error(`Unknown field "${arg}". Check schema/intake_schema.json for valid group.field names.`);
      process.exit(1);
    }
    const passphrase = await promptHidden('Vault passphrase: ');
    const value = await promptHidden(`Value for ${arg} (${sensitivity}): `);
    vault.setField(passphrase, arg, value);
    console.log(`Stored ${arg}. (value not echoed)`);
    return;
  }

  if (cmd === 'set-many') {
    const fields = process.argv.slice(3);
    if (fields.length === 0) {
      console.error('Usage: node cli.js set-many <group.field> <group.field> ...');
      process.exit(1);
    }
    // Validate every field name up front — fail before asking for the
    // passphrase at all, rather than burning it on a batch that was doomed
    // by one typo partway through.
    const unknown = fields.filter((f) => !sensitivityOf(f));
    if (unknown.length > 0) {
      console.error(`Unknown field(s), check schema/intake_schema.json: ${unknown.join(', ')}`);
      process.exit(1);
    }
    const passphrase = await promptHidden('Vault passphrase: ');
    const stored = [];
    for (const field of fields) {
      const value = await promptHidden(`Value for ${field} (${sensitivityOf(field)}): `);
      vault.setField(passphrase, field, value);
      stored.push(field);
    }
    console.log(`\nStored ${stored.length} field(s) (values not echoed):`);
    for (const field of stored) console.log(`  ${field}`);
    return;
  }

  if (cmd === 'list') {
    const passphrase = await promptHidden('Vault passphrase: ');
    const status = vault.listFieldStatus(passphrase);
    if (Object.keys(status).length === 0) {
      console.log('Vault is empty.');
      return;
    }
    for (const [field, isSet] of Object.entries(status)) {
      console.log(`${isSet ? '✓' : '·'} ${field}`);
    }
    return;
  }

  if (cmd === 'delete-all') {
    const confirm = await promptVisible('Type DELETE to permanently wipe the vault: ');
    if (confirm === 'DELETE') {
      vault.deleteAll();
      console.log('Vault deleted.');
    } else {
      console.log('Cancelled.');
    }
    return;
  }

  if (cmd === 'export-planning-safe') {
    const passphrase = await promptHidden('Vault passphrase: ');
    const status = vault.listFieldStatus(passphrase);
    const out = {};
    for (const fieldPath of Object.keys(status)) {
      if (!status[fieldPath]) continue;
      if (sensitivityOf(fieldPath) !== 'planning_safe') continue; // hard filter — never export vault_only
      out[fieldPath] = vault.getField(passphrase, fieldPath);
    }
    console.log(JSON.stringify(out, null, 2));
    console.error('\n(Only planning_safe fields are shown above. vault_only fields are withheld by design.)');
    return;
  }

  console.log(`Ontario Quote Agent — local vault CLI

Commands:
  set <group.field>              Set one field (hidden input, never echoed)
  set-many <field> <field> ...   Passphrase once, then one value prompt per field
  list                           Show which fields are populated (not their values)
  export-planning-safe           Print only non-sensitive fields (safe for n8n/Claude)
  delete-all                     Wipe the vault

Field names come from schema/intake_schema.json, e.g.:
  node cli.js set licence_identity.ontario_drivers_licence_number
  node cli.js set vehicle_identity.vin
  node cli.js set vehicle_identity.model_year
`);
}

main()
  .catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  })
  .finally(closeRl);
