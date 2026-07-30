/**
 * @file src/report/summary.js
 * @description Stage 4 aggregation. Builds the machine-readable summary that
 * powers report.md, the CSVs, the dashboard, and whereami. For each view (eth,
 * pls, combined = per-address sum) it computes the pool total, the OA-excluded
 * shares/count, the non-OA denominator, the Sea-Creature tier buckets
 * (per-tier + cumulative counts, tier aggregates, min-share thresholds), and the
 * full non-OA ranking (address + raw shares, descending). All shares are exact
 * BigInt, serialized as decimal strings.
 */

"use strict";

const { classify, thresholdShares, TABLE_TIERS } = require("./leagues");
const { DISCLAIMER } = require("../disclaimer");

/**
 * Descending comparator over [addr, shares] entries.
 * @param {[string, bigint]} a
 * @param {[string, bigint]} b
 * @returns {number}
 */
function byShareDesc(a, b) {
  if (a[1] < b[1]) return 1;
  if (a[1] > b[1]) return -1;
  return 0;
}

/**
 * Bucket non-OA stakers into the Sea-Creature tiers.
 * @param {[string, bigint][]} nonOa descending [addr, shares]
 * @param {bigint} poolNonOa
 * @returns {object[]} tier rows in table order
 */
function bucketTiers(nonOa, poolNonOa) {
  const counts = new Map();
  const sums = new Map();
  for (const t of TABLE_TIERS) {
    counts.set(t.id, 0);
    sums.set(t.id, 0n);
  }
  for (const [, shares] of nonOa) {
    const league = classify(shares, poolNonOa);
    counts.set(league.id, counts.get(league.id) + 1);
    sums.set(league.id, sums.get(league.id) + shares);
  }
  let cumulative = 0;
  return TABLE_TIERS.map((t) => {
    cumulative += counts.get(t.id);
    return {
      id: t.id,
      emoji: t.emoji,
      name: t.name,
      num: t.num.toString(),
      den: t.den.toString(),
      minShares: thresholdShares(t, poolNonOa).toString(),
      wallets: counts.get(t.id),
      cumulativeWallets: cumulative,
      tierShares: sums.get(t.id).toString(),
    };
  });
}

/**
 * Build one view from a shares map and the OA member set.
 * @param {Map<string, bigint>} sharesMap address -> total active raw shares
 * @param {Set<string>} oaSet lowercased OA member + OA addresses
 * @returns {object}
 */
function buildView(sharesMap, oaSet) {
  let poolTotal = 0n;
  let oaExcluded = 0n;
  let oaStakerCount = 0;
  const nonOa = [];
  for (const [addr, shares] of sharesMap) {
    poolTotal += shares;
    if (oaSet.has(addr)) {
      oaExcluded += shares;
      oaStakerCount += 1;
    } else {
      nonOa.push([addr, shares]);
    }
  }
  const poolNonOa = poolTotal - oaExcluded;
  nonOa.sort(byShareDesc);
  return {
    poolTotalShares: poolTotal.toString(),
    poolNonOaShares: poolNonOa.toString(),
    oaExcludedShares: oaExcluded.toString(),
    oaStakerCount,
    nonOaStakerCount: nonOa.length,
    tiers: bucketTiers(nonOa, poolNonOa),
    ranking: nonOa.map(([a, s]) => [a, s.toString()]),
    oaAddresses: [...oaSet],
  };
}

/**
 * Merge two shares maps by address (for the combined view).
 * @param {Map<string, bigint>} a
 * @param {Map<string, bigint>} b
 * @returns {Map<string, bigint>}
 */
function combineShares(a, b) {
  const out = new Map(a);
  for (const [addr, shares] of b) {
    out.set(addr, (out.get(addr) ?? 0n) + shares);
  }
  return out;
}

/**
 * Build the full summary object across all three views.
 * @param {object} chains { eth: { shares, oa, tip }, pls: { shares, oa, tip } }
 * @returns {object}
 */
function buildSummary(chains) {
  const { eth, pls } = chains;
  const combinedShares = combineShares(eth.shares, pls.shares);
  const combinedOa = new Set([...eth.oa, ...pls.oa]);
  return {
    disclaimer: DISCLAIMER,
    chains: { eth: eth.tip, pls: pls.tip },
    views: {
      eth: buildView(eth.shares, eth.oa),
      pls: buildView(pls.shares, pls.oa),
      combined: buildView(combinedShares, combinedOa),
    },
  };
}

module.exports = { buildSummary, buildView, bucketTiers, combineShares };
