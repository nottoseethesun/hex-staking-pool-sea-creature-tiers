/**
 * @file src/resolve/resolution.js
 * @description Loads the cached resolution inputs (HSI ownership + wrapper token
 * balances) written by the `resolve` stage and applies the pure resolver to the
 * replayed active-shares map. When no resolution cache exists yet, resolution is
 * the identity (every stake is a Native HEX Stake), so callers behave exactly as
 * they did before the resolve stage was introduced.
 */

"use strict";

const path = require("path");
const { readJson, chainDir } = require("../cache/store");
const { buildActiveShares } = require("../scan/scan");
const { resolveHolders } = require("./holders");

/**
 * Path to a chain's resolution cache.
 * @param {string} chainKey
 * @returns {string}
 */
function resolutionPath(chainKey) {
  return path.join(chainDir(chainKey), "resolution.json");
}

/**
 * Convert a cached resolution JSON into runtime Maps/BigInts (identity on null).
 * @param {object|null} json
 * @returns {{ hsiOwners: Map<string, string>, wrappers: object[] }}
 */
function parseResolution(json) {
  if (!json) return { hsiOwners: new Map(), wrappers: [] };
  const hsiOwners = new Map(Object.entries(json.hsiOwners ?? {}));
  const wrappers = (json.wrappers ?? []).map((w) => ({
    address: w.address,
    label: w.label,
    supply: BigInt(w.supply),
    balances: new Map(
      Object.entries(w.balances ?? {}).map(([k, v]) => [k, BigInt(v)]),
    ),
  }));
  return { hsiOwners, wrappers };
}

/**
 * Load the resolution inputs for a chain (identity when the cache is absent).
 * @param {string} chainKey
 * @returns {{ hsiOwners: Map<string, string>, wrappers: object[] }}
 */
function loadResolution(chainKey) {
  return parseResolution(readJson(resolutionPath(chainKey), null));
}

/**
 * Replay the ledger and re-attribute it to resolved holders.
 * @param {string} chainKey
 * @returns {Promise<{ shares: Map<string, bigint>, subtotals: object,
 *   labels: Map<string, object> }>}
 */
async function buildResolvedShares(chainKey) {
  const raw = await buildActiveShares(chainKey);
  return resolveHolders(raw, loadResolution(chainKey));
}

module.exports = {
  resolutionPath,
  parseResolution,
  loadResolution,
  buildResolvedShares,
};
