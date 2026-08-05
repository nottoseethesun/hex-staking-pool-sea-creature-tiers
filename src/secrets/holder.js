/**
 * @file src/secrets/holder.js
 * @description Process-lifetime, in-memory holder for unlocked secrets. After an
 * explicit unlock (via the local Unix-socket API or the dashboard GUI) the
 * decrypted values live here and nowhere on disk. A module-level singleton so the
 * server, the RPC client builder, and the pipeline all read the same unlocked
 * set; `lock()` clears it. Values are never logged.
 */

"use strict";

const held = new Map();

/**
 * Record an unlocked secret in memory.
 * @param {string} name
 * @param {string} value plaintext
 */
function unlock(name, value) {
  held.set(name, value);
}

/**
 * Record many unlocked secrets at once (e.g. the full vault after a passphrase
 * unlock).
 * @param {Record<string, string>} entries name -> plaintext
 */
function unlockAll(entries) {
  for (const [name, value] of Object.entries(entries)) held.set(name, value);
}

/** @param {string} name @returns {string|null} */
function get(name) {
  return held.get(name) ?? null;
}

/** @param {string} name @returns {boolean} */
function has(name) {
  return held.has(name);
}

/** Clear every unlocked secret from memory. */
function lock() {
  held.clear();
}

/** @returns {string[]} names of currently-unlocked secrets */
function names() {
  return [...held.keys()];
}

module.exports = { unlock, unlockAll, get, has, lock, names };
