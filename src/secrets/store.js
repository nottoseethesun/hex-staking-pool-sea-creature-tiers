/**
 * @file src/secrets/store.js
 * @description On-disk secrets vault: a single JSON file (config/secrets.vault.json,
 * gitignored, mode 0600) holding named encrypted envelopes. Each secret is sealed
 * under the user's passphrase via `vault.js`; the file never contains plaintext.
 * The file path is injectable (`opts.file`) so tests never touch the real vault.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { encrypt, decrypt } = require("./vault");

/** Default (real) vault file. */
const VAULT_FILE = path.join(
  __dirname,
  "..",
  "..",
  "config",
  "secrets.vault.json",
);

/** @returns {string} the default vault path */
function vaultPath() {
  return VAULT_FILE;
}

/** @param {string} [file] @returns {boolean} */
function hasVault(file = VAULT_FILE) {
  return fs.existsSync(file);
}

/** @param {string} file @returns {Record<string, object>} */
function readVault(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

/** @param {string} file @param {Record<string, object>} obj */
function writeVault(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * Store a named secret, encrypted under the passphrase.
 * @param {string} name
 * @param {string} value plaintext (e.g. an RPC URL that embeds an API key)
 * @param {string} passphrase
 * @param {{ file?: string, iterations?: number }} [opts]
 */
function setSecret(name, value, passphrase, opts = {}) {
  const file = opts.file ?? VAULT_FILE;
  const vault = readVault(file);
  vault[name] = encrypt(value, passphrase, opts.iterations);
  writeVault(file, vault);
}

/**
 * Decrypt a named secret. Throws on a wrong passphrase, tampering, or a missing
 * name.
 * @param {string} name
 * @param {string} passphrase
 * @param {{ file?: string }} [opts]
 * @returns {string}
 */
function getSecret(name, passphrase, opts = {}) {
  const vault = readVault(opts.file ?? VAULT_FILE);
  if (!vault[name]) throw new Error(`No secret '${name}' in the vault`);
  return decrypt(vault[name], passphrase);
}

/**
 * Decrypt every secret in the vault under one passphrase (used at unlock time).
 * Throws if the passphrase is wrong for any entry.
 * @param {string} passphrase
 * @param {{ file?: string }} [opts]
 * @returns {Record<string, string>} name -> plaintext
 */
function decryptAll(passphrase, opts = {}) {
  const vault = readVault(opts.file ?? VAULT_FILE);
  const out = {};
  for (const [name, env] of Object.entries(vault)) {
    out[name] = decrypt(env, passphrase);
  }
  return out;
}

/**
 * When the vault already holds secrets, confirm `passphrase` can decrypt them —
 * so a new write is sealed under the SAME key and the whole vault stays
 * unlockable in one shot. Throws on a mismatch; a no-op for an empty/absent
 * vault (a first-time setup).
 * @param {string} passphrase
 * @param {{ file?: string }} [opts]
 */
function assertPassphrase(passphrase, opts = {}) {
  const first = Object.values(readVault(opts.file ?? VAULT_FILE))[0];
  if (!first) return;
  try {
    decrypt(first, passphrase);
  } catch {
    throw new Error("passphrase does not match the existing vault");
  }
}

/** @param {string} [file] @returns {string[]} */
function listSecrets(file = VAULT_FILE) {
  return Object.keys(readVault(file));
}

/**
 * Delete the on-disk vault (removes ALL sealed secrets), returning to a first-run
 * state. Returns true if a vault existed and was removed, false if there was
 * nothing to clear. Does NOT lock a running server's in-memory holder — restart
 * the dashboard to fully return to first-run.
 * @param {{ file?: string }} [opts]
 * @returns {boolean}
 */
function clearVault(opts = {}) {
  const file = opts.file ?? VAULT_FILE;
  if (!fs.existsSync(file)) return false;
  fs.rmSync(file);
  return true;
}

module.exports = {
  vaultPath,
  hasVault,
  setSecret,
  getSecret,
  decryptAll,
  assertPassphrase,
  listSecrets,
  clearVault,
};
