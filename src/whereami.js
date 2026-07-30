/**
 * @file src/whereami.js
 * @description Self-lookup over the report summary. Given one or more addresses
 * (summed) or a raw T-Share figure, locate the staker in each view (eth, pls,
 * combined): T-Share total, tier, rank among non-OA stakers, percentile, and the
 * T-Share distance to the next tier up. Addresses in the OA cluster are called
 * out explicitly instead of ranked. Pure over the summary object.
 */

"use strict";

const { classify, thresholdShares, LADDER } = require("./report/leagues");
const { tshares } = require("./report/format");
const { SHARES_PER_TSHARE } = require("./chain/constants");

const VIEW_NAMES = ["eth", "pls", "combined"];

/**
 * Convert a T-Share figure (string/number, up to 12 decimals) to raw shares.
 * @param {string|number} value
 * @returns {bigint}
 */
function tsharesToRaw(value) {
  const [intPart, fracPart = ""] = String(value).split(".");
  const frac = `${fracPart}000000000000`.slice(0, 12);
  const whole = BigInt(intPart || "0") * SHARES_PER_TSHARE;
  return whole + BigInt(frac || "0");
}

/**
 * Count ranking entries with strictly greater shares (binary search, desc).
 * @param {[string, string][]} ranking
 * @param {bigint} rawShares
 * @returns {number}
 */
function countGreater(ranking, rawShares) {
  let lo = 0;
  let hi = ranking.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (BigInt(ranking[mid][1]) > rawShares) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * The tier immediately above `league`, or null if already the top tier.
 * @param {object} league
 * @returns {object | null}
 */
function nextTierUp(league) {
  const idx = LADDER.findIndex((t) => t.id === league.id);
  if (idx === -1) return LADDER[LADDER.length - 1];
  if (idx === 0) return null;
  return LADDER[idx - 1];
}

/**
 * Locate a raw-share total within one view.
 * @param {object} view
 * @param {bigint} rawShares
 * @returns {object}
 */
function locateInView(view, rawShares) {
  const poolNonOa = BigInt(view.poolNonOaShares);
  const league = classify(rawShares, poolNonOa);
  const rank = 1 + countGreater(view.ranking, rawShares);
  const n = view.nonOaStakerCount;
  const percentile = n > 0 ? ((n - rank) / n) * 100 : 0;
  const next = nextTierUp(league);
  const gap = next ? thresholdShares(next, poolNonOa) - rawShares : 0n;
  return {
    tshares: tshares(rawShares),
    league: { id: league.id, emoji: league.emoji, name: league.name },
    rank,
    nonOaStakerCount: n,
    percentile: Number(percentile.toFixed(4)),
    nextTier: next ? { id: next.id, name: next.name, emoji: next.emoji } : null,
    distanceToNextTier: next && gap > 0n ? tshares(gap) : "0.000",
  };
}

/**
 * Index a view for address lookup.
 * @param {object} view
 * @returns {{ sharesByAddr: Map<string, bigint>, oaSet: Set<string> }}
 */
function indexView(view) {
  const sharesByAddr = new Map();
  for (const [addr, s] of view.ranking) sharesByAddr.set(addr, BigInt(s));
  return { sharesByAddr, oaSet: new Set(view.oaAddresses) };
}

/**
 * Locate a set of addresses (summed, OA members called out) within one view.
 * @param {object} view
 * @param {string[]} addrs
 * @returns {object}
 */
function locateAddresses(view, addrs) {
  const idx = indexView(view);
  const oaHits = [];
  const found = [];
  const missing = [];
  let total = 0n;
  for (const raw of addrs) {
    const a = raw.toLowerCase();
    if (idx.oaSet.has(a)) oaHits.push(raw);
    else if (idx.sharesByAddr.has(a)) {
      total += idx.sharesByAddr.get(a);
      found.push(raw);
    } else missing.push(raw);
  }
  return {
    input: "address",
    oaHits,
    found,
    missing,
    ...locateInView(view, total),
  };
}

/**
 * Locate a query across all three views.
 * @param {object} summary the report summary object
 * @param {{ addresses?: string[], tshares?: string|number }} query
 * @returns {object}
 */
function locate(summary, query) {
  const results = {};
  for (const name of VIEW_NAMES) {
    const view = summary.views[name];
    if (query.tshares !== undefined && query.tshares !== null) {
      results[name] = {
        input: "tshares",
        ...locateInView(view, tsharesToRaw(query.tshares)),
      };
    } else {
      results[name] = locateAddresses(view, query.addresses || []);
    }
  }
  return { disclaimer: summary.disclaimer, results };
}

module.exports = {
  locate,
  locateInView,
  locateAddresses,
  tsharesToRaw,
  countGreater,
  nextTierUp,
};
