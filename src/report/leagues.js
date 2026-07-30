/**
 * @file src/report/leagues.js
 * @description The sea-creature league ladder — the single source of truth for
 * tier thresholds and display. The tier list (emoji + names, in order) is loaded
 * from config/leagues.json; each tier's minimum share of the non-OA pool is the
 * exact rational 1 / 10^rank (Poseidon = 1/10 … Shell = 1/10^9). A wallet is
 * counted once, in the highest tier it qualifies for, via exact BigInt
 * cross-multiplication (no floats). Below Shell is Plankton.
 *
 * Reconciliation note: the source sheet floored "Shell" one order higher and had
 * no Plankton row; the spec's thresholds win for the math, the sheet's
 * names/emoji win for display.
 */

"use strict";

const cfg = require("../../config/leagues.json");

/**
 * The ladder: each tier gets num/den = 1 / 10^rank from its position in
 * config/leagues.json (index 0 = Poseidon = 1/10 = 10%).
 */
const LADDER = cfg.ladder.map((t, i) => ({
  id: t.id,
  emoji: t.emoji,
  name: t.name,
  num: 1n,
  den: 10n ** BigInt(i + 1),
}));

/** Below-Shell catch-all tier. */
const PLANKTON = { ...cfg.plankton, num: 0n, den: 1n };

/**
 * The >= 100% degenerate label (from the source sheet). `classify` never returns
 * it — no single non-OA wallet can exceed the pool that includes it — but it is
 * defined for the dashboard legend and documentation.
 */
const WIDE_OCEAN = { ...cfg.wideOcean, num: 1n, den: 1n };

/** Tiers rendered in the Sea Creature Table, top -> bottom (incl. Plankton). */
const TABLE_TIERS = [...LADDER, PLANKTON];

/**
 * Minimum raw shares to reach a tier for a given non-OA pool size (floor).
 * @param {{ num: bigint, den: bigint }} league
 * @param {bigint} poolRaw
 * @returns {bigint}
 */
function thresholdShares(league, poolRaw) {
  return (poolRaw * league.num) / league.den;
}

/**
 * Does `sharesRaw` meet or exceed a tier threshold? Exact, no division:
 * sharesRaw/pool >= num/den  <=>  sharesRaw*den >= pool*num.
 * @param {bigint} sharesRaw
 * @param {{ num: bigint, den: bigint }} league
 * @param {bigint} poolRaw
 * @returns {boolean}
 */
function qualifies(sharesRaw, league, poolRaw) {
  return sharesRaw * league.den >= poolRaw * league.num;
}

/**
 * The highest tier `sharesRaw` qualifies for within the non-OA pool. Returns
 * PLANKTON below Shell or for a non-positive pool.
 * @param {bigint} sharesRaw
 * @param {bigint} poolRaw
 * @returns {object}
 */
function classify(sharesRaw, poolRaw) {
  if (poolRaw <= 0n) return PLANKTON;
  for (const league of LADDER) {
    if (qualifies(sharesRaw, league, poolRaw)) return league;
  }
  return PLANKTON;
}

module.exports = {
  LADDER,
  PLANKTON,
  WIDE_OCEAN,
  TABLE_TIERS,
  thresholdShares,
  qualifies,
  classify,
};
