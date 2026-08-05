/**
 * @file src/secrets/service.js
 * @description The unlock/store operations shared by every channel — the local
 * Unix-socket API, the dashboard GUI, and the CLI. `storeSecret` seals a value
 * into the on-disk vault; `unlockVault` decrypts the whole vault under a
 * passphrase and loads it into the in-memory holder, so the RPC pool
 * (`config.effectiveRpcUrls`) can use it. Neither ever logs the passphrase or the
 * plaintext.
 */

"use strict";

const store = require("./store");
const holder = require("./holder");

/**
 * Seal a named secret into the vault (encrypted at rest).
 * @param {string} name
 * @param {string} value plaintext (e.g. the Moralis RPC URL, key included)
 * @param {string} passphrase
 * @param {{ file?: string, iterations?: number }} [opts]
 */
function storeSecret(name, value, passphrase, opts) {
  store.assertPassphrase(passphrase, opts);
  store.setSecret(name, value, passphrase, opts);
}

/**
 * Seal multiple named secrets under one passphrase.
 * @param {Record<string, string>} entries name -> plaintext
 * @param {string} passphrase
 * @param {{ file?: string, iterations?: number }} [opts]
 * @returns {string[]} the stored names
 */
function storeSecrets(entries, passphrase, opts) {
  store.assertPassphrase(passphrase, opts);
  for (const [name, value] of Object.entries(entries)) {
    store.setSecret(name, value, passphrase, opts);
  }
  return Object.keys(entries);
}

/**
 * Decrypt every vault secret under the passphrase and load them into memory.
 * Throws if the passphrase is wrong (nothing is loaded). Returns the unlocked
 * secret names.
 * @param {string} passphrase
 * @param {{ file?: string }} [opts]
 * @returns {string[]}
 */
function unlockVault(passphrase, opts) {
  const entries = store.decryptAll(passphrase, opts); // throws on a wrong pass
  holder.unlockAll(entries);
  return Object.keys(entries);
}

module.exports = { storeSecret, storeSecrets, unlockVault };
