/**
 * @file src/pipeline.js
 * @description The full "update" pipeline — scan -> oa -> report for both
 * chains — shared by the CLI `update` command and the dashboard Update button,
 * plus the pure freshness computation that decides whether an update is offered.
 * Progress is weighted by each stage's estimated remaining block-work (read from
 * the live tip + cache up front), so a fully-cached stage occupies ~0% of the
 * bar and the ETA stays accurate on incremental resumes, not just fresh runs.
 */

"use strict";

const { makeClient } = require("./rpc/make-client");
const { scanChain, buildActiveShares } = require("./scan/scan");
const { buildOa, oaPath } = require("./oa/oa");
const { generateReport } = require("./report/report");
const { writeUpdateStatus, clearUpdateStatus } = require("./update-status");
const { CHAINS: CHAIN_CFG } = require("./chain/constants");
const { readJson } = require("./cache/store");
const cp = require("./scan/checkpoint");

const CHAINS = ["eth", "pls"];
const HOUR_MS = 60 * 60 * 1000;
const FRESH_HOURS = 24;
/** Report's fixed cost as a block-equivalent, so it's a small progress tail. */
const REPORT_WORK = 150000;

/**
 * Normalize raw per-stage block-work into weights that sum to 1. When nothing is
 * left to do everywhere, all weight falls on the (always-run) report stage.
 * @param {{scanEth:number, oaEth:number, scanPls:number, oaPls:number,
 *   report:number}} work
 * @returns {object} same keys, normalized to sum 1
 */
function stageWeights(work) {
  const total =
    work.scanEth + work.oaEth + work.scanPls + work.oaPls + work.report;
  const t = total > 0 ? total : 1;
  return {
    scanEth: work.scanEth / t,
    oaEth: work.oaEth / t,
    scanPls: work.scanPls / t,
    oaPls: work.oaPls / t,
    report: work.report / t,
  };
}

/**
 * Estimate a chain's remaining scan + OA block-work from the live tip and cache.
 * A cached scan contributes 0; the OA scan re-runs (full deploy->tip range)
 * whenever the tip has moved, else contributes 0.
 * @param {object} client
 * @param {string} chainKey
 * @param {object} config
 * @param {boolean} force
 * @returns {Promise<{scan:number, oa:number}>}
 */
async function estimateChainWork(client, chainKey, config, force) {
  const head = await client.getBlockNumber();
  const tip = head - config.tipLagBlocks;
  const checkpoint = force ? null : cp.loadCheckpoint(chainKey);
  const deploy =
    cp.loadDeployBlock(chainKey) ?? CHAIN_CFG[chainKey].approxDeployBlock;
  const scanStart = checkpoint ? checkpoint.lastScannedBlock : deploy;
  const scan = Math.max(0, tip - scanStart);
  const oaCache = force ? null : readJson(oaPath(chainKey), null);
  const oaCached = Boolean(oaCache && oaCache.tip === tip && scan === 0);
  const oa = oaCached ? 0 : Math.max(1, tip - deploy);
  return { scan, oa };
}

/**
 * Weight the five pipeline stages by estimated remaining block-work.
 * @param {object} config
 * @param {{eth:object, pls:object}} clients
 * @param {boolean} force
 * @returns {Promise<object>} normalized stage weights
 */
async function planStages(config, clients, force) {
  const eth = await estimateChainWork(clients.eth, "eth", config, force);
  const pls = await estimateChainWork(clients.pls, "pls", config, force);
  return stageWeights({
    scanEth: eth.scan,
    oaEth: eth.oa,
    scanPls: pls.scan,
    oaPls: pls.oa,
    report: REPORT_WORK,
  });
}

/**
 * Run the full pipeline for both chains and write the report. Reports progress
 * (0..1) via `onProgress(fraction, phase)` and to the shared status file, so the
 * dashboard's Syncing badge + ETA track the run whether it was launched from the
 * button or the CLI.
 * @param {object} ctx { config, log, force?, onProgress? }
 * @returns {Promise<object>} the generateReport result
 */
async function runUpdate(ctx) {
  const { config, log, force = false, onProgress = () => {} } = ctx;
  const clients = {
    eth: makeClient(config, "eth"),
    pls: makeClient(config, "pls"),
  };
  const w = await planStages(config, clients, force);
  let acc = 0;
  const emit = (weight, frac, phase) => {
    const p = Math.min(1, acc + weight * Math.min(1, Math.max(0, frac)));
    writeUpdateStatus(p, phase);
    onProgress(p, phase);
  };
  try {
    for (const chainKey of CHAINS) {
      const client = clients[chainKey];
      const wScan = chainKey === "eth" ? w.scanEth : w.scanPls;
      const wOa = chainKey === "eth" ? w.oaEth : w.oaPls;
      emit(wScan, 0, `Scanning ${chainKey}`);
      await scanChain({
        client,
        chainKey,
        config,
        log,
        force,
        onProgress: (f) => emit(wScan, f, `Scanning ${chainKey}`),
      });
      acc += wScan;
      emit(wOa, 0, `OA cluster ${chainKey}`);
      const activeStakers = await buildActiveShares(chainKey);
      await buildOa({
        client,
        chainKey,
        config,
        log,
        activeStakers,
        force,
        onProgress: (f) => emit(wOa, f, `OA cluster ${chainKey}`),
      });
      acc += wOa;
    }
    emit(w.report, 0, "Building report");
    const result = await generateReport({ clients, log });
    emit(w.report, 1, "Done");
    return result;
  } finally {
    clearUpdateStatus();
  }
}

/**
 * Compute dashboard update availability + staleness from a summary + now.
 * @param {object|null} summary out/summary.json contents
 * @param {number} nowMs Date.now()
 * @returns {object} { hasCompleteScan, ageHours, updateEnabled, reason }
 */
function updateStatus(summary, nowMs) {
  if (!summary || !summary.chains) {
    return {
      hasCompleteScan: false,
      ageHours: null,
      updateEnabled: false,
      reason:
        "No complete scan yet — run the initial scan from the terminal " +
        "(hexleague update).",
    };
  }
  const times = [summary.chains.eth, summary.chains.pls].map((c) =>
    Date.parse(c.timeUtc),
  );
  const ageHours = Math.max(0, (nowMs - Math.min(...times)) / HOUR_MS);
  const updateEnabled = ageHours > FRESH_HOURS;
  return {
    hasCompleteScan: true,
    ageHours: Math.round(ageHours),
    updateEnabled,
    reason: updateEnabled
      ? ""
      : `Data is up to date (last scan ${Math.round(ageHours)}h ago; ` +
        "updates enable after 24h).",
  };
}

module.exports = {
  runUpdate,
  updateStatus,
  stageWeights,
  FRESH_HOURS,
  CHAINS,
};
