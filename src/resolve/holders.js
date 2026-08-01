/**
 * @file src/resolve/holders.js
 * @description Pure re-attribution of the raw active-shares map to resolved
 * holders. Native HEX Stakes pass through; HSI stakes are re-keyed to their
 * HSIM-resolved owner; a wrapper's own T-Shares — whether staked natively by the
 * wrapper or held through HSIs it owns — are pooled and looked through to its
 * token holders pro-rata ($MAXI), with rounding dust kept under the wrapper
 * address so the grand total is conserved exactly. Returns per-provenance T-Share
 * subtotals (native / hsi / wrapped) for logging and sanity checks, plus a label
 * side-map for known wrapper entities. All address keys are lowercased.
 */

"use strict";

const { distribute } = require("./wrapped");

/**
 * Accumulate `v` raw shares onto `addr` in `map` (BigInt-safe).
 * @param {Map<string, bigint>} map
 * @param {string} addr lowercased address
 * @param {bigint} v
 */
function addShares(map, addr, v) {
  map.set(addr, (map.get(addr) ?? 0n) + v);
}

/**
 * Classify one raw stake into resolved-holder shares, or into a wrapper's owned
 * pool (whether the wrapper staked natively or holds the stake via an HSI).
 * @param {object} ctx { shares, wrapperOwned, wrapperAddrs, hsiOwners, subtotals }
 * @param {string} staker lowercased staker address
 * @param {bigint} v raw shares
 */
function classifyStake(ctx, staker, v) {
  const { shares, wrapperOwned, wrapperAddrs, hsiOwners, subtotals } = ctx;
  if (wrapperAddrs.has(staker)) {
    addShares(wrapperOwned, staker, v); // wrapper's own native stake
    return;
  }
  const owner = hsiOwners.get(staker);
  if (owner && wrapperAddrs.has(owner)) {
    addShares(wrapperOwned, owner, v); // HSI held by a wrapper (e.g. MAXI)
  } else if (owner) {
    addShares(shares, owner, v);
    subtotals.hsi += v;
  } else {
    addShares(shares, staker, v);
    subtotals.native += v;
  }
}

/**
 * Re-attribute the raw active-shares map to resolved holders.
 * @param {Map<string, bigint>} rawShares staker (lowercased) -> raw active shares
 * @param {object} resolution
 * @param {Map<string, string>} resolution.hsiOwners hsiAddr -> owner (lowercased)
 * @param {object[]} resolution.wrappers look-through wrappers; each is
 *   { address, label, balances: Map<addr,bigint>, supply: bigint }
 * @returns {{ shares: Map<string, bigint>, subtotals: object,
 *   labels: Map<string, object> }}
 */
function resolveHolders(rawShares, resolution) {
  const { hsiOwners, wrappers } = resolution;
  const wrapperAddrs = new Set(wrappers.map((w) => w.address));
  const shares = new Map();
  const wrapperOwned = new Map();
  const labels = new Map();
  const subtotals = { native: 0n, hsi: 0n, wrapped: {} };
  const ctx = { shares, wrapperOwned, wrapperAddrs, hsiOwners, subtotals };

  for (const [staker, v] of rawShares) classifyStake(ctx, staker, v);

  for (const w of wrappers) {
    const total = wrapperOwned.get(w.address) ?? 0n;
    subtotals.wrapped[w.label] = total;
    labels.set(w.address, { label: w.label, kind: "wrapped" });
    if (total <= 0n) continue;
    const { perHolder, dust } = distribute(total, w.balances, w.supply);
    for (const [holder, s] of perHolder) addShares(shares, holder, s);
    if (dust > 0n) addShares(shares, w.address, dust);
  }

  return { shares, subtotals, labels };
}

module.exports = { resolveHolders };
