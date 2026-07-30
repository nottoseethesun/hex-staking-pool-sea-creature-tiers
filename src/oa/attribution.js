/**
 * @file src/oa/attribution.js
 * @description Pure per-asset OA-funding attribution. A wallet is classified as
 * part of the OA cluster when at least `threshold` of its inbound value — for
 * EITHER asset (HEX or native coin) — arrived from within the OA-reachable set.
 * No cross-asset price conversion (price feeds are forbidden); the fraction is
 * computed independently per asset with a divide-by-zero guard.
 */

"use strict";

/** Fixed-point scale used to turn a BigInt ratio into a JS fraction. */
const SCALE = 1000000n;

/**
 * Fraction (0..1) of `total` attributable to OA. Returns 0 when total <= 0.
 * @param {bigint} oaAmount OA-attributed inbound value
 * @param {bigint} totalAmount total inbound value
 * @returns {number}
 */
function fraction(oaAmount, totalAmount) {
  if (totalAmount <= 0n) return 0;
  const capped = oaAmount > totalAmount ? totalAmount : oaAmount;
  const scaled = (capped * SCALE) / totalAmount;
  return Number(scaled) / Number(SCALE);
}

/**
 * Whether a wallet meets the OA-funding threshold for either asset.
 * @param {{ oaHex: bigint, totalHex: bigint, oaNative: bigint, totalNative: bigint }} funding
 * @param {number} threshold e.g. 0.2 for 20%
 * @returns {{ isOa: boolean, fracHex: number, fracNative: number }}
 */
function classifyFunding(funding, threshold) {
  const fracHex = fraction(funding.oaHex, funding.totalHex);
  const fracNative = fraction(funding.oaNative, funding.totalNative);
  const isOa = fracHex >= threshold || fracNative >= threshold;
  return { isOa, fracHex, fracNative };
}

module.exports = { fraction, classifyFunding };
