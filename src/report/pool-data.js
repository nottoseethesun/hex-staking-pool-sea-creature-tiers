/**
 * @file src/report/pool-data.js
 * @description Read-only presentation layer for the public sea-creature API. Two
 * pure transforms over an existing out/summary.json (never a scan):
 *
 *   buildPoolData(summary)          the whole staking-pool picture the app holds,
 *                                   organized: per-chain as-of block + UTC time,
 *                                   pinned-tip chain state, per-view pool totals +
 *                                   tier breakdown, and the sea-creature roster as
 *                                   a key-value map (tier id -> definition).
 *   whatIsMySeaCreature(summary, n) the above plus the caller's ranking for a
 *                                   non-zero positive T-Share count (up to 11
 *                                   decimal places).
 *
 * Both are pure over `summary`; neither reads the chain. All shares are exact
 * BigInt decimal strings, mirrored with an 8-decimal T-Share string (see
 * MAX_TSHARE_DECIMALS) so fine, expensive fractional amounts survive.
 */

"use strict";

const { tshares, formatPercent } = require("./format");
const { LADDER, PLANKTON } = require("./leagues");
const { locate } = require("../whereami");

const VIEW_NAMES = ["eth", "pls", "combined"];

/**
 * T-Share precision for this API: inputs are honored to this many decimal places
 * (finer is rejected, not silently truncated) and every T-Share figure in a
 * response is rendered to it. T-Shares can get very expensive, so fine
 * fractional amounts must survive in both directions.
 */
const MAX_TSHARE_DECIMALS = 8;

/**
 * The as-of pointer for one chain: the last block scanned and that block's UTC
 * timestamp. Nulls when a chain's pinned tip is absent (an incomplete summary).
 * @param {object} [tip] summary.chains[chain]
 * @returns {{ block: number|null, timeUtc: string|null }}
 */
function asOf(tip) {
  return {
    block: (tip && tip.block) ?? null,
    timeUtc: (tip && tip.timeUtc) ?? null,
  };
}

/**
 * Trim trailing zeros (and any trailing dot) from a decimal string.
 * @param {string} s
 * @returns {string}
 */
function trimZeros(s) {
  if (!s.includes(".")) return s;
  return s.replace(/0+$/, "").replace(/\.$/, "");
}

/**
 * Mirror a raw-shares decimal string as { shares, tShares } (T-Shares to
 * MAX_TSHARE_DECIMALS places).
 * @param {string} raw raw shares (10^12 = 1 T-Share)
 * @returns {{ shares: string, tShares: string }}
 */
function sharePair(raw) {
  return { shares: raw, tShares: tshares(BigInt(raw), MAX_TSHARE_DECIMALS) };
}

/**
 * One tier's realized numbers for a given view (this pool's actual counts and
 * thresholds), formatted for display alongside the raw figures.
 * @param {object} t summary tier row
 * @returns {object}
 */
function tierRow(t) {
  return {
    id: t.id,
    emoji: t.emoji,
    name: t.name,
    minShares: t.minShares,
    minTShares: tshares(BigInt(t.minShares), MAX_TSHARE_DECIMALS),
    wallets: t.wallets,
    cumulativeWallets: t.cumulativeWallets,
    tierShares: t.tierShares,
    tierTShares: tshares(BigInt(t.tierShares), MAX_TSHARE_DECIMALS),
  };
}

/**
 * The pool totals + tier breakdown for one view (eth, pls, or combined).
 * @param {object} view summary.views[name]
 * @returns {object}
 */
function buildViewData(view) {
  return {
    pool: {
      total: sharePair(view.poolTotalShares),
      nonOa: sharePair(view.poolNonOaShares),
      oaExcluded: sharePair(view.oaExcludedShares),
    },
    stakerCounts: { nonOa: view.nonOaStakerCount, oa: view.oaStakerCount },
    tiers: view.tiers.map(tierRow),
  };
}

/**
 * The sea-creature roster as a key-value map (tier id -> intrinsic definition):
 * emoji, name, rank (1 = top), and the minimum share of the non-OA pool as both
 * an exact fraction and a percent. Plankton (below Silent Shell) has rank null.
 * @returns {Record<string, object>}
 */
function buildRoster() {
  const roster = {};
  LADDER.forEach((t, i) => {
    roster[t.id] = {
      emoji: t.emoji,
      name: t.name,
      rank: i + 1,
      minShareFraction: `${t.num}/${t.den}`,
      minSharePercent: trimZeros(formatPercent(t.num, t.den, 7)),
    };
  });
  roster[PLANKTON.id] = {
    emoji: PLANKTON.emoji,
    name: PLANKTON.name,
    rank: null,
    minShareFraction: "0",
    minSharePercent: "0",
    note: "Below Silent Shell — any non-OA wallet under the Shell threshold.",
  };
  return roster;
}

/**
 * The complete, organized staking-pool picture the app holds — pure over an
 * existing summary, no chain access. Includes the as-of block + UTC time per
 * chain, the pinned-tip chain state, the per-view pool totals + tier breakdown,
 * and the sea-creature roster.
 * @param {object} summary out/summary.json contents
 * @returns {object}
 */
function buildPoolData(summary) {
  const views = {};
  for (const name of VIEW_NAMES)
    views[name] = buildViewData(summary.views[name]);
  return {
    asOf: { eth: asOf(summary.chains.eth), pls: asOf(summary.chains.pls) },
    chains: { eth: summary.chains.eth, pls: summary.chains.pls },
    views,
    roster: buildRoster(),
  };
}

/**
 * Parse and validate a T-Share count: a non-zero positive number with at most
 * MAX_TSHARE_DECIMALS decimal places, returned as its normalized decimal string.
 * Throws on zero, a negative, non-numeric input, or more than 8 decimal places
 * so the caller answers 400.
 * @param {unknown} value raw query value
 * @returns {string}
 */
function parsePositiveTshares(value) {
  const s = String(value ?? "").trim();
  const dot = s.indexOf(".");
  const intPart = dot === -1 ? s : s.slice(0, dot);
  const frac = dot === -1 ? "" : s.slice(dot + 1);
  const wellFormed =
    /^\d+$/.test(intPart) && (dot === -1 || /^\d+$/.test(frac));
  if (!wellFormed) {
    throw new Error(
      `tshares must be a positive number, up to ${MAX_TSHARE_DECIMALS} decimal places (got: ${JSON.stringify(value)}).`,
    );
  }
  if (frac.length > MAX_TSHARE_DECIMALS) {
    throw new Error(
      `tshares supports at most ${MAX_TSHARE_DECIMALS} decimal places (got ${frac.length}).`,
    );
  }
  if (BigInt(intPart) === 0n && (frac === "" || BigInt(frac) === 0n)) {
    throw new Error("tshares must be non-zero and positive.");
  }
  return s;
}

/**
 * Answer "what is my hex staking sea creature": the caller's ranking for a
 * non-zero positive T-Share count (up to 8 decimal places) across all three
 * views, plus the whole staking-pool sub-object (buildPoolData). Pure over
 * `summary`; never scans.
 * @param {object} summary out/summary.json contents
 * @param {unknown} tsharesInput the caller's total pool T-Shares (positive number)
 * @returns {object}
 */
function whatIsMySeaCreature(summary, tsharesInput) {
  const tsharesStr = parsePositiveTshares(tsharesInput);
  const located = locate(summary, { tshares: tsharesStr }, MAX_TSHARE_DECIMALS);
  return {
    disclaimer: summary.disclaimer,
    query: { tshares: tsharesStr },
    ranking: located.results,
    stakingPool: buildPoolData(summary),
  };
}

module.exports = {
  buildPoolData,
  whatIsMySeaCreature,
  parsePositiveTshares,
  MAX_TSHARE_DECIMALS,
  buildRoster,
  buildViewData,
};
