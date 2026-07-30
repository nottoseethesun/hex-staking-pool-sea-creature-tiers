/**
 * @file src/validate/reconcile.js
 * @description Global reconciliation (spec §8.1): the sum of all active shares
 * from the event scan must equal stakeSharesTotal + nextStakeSharesTotal from
 * globalInfo at the pinned tip, exactly (both are the same ledger). Any mismatch
 * indicates a decoding or state-machine bug and must abort the report.
 */

"use strict";

/**
 * Sum all active raw shares.
 * @param {Map<string, bigint>} activeShares
 * @returns {bigint}
 */
function sumShares(activeShares) {
  let total = 0n;
  for (const v of activeShares.values()) total += v;
  return total;
}

/**
 * Reconcile the event-derived share sum against globalInfo totals.
 * @param {Map<string, bigint>} activeShares
 * @param {{ stakeSharesTotal: string, nextStakeSharesTotal: string }} tip
 * @returns {{ ok: boolean, sum: string, expected: string, diff: string }}
 */
function reconcile(activeShares, tip) {
  const sum = sumShares(activeShares);
  const expected =
    BigInt(tip.stakeSharesTotal) + BigInt(tip.nextStakeSharesTotal);
  const diff = sum - expected;
  return {
    ok: diff === 0n,
    sum: sum.toString(),
    expected: expected.toString(),
    diff: diff.toString(),
  };
}

module.exports = { reconcile, sumShares };
