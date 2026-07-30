/**
 * @file src/report/display.js
 * @description Pre-formats a view's figures into display strings embedded in
 * summary.json, so the browser dashboard renders ready-made text and never
 * re-implements any BigInt / T-Share formatting (no mirroring across the
 * CommonJS server / ESM browser boundary). whereami results are likewise
 * formatted server-side.
 */

"use strict";

const { tsharesGrouped, formatPercent, groupThousands } = require("./format");
const { classify } = require("./leagues");
const { checksum } = require("../chain/address");
const { tierPctLabel, hexForShares } = require("./markdown");

/** Number of top stakers to pre-render for the dashboard. */
const TOP_N = 50;

/**
 * Format the tier rows for display.
 * @param {object[]} tiers
 * @param {string} poolNonOaStr
 * @param {string|null} shareRate
 * @returns {object[]}
 */
function displayTiers(tiers, poolNonOaStr, shareRate) {
  const poolNonOa = BigInt(poolNonOaStr);
  return tiers.map((t) => ({
    league: `${t.emoji} ${t.name}`,
    pct: tierPctLabel(t),
    minTShares: tsharesGrouped(BigInt(t.minShares)),
    hexForNewStake: hexForShares(BigInt(t.minShares), shareRate),
    wallets: groupThousands(String(t.wallets)),
    cumulativeWallets: groupThousands(String(t.cumulativeWallets)),
    tierTShares: tsharesGrouped(BigInt(t.tierShares)),
    tierPct: `${formatPercent(BigInt(t.tierShares), poolNonOa, 4)}%`,
  }));
}

/**
 * Format the top-N non-OA stakers for display.
 * @param {object} view
 * @param {Record<string, boolean>} contractFlags
 * @returns {object[]}
 */
function displayTop(view, contractFlags) {
  const poolNonOa = BigInt(view.poolNonOaShares);
  return view.ranking.slice(0, TOP_N).map(([addr, s], i) => {
    const shares = BigInt(s);
    const league = classify(shares, poolNonOa);
    const flag = contractFlags[addr];
    return {
      rank: i + 1,
      addr: checksum(addr),
      tshares: tsharesGrouped(shares),
      league: `${league.emoji} ${league.name}`,
      contract: flag === undefined ? "?" : flag ? "yes" : "no",
    };
  });
}

/**
 * Build the display block for a view.
 * @param {object} view
 * @param {string|null} shareRate
 * @param {Record<string, boolean>} contractFlags
 * @returns {object}
 */
function buildDisplay(view, shareRate, contractFlags) {
  return {
    poolTotalTShares: tsharesGrouped(BigInt(view.poolTotalShares)),
    poolNonOaTShares: tsharesGrouped(BigInt(view.poolNonOaShares)),
    oaExcludedTShares: tsharesGrouped(BigInt(view.oaExcludedShares)),
    oaStakerCount: groupThousands(String(view.oaStakerCount)),
    nonOaStakerCount: groupThousands(String(view.nonOaStakerCount)),
    tiers: displayTiers(view.tiers, view.poolNonOaShares, shareRate),
    top: displayTop(view, contractFlags),
  };
}

module.exports = { buildDisplay, displayTiers, displayTop };
