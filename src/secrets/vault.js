/**
 * @file src/secrets/vault.js
 * @description Password-based encryption core for the local secrets vault. A
 * secret (e.g. a paid RPC URL that embeds an API key) is encrypted at rest with
 * a key derived from the user's passphrase via PBKDF2-HMAC-SHA512, then sealed
 * with AES-256-GCM (authenticated). Nothing here touches disk or retains
 * plaintext beyond the call: the store persists only the envelope, and the
 * holder keeps a decrypted value in memory only after an explicit unlock. The
 * passphrase and plaintext never leave the process and are never logged.
 */

"use strict";

const crypto = require("crypto");

/** PBKDF2 iterations for the default (production) work factor. */
const PBKDF2_ITERATIONS = 600000;
const KEY_LEN = 32; // AES-256
const SALT_LEN = 16;
const IV_LEN = 12; // AES-GCM standard nonce length
const DIGEST = "sha512";

/**
 * Derive a 32-byte AES key from a passphrase + salt (PBKDF2-HMAC-SHA512).
 * @param {string} passphrase
 * @param {Buffer} salt
 * @param {number} iterations
 * @returns {Buffer}
 */
function deriveKey(passphrase, salt, iterations) {
  return crypto.pbkdf2Sync(passphrase, salt, iterations, KEY_LEN, DIGEST);
}

/**
 * Encrypt a UTF-8 plaintext under a passphrase, returning a JSON-safe envelope.
 * `iterations` is injectable so tests can use a low work factor.
 * @param {string} plaintext
 * @param {string} passphrase
 * @param {number} [iterations]
 * @returns {{ v:number, kdf:string, iter:number, salt:string, iv:string, tag:string, ct:string }}
 */
function encrypt(plaintext, passphrase, iterations = PBKDF2_ITERATIONS) {
  const salt = crypto.randomBytes(SALT_LEN);
  const iv = crypto.randomBytes(IV_LEN);
  const key = deriveKey(passphrase, salt, iterations);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: 1,
    kdf: "pbkdf2-sha512",
    iter: iterations,
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ct: ct.toString("base64"),
  };
}

/**
 * Decrypt an envelope produced by encrypt(). Throws on a wrong passphrase or any
 * tampering (the GCM authentication tag fails to verify).
 * @param {object} env encrypt() envelope
 * @param {string} passphrase
 * @returns {string} the UTF-8 plaintext
 */
function decrypt(env, passphrase) {
  const salt = Buffer.from(env.salt, "base64");
  const iv = Buffer.from(env.iv, "base64");
  const tag = Buffer.from(env.tag, "base64");
  const ct = Buffer.from(env.ct, "base64");
  const key = deriveKey(passphrase, salt, env.iter);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString("utf8");
}

module.exports = { encrypt, decrypt, deriveKey, PBKDF2_ITERATIONS };
