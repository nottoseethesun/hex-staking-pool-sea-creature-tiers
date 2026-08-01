/**
 * @file src/report/csv.js
 * @description CSV emitters. leagues_<view>.csv is the full non-OA ranking
 * (rank, address, tshares, pct_of_nonoa_pool, percentile, league, is_contract,
 * oa_flag, label); oa_wallets.csv is the evidence-backed OA cluster. OA-cluster
 * stakers
 * are excluded from the ranking (they live in oa_wallets.csv) so ranks and
 * percentiles reflect the non-OA pool only.
 */

"use strict";

const { classify } = require("./leagues");
const { tshares, formatPercent } = require("./format");
const { checksum } = require("../chain/address");

/**
 * Escape a CSV field.
 * @param {any} v
 * @returns {string}
 */
function esc(v) {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Render the non-OA league ranking CSV for a view.
 * @param {object} view summary view
 * @param {Record<string, boolean>} contractFlags addr -> is-contract
 * @param {Record<string, object>} [labels] addr -> { label, kind }
 * @returns {string}
 */
function leaguesCsv(view, contractFlags, labels = {}) {
  const header =
    "rank,address,tshares,pct_of_nonoa_pool,percentile,league," +
    "is_contract,oa_flag,label";
  const rows = [header];
  const poolNonOa = BigInt(view.poolNonOaShares);
  const n = view.nonOaStakerCount;
  view.ranking.forEach(([addr, s], i) => {
    const shares = BigInt(s);
    const rank = i + 1;
    const league = classify(shares, poolNonOa);
    const pct = formatPercent(shares, poolNonOa, 8);
    const percentile = n > 0 ? ((n - rank) / n) * 100 : 0;
    const flag = contractFlags[addr];
    const label = labels[addr] ? labels[addr].label : "";
    rows.push(
      [
        rank,
        checksum(addr),
        tshares(shares),
        pct,
        percentile.toFixed(6),
        league.name,
        flag === undefined ? "" : flag,
        "none",
        label,
      ]
        .map(esc)
        .join(","),
    );
  });
  return `${rows.join("\n")}\n`;
}

/**
 * Render the OA-cluster CSV from per-chain oa.json contents.
 * @param {Record<string, object>} oaJsons { eth, pls }
 * @returns {string}
 */
function oaWalletsCsv(oaJsons) {
  const rows = [
    "chain,address,hop_depth,funded_via,frac_hex,frac_native,evidence_tx",
  ];
  for (const [chain, oaJson] of Object.entries(oaJsons)) {
    for (const m of oaJson.members || []) {
      const ev = m.evidence[0] ? m.evidence[0].txHash : "";
      rows.push(
        [chain, m.addr, m.depth, m.via || "", m.fracHex, m.fracNative, ev]
          .map(esc)
          .join(","),
      );
    }
  }
  return `${rows.join("\n")}\n`;
}

module.exports = { leaguesCsv, oaWalletsCsv, esc };
