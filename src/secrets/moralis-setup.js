/**
 * @file src/secrets/moralis-setup.js
 * @description Guided CLI collection of the vault RPC secrets — up to three
 * generic (key-free) node URLs per chain, up to three full Moralis node URLs per
 * chain (the API key is embedded in each URL), plus the Moralis General API key.
 * Shared by `hexleague secret set-moralis` and the headless server startup.
 * Returns a { name -> value } map of the non-blank entries to seal; nothing is
 * logged.
 */

"use strict";

const { promptHidden, promptLine } = require("./prompt");

const CHAINS = [
  ["eth", "Ethereum"],
  ["pls", "PulseChain"],
];

/**
 * Prompt for up to 3 node URLs per chain under a slot prefix (e.g. "Generic" or
 * "Rpc"), storing each non-blank answer as `<chain><prefix><n>`.
 * @param {Record<string, string>} out accumulator, mutated in place
 * @param {string} prefix vault-name slot prefix
 * @param {string} kind human label for the prompt (e.g. "generic", "Moralis")
 */
async function promptUrls(out, prefix, kind) {
  for (const [key, label] of CHAINS) {
    for (let i = 1; i <= 3; i += 1) {
      const url = await promptLine(
        `${label} ${kind} RPC URL ${i} (full URL, blank to skip): `,
      );
      if (url) out[`${key}${prefix}${i}`] = url;
    }
  }
}

/**
 * Prompt for the generic + Moralis RPC URLs and the Moralis General API key.
 * @returns {Promise<Record<string, string>>} non-blank { name: value } entries
 */
async function collectRpcSecrets() {
  const out = {};
  await promptUrls(out, "Generic", "generic (no key)");
  await promptUrls(out, "Rpc", "Moralis");
  const gen = await promptHidden("Moralis General API Key (blank to skip): ");
  if (gen) out.moralisGeneralKey = gen;
  return out;
}

module.exports = { collectRpcSecrets };
