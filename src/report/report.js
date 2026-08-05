/**
 * @file src/report/report.js
 * @description Stage 4 orchestration (`report`). Loads the cached ledgers, OA
 * clusters, and pinned-tip reads for both chains, reconciles each chain
 * (spec §8.1) against the raw ledger, re-attributes stakes to resolved holders
 * (Native / HSI owner / $MAXI look-through), builds the summary, flags the top
 * non-OA stakers as contract/EOA, and writes out/summary.json, out/report.md, the
 * three leagues_*.csv, and out/oa_wallets.csv. Runs offline from cache when the
 * tip reads are already cached and contract-flag enrichment is skipped.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { buildActiveShares } = require("../scan/scan");
const { resolveHolders } = require("../resolve/holders");
const { loadResolution } = require("../resolve/resolution");
const { readTip } = require("../chain/reads");
const { reconcile } = require("../validate/reconcile");
const { memberAddressSet, oaPath } = require("../oa/oa");
const { buildSummary } = require("./summary");
const { buildDisplay } = require("./display");
const { renderMarkdown } = require("./markdown");
const { leaguesCsv, oaWalletsCsv } = require("./csv");
const { tsharesGrouped } = require("./format");
const cp = require("../scan/checkpoint");
const { readJson, writeJson, ensureDir, OUT_DIR } = require("../cache/store");
const tuning = require("../../config/tuning.json");

/** Top non-OA stakers per view to resolve contract vs EOA. */
const TOP_CONTRACTS = tuning.topContracts;

/**
 * Load a chain's cached ledger + OA + tip, reconcile the raw ledger against
 * globalInfo, then re-attribute it to resolved holders.
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
  const rawShares = await buildActiveShares(chainKey);
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
  const rec = reconcile(rawShares, tip);
  if (!rec.ok) {
    log.warn(
      "[report %s] RECONCILIATION MISMATCH sum=%s expected=%s diff=%s",
      chainKey,
      rec.sum,
      rec.expected,
      rec.diff,
    );
  }
  const { shares, subtotals, labels } = resolveHolders(
    rawShares,
    loadResolution(chainKey),
  );
  return {
    shares,
    subtotals,
    labels,
    oa,
    oaJson: oaJson || { members: [] },
    tip,
    rec,
  };
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
      leaguesCsv(summary.views[view], contractFlags, summary.labels),
    );
  }
  fs.writeFileSync(path.join(OUT_DIR, "oa_wallets.csv"), oaWalletsCsv(oaJsons));
}

/**
 * Sum the per-label wrapped subtotals.
 * @param {Record<string, bigint>} wrapped
 * @returns {bigint}
 */
function sumWrapped(wrapped) {
  let total = 0n;
  for (const v of Object.values(wrapped)) total += v;
  return total;
}

/**
 * Format one raw-share figure as { raw, tshares } for summary.json.
 * @param {bigint} raw
 * @returns {{ raw: string, tshares: string }}
 */
function kindEntry(raw) {
  return { raw: raw.toString(), tshares: tsharesGrouped(raw) };
}

/**
 * Build a chain's stake-kind subtotal block (native / hsi / wrapped / total).
 * @param {{ native: bigint, hsi: bigint, wrapped: Record<string, bigint> }} sub
 * @returns {object}
 */
function stakeKindsBlock(sub) {
  const wrappedTotal = sumWrapped(sub.wrapped);
  const byLabel = {};
  for (const [label, v] of Object.entries(sub.wrapped)) {
    byLabel[label] = kindEntry(v);
  }
  return {
    native: kindEntry(sub.native),
    hsi: kindEntry(sub.hsi),
    wrapped: { total: kindEntry(wrappedTotal), byLabel },
    total: kindEntry(sub.native + sub.hsi + wrappedTotal),
  };
}

/**
 * Log a chain's stake-kind subtotals (final values, per logging convention).
 * @param {object} log
 * @param {string} chainKey
 * @param {object} sub subtotals from resolveHolders
 */
function logStakeKinds(log, chainKey, sub) {
  const b = stakeKindsBlock(sub);
  log.info(
    "[report %s] stake T-Shares native=%s hsi=%s wrapped=%s sum=%s",
    chainKey,
    b.native.tshares,
    b.hsi.tshares,
    b.wrapped.total.tshares,
    b.total.tshares,
  );
}

/**
 * Merge label side-maps into a plain object keyed by lowercased address.
 * @param {...Map<string, object>} maps
 * @returns {Record<string, object>}
 */
function mergeLabels(...maps) {
  const out = {};
  for (const m of maps) {
    for (const [addr, meta] of m) out[addr] = meta;
  }
  return out;
}

/**
 * Mark each chain's sync cycle complete — a written report is the completion
 * event, so the next sync pins a fresh tip instead of holding the reported
 * (sticky) one. A no-op for a chain that has no cycle marker yet.
 * @param {string[]} [chains] chain keys to complete (defaults to both)
 */
function completeCycles(chains = ["eth", "pls"]) {
  for (const chainKey of chains) {
    const cycle = cp.loadCycle(chainKey);
    if (cycle) cp.saveCycle(chainKey, { tip: cycle.tip, complete: true });
  }
}

/**
 * Per-chain scan facts for the dashboard "Scan Details" dialog: the pinned tip
 * (block + UTC time), the deploy-block span, the OA sweep size, and the last
 * measured inbound-sweep duration (the dominant re-scan cost). Missing OA data
 * degrades to nulls rather than inventing numbers.
 * @param {string} chainKey
 * @param {object} chain loadChain result ({ tip, oaJson })
 * @returns {object}
 */
function scanStats(chainKey, chain) {
  const oa = chain.oaJson || {};
  const tipBlock = chain.tip.block;
  const deployBlock = oa.deployBlock ?? cp.loadDeployBlock(chainKey);
  const hasDeploy = typeof deployBlock === "number";
  return {
    tipBlock,
    timeUtc: chain.tip.timeUtc,
    currentDay: chain.tip.currentDay ?? null,
    deployBlock: hasDeploy ? deployBlock : null,
    blockSpan: hasDeploy ? tipBlock - deployBlock : null,
    candidateStakerCount: oa.candidateStakerCount ?? null,
    memberCount: oa.memberCount ?? (oa.members ? oa.members.length : null),
    reachableCount: oa.reachableCount ?? null,
    oaSweep: oa.sweep ?? null,
  };
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
  summary.stakeKinds = {
    eth: stakeKindsBlock(eth.subtotals),
    pls: stakeKindsBlock(pls.subtotals),
  };
  summary.scan = { eth: scanStats("eth", eth), pls: scanStats("pls", pls) };
  summary.labels = mergeLabels(eth.labels, pls.labels);
  logStakeKinds(log, "eth", eth.subtotals);
  logStakeKinds(log, "pls", pls.subtotals);
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
  completeCycles();
  log.info(
    "[report] wrote out/ — eth reconciled=%s, pls reconciled=%s",
    eth.rec.ok,
    pls.rec.ok,
  );
  return { summary, reconciliation: summary.reconciliation };
}

module.exports = {
  generateReport,
  loadChain,
  enrichContracts,
  writeOutputs,
  stakeKindsBlock,
  completeCycles,
  scanStats,
};
