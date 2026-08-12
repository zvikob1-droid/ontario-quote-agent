'use strict';
/**
 * One-time hidden passphrase prompt, used only when the worker process starts.
 * The passphrase is held in memory for the life of the process and is never
 * written to disk, logged, or sent over the worker's HTTP API.
 */
const readline = require('readline');

function promptPassphrase(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    if (!process.stdin.isTTY) {
      // Allows scripted/local testing without a real terminal. Never used in
      // the documented real-run path, where the worker is started by hand.
      rl.question(question, (answer) => {
        rl.close();
        resolve(answer);
      });
      return;
    }
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
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

module.exports = { promptPassphrase };
