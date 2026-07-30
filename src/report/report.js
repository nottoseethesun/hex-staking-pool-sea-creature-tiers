/**
 * @file src/report/report.js
 * @description Stage 4 orchestration (`report`). Loads the cached ledgers, OA
 * clusters, and pinned-tip reads for both chains, reconciles each chain
 * (spec §8.1), builds the summary, flags the top non-OA stakers as
 * contract/EOA, and writes out/summary.json, out/report.md, the three
 * leagues_*.csv, and out/oa_wallets.csv. Runs offline from cache when the tip
 * reads are already cached and contract-flag enrichment is skipped.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { buildActiveShares } = require("../scan/scan");
const { readTip } = require("../chain/reads");
const { reconcile } = require("../validate/reconcile");
const { memberAddressSet, oaPath } = require("../oa/oa");
const { buildSummary } = require("./summary");
const { buildDisplay } = require("./display");
const { renderMarkdown } = require("./markdown");
const { leaguesCsv, oaWalletsCsv } = require("./csv");
const cp = require("../scan/checkpoint");
const { readJson, writeJson, ensureDir, OUT_DIR } = require("../cache/store");
const tuning = require("../../config/tuning.json");

/** Top non-OA stakers per view to resolve contract vs EOA. */
const TOP_CONTRACTS = tuning.topContracts;

/**
 * Load a chain's cached ledger + OA + tip, reconciling against globalInfo.
 * @param {string} chainKey
 * @param {object|null} client
 * @param {object} log
 * @returns {Promise<object>}
 */
async function loadChain(chainKey, client, log) {
  const checkpoint = cp.loadCheckpoint(chainKey);
  if (!checkpoint) {
    throw new Error(
      `Run 'hexleague scan --chain ${chainKey}' before 'report'.`,
    );
  }
  const tipBlock = checkpoint.pinnedTip;
  const shares = await buildActiveShares(chainKey);
  const oaJson = readJson(oaPath(chainKey), null);
  const oa = memberAddressSet(oaJson);
  let tip = cp.loadTip(chainKey);
  if (!tip || tip.block !== tipBlock) {
    if (!client) {
      throw new Error(`No cached tip for ${chainKey}; re-run with RPC access.`);
    }
    tip = await readTip(client, tipBlock);
    cp.saveTip(chainKey, tip);
  }
  const rec = reconcile(shares, tip);
  if (!rec.ok) {
    log.warn(
      "[report %s] RECONCILIATION MISMATCH sum=%s expected=%s diff=%s",
      chainKey,
      rec.sum,
      rec.expected,
      rec.diff,
    );
  }
  return { shares, oa, oaJson: oaJson || { members: [] }, tip, rec };
}

/**
 * Resolve contract/EOA flags for the top-N non-OA stakers of a view.
 * @param {object|null} client
 * @param {object} view
 * @returns {Promise<Record<string, boolean>>}
 */
async function enrichContracts(client, view) {
  const flags = {};
  if (!client) return flags;
  for (const [addr] of view.ranking.slice(0, TOP_CONTRACTS)) {
    const code = await client.getCode(addr);
    flags[addr] = Boolean(code) && code !== "0x";
  }
  return flags;
}

/**
 * Write every out/ artifact.
 * @param {object} summary
 * @param {Record<string, boolean>} contractFlags
 * @param {object} oaJsons
 */
function writeOutputs(summary, contractFlags, oaJsons) {
  ensureDir(OUT_DIR);
  writeJson(path.join(OUT_DIR, "summary.json"), summary);
  fs.writeFileSync(
    path.join(OUT_DIR, "report.md"),
    renderMarkdown(summary, contractFlags),
  );
  for (const view of ["eth", "pls", "combined"]) {
    fs.writeFileSync(
      path.join(OUT_DIR, `leagues_${view}.csv`),
      leaguesCsv(summary.views[view], contractFlags),
    );
  }
  fs.writeFileSync(path.join(OUT_DIR, "oa_wallets.csv"), oaWalletsCsv(oaJsons));
}

/**
 * Generate the full report from cache (+ optional live tip / contract flags).
 * @param {object} ctx { clients: { eth, pls }, log }
 * @returns {Promise<object>} { summary, reconciliation }
 */
async function generateReport(ctx) {
  const { clients = {}, log } = ctx;
  const eth = await loadChain("eth", clients.eth || null, log);
  const pls = await loadChain("pls", clients.pls || null, log);
  const summary = buildSummary({
    eth: { shares: eth.shares, oa: eth.oa, tip: eth.tip },
    pls: { shares: pls.shares, oa: pls.oa, tip: pls.tip },
  });
  const contractFlags = {
    ...(await enrichContracts(clients.eth || null, summary.views.eth)),
    ...(await enrichContracts(clients.pls || null, summary.views.pls)),
    ...(await enrichContracts(clients.eth || null, summary.views.combined)),
  };
  summary.contractFlags = contractFlags;
  summary.reconciliation = { eth: eth.rec, pls: pls.rec };
  const shareRates = {
    eth: eth.tip.shareRate,
    pls: pls.tip.shareRate,
    combined: null,
  };
  for (const name of ["eth", "pls", "combined"]) {
    summary.views[name].display = buildDisplay(
      summary.views[name],
      shareRates[name],
      contractFlags,
    );
  }
  writeOutputs(summary, contractFlags, { eth: eth.oaJson, pls: pls.oaJson });
  log.info(
    "[report] wrote out/ — eth reconciled=%s, pls reconciled=%s",
    eth.rec.ok,
    pls.rec.ok,
  );
  return { summary, reconciliation: summary.reconciliation };
}

module.exports = { generateReport, loadChain, enrichContracts, writeOutputs };
