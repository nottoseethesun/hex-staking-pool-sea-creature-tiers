/**
 * @file src/secrets/prompt.js
 * @description Tiny stdin prompt helpers shared by the CLI `secret` command and
 * the headless server startup: `promptHidden` reads a line with the terminal echo
 * muted (for passphrases and secret values), `promptLine` reads a visible line.
 * Neither ever logs the input.
 */

"use strict";

const readline = require("node:readline");

/**
 * Read one line from stdin, optionally with the echo muted.
 * @param {string} query
 * @param {boolean} mute
 * @returns {Promise<string>}
 */
function ask(query, mute) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });
    process.stdout.write(query);
    if (mute) rl._writeToOutput = () => {}; // suppress echo of typed characters
    rl.question("", (answer) => {
      rl.close();
      if (mute) process.stdout.write("\n");
      resolve(answer.trim());
    });
  });
}

/** @param {string} query @returns {Promise<string>} an echo-muted line */
function promptHidden(query) {
  return ask(query, true);
}

/** @param {string} query @returns {Promise<string>} a visible line */
function promptLine(query) {
  return ask(query, false);
}

module.exports = { promptHidden, promptLine };
