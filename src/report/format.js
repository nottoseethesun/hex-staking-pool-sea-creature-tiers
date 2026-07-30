/**
 * @file src/report/format.js
 * @description Pure BigInt -> display-string helpers. Every figure is derived
 * from raw contract shares (1 T-Share = 10^12 raw shares) using integer math
 * only — never floats — so displayed values are deterministic. T-Shares are
 * shown to 3 decimals by default (spec §1).
 */

"use strict";

const { SHARES_PER_TSHARE } = require("../chain/constants");

/**
 * Format raw shares as a T-Share decimal string (round half-up), no grouping.
 * @param {bigint} rawShares
 * @param {number} [decimals]
 * @returns {string}
 */
function tshares(rawShares, decimals = 3) {
  const scale = 10n ** BigInt(decimals);
  const half = SHARES_PER_TSHARE / 2n;
  const scaled = (rawShares * scale + half) / SHARES_PER_TSHARE;
  const whole = scaled / scale;
  if (decimals === 0) return whole.toString();
  const frac = (scaled % scale).toString().padStart(decimals, "0");
  return `${whole}.${frac}`;
}

/**
 * Insert thousands separators into a non-negative integer digit string.
 * @param {string} intStr
 * @returns {string}
 */
function groupThousands(intStr) {
  let out = "";
  for (let i = 0; i < intStr.length; i += 1) {
    if (i > 0 && (intStr.length - i) % 3 === 0) out += ",";
    out += intStr[i];
  }
  return out;
}

/**
 * T-Shares with thousands separators on the integer part (MD / dashboard).
 * @param {bigint} rawShares
 * @param {number} [decimals]
 * @returns {string}
 */
function tsharesGrouped(rawShares, decimals = 3) {
  const s = tshares(rawShares, decimals);
  const dot = s.indexOf(".");
  if (dot === -1) return groupThousands(s);
  return groupThousands(s.slice(0, dot)) + s.slice(dot);
}

/**
 * Format num/den as a percent string (num/den * 100), round half-up.
 * @param {bigint} numRaw
 * @param {bigint} denRaw
 * @param {number} [decimals]
 * @returns {string}
 */
function formatPercent(numRaw, denRaw, decimals = 6) {
  if (denRaw === 0n) {
    return decimals === 0 ? "0" : `0.${"0".repeat(decimals)}`;
  }
  const scale = 10n ** BigInt(decimals);
  const scaled = (numRaw * 100n * scale + denRaw / 2n) / denRaw;
  const whole = scaled / scale;
  if (decimals === 0) return whole.toString();
  const frac = (scaled % scale).toString().padStart(decimals, "0");
  return `${whole}.${frac}`;
}

module.exports = { tshares, tsharesGrouped, groupThousands, formatPercent };
