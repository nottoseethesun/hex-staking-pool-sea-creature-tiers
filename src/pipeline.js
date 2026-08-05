/**
 * @file src/pipeline.js
 * @description The full "update" pipeline — scan -> oa -> report for both
 * chains — shared by the CLI `update` command and the dashboard Update button,
 * plus the pure freshness computation that decides whether an update is offered.
 * Progress is weighted by each stage's estimated remaining block-work (read from
 * the live tip + cache up front) — with the OA stages scaled up for their much
 * higher per-block cost, so the bar approximates time, not raw block count. A
 * fully-cached stage occupies ~0% of the bar, and the ETA reflects the slow OA
 * work ahead before it starts, not just once it's underway.
 */

"use strict";

const { makeClient } = require("./rpc/make-client");
const { scanChain } = require("./scan/scan");
const { buildResolution } = require("./resolve/resolve");
const { buildResolvedShares, resolutionPath } = require("./resolve/resolution");
const { buildOa, oaPath } = require("./oa/oa");
const { generateReport } = require("./report/report");
const { writeUpdateStatus, clearUpdateStatus } = require("./update-status");
const { CHAINS: CHAIN_CFG } = require("./chain/constants");
const { readJson } = require("./cache/store");
const cp = require("./scan/checkpoint");

const CHAINS = ["eth", "pls"];
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** UTC day index (whole days since epoch, aligned to 00:00:00 UTC). */
function utcDay(ms) {
  return Math.floor(ms / DAY_MS);
}
/** Report's fixed cost as a block-equivalent, so it's a small progress tail. */
const REPORT_WORK = 150000;

/**
 * How much more wall-clock an OA (`trace_filter`) block costs than a scan/resolve
 * (`eth_getLogs`) block. The OA stages' block-work is scaled by this so the
 * progress bar approximates time and the ETA accounts for the slow OA work before
 * it starts — the one thing the recent-rate ETA can't do on its own, since it
 * can only measure the stage it's already in. A single rough constant is
 * deliberate (good to about +/-30%, not exact); once OA is running the recent-rate
 * ETA measures its true speed directly, so this only shapes the pre-OA estimate.
 */
const OA_TIME_COST = 20;

/**
 * Normalize raw per-stage block-work into weights that sum to 1. When nothing is
 * left to do everywhere, all weight falls on the (always-run) report stage.
 * @param {{scanEth:number, resolveEth:number, oaEth:number, scanPls:number,
 *   resolvePls:number, oaPls:number, report:number}} work
 * @returns {object} same keys, normalized to sum 1
 */
function stageWeights(work) {
  const total =
    work.scanEth +
    work.resolveEth +
    work.oaEth +
    work.scanPls +
    work.resolvePls +
    work.oaPls +
    work.report;
  const t = total > 0 ? total : 1;
  return {
    scanEth: work.scanEth / t,
    resolveEth: work.resolveEth / t,
    oaEth: work.oaEth / t,
    scanPls: work.scanPls / t,
    resolvePls: work.resolvePls / t,
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
 * @returns {Promise<{scan:number, resolve:number, oa:number}>}
 */
async function estimateChainWork(client, chainKey, config, force) {
  // Honor the sticky tip: mid-cycle the scan targets the pinned tip, not a fresh
  // head, so a resumed run estimates ~0 work for the already-cached stages.
  const sticky = cp.stickyTip(chainKey, force);
  const tip =
    sticky !== null
      ? sticky
      : (await client.getBlockNumber()) - config.tipLagBlocks;
  const checkpoint = force ? null : cp.loadCheckpoint(chainKey);
  const deploy =
    cp.loadDeployBlock(chainKey) ?? CHAIN_CFG[chainKey].approxDeployBlock;
  const scanStart = checkpoint ? checkpoint.lastScannedBlock : deploy;
  const scan = Math.max(0, tip - scanStart);
  const resCache = force ? null : readJson(resolutionPath(chainKey), null);
  const resCached = Boolean(resCache && resCache.tip === tip && scan === 0);
  const resolve = resCached ? 0 : Math.max(1, tip - deploy);
  const oaCache = force ? null : readJson(oaPath(chainKey), null);
  const oaCached = Boolean(oaCache && oaCache.tip === tip && scan === 0);
  const oa = oaCached ? 0 : Math.max(1, tip - deploy);
  return { scan, resolve, oa };
}

/**
 * Weight the seven pipeline stages by estimated remaining time: raw block-work,
 * with the OA stages scaled by OA_TIME_COST for their higher per-block cost.
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
    resolveEth: eth.resolve,
    oaEth: eth.oa * OA_TIME_COST,
    scanPls: pls.scan,
    resolvePls: pls.resolve,
    oaPls: pls.oa * OA_TIME_COST,
    report: REPORT_WORK,
  });
}

/**
 * Run the full pipeline for both chains and write the report. Reports progress
 * (0..1) via `onProgress(fraction, phase)` and to the shared status file, so the
 * dashboard's Syncing badge + ETA track the run whether it was launched from the
 * button or the CLI.
 * @param {object} ctx { config, log, force?, onProgress?, signal? }
 * @returns {Promise<object>} the generateReport result
 */
async function runUpdate(ctx) {
  const { config, log, force = false, onProgress = () => {}, signal } = ctx;
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
      const wResolve = chainKey === "eth" ? w.resolveEth : w.resolvePls;
      const wOa = chainKey === "eth" ? w.oaEth : w.oaPls;
      emit(wScan, 0, `Scanning ${chainKey}`);
      await scanChain({
        client,
        chainKey,
        config,
        log,
        force,
        signal,
        onProgress: (f) => emit(wScan, f, `Scanning ${chainKey}`),
      });
      acc += wScan;
      emit(wResolve, 0, `Resolving ${chainKey}`);
      await buildResolution({
        client,
        chainKey,
        config,
        log,
        force,
        signal,
        onProgress: (f) => emit(wResolve, f, `Resolving ${chainKey}`),
      });
      acc += wResolve;
      emit(wOa, 0, `OA cluster ${chainKey}`);
      const { shares: activeStakers } = await buildResolvedShares(chainKey);
      await buildOa({
        client,
        chainKey,
        config,
        log,
        activeStakers,
        force,
        signal,
        onProgress: (f) => emit(wOa, f, `OA cluster ${chainKey}`),
      });
      acc += wOa;
    }
    signal?.throwIfAborted();
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
 * @returns {object} { hasCompleteScan, ageHours, staleDays, updateEnabled,
 *   reason } — stale once the UTC day is past the cache's UTC day
 */
function updateStatus(summary, nowMs) {
  if (!summary || !summary.chains) {
    // No cache yet — offer the initial sync from the dashboard (progress + ETA
    // make a browser-triggered first scan usable; it also works from the CLI).
    return {
      hasCompleteScan: false,
      ageHours: null,
      staleDays: null,
      updateEnabled: true,
      reason: "",
    };
  }
  const times = [summary.chains.eth, summary.chains.pls].map((c) =>
    Date.parse(c.timeUtc),
  );
  const cacheMs = Math.min(...times);
  const ageHours = Math.max(0, (nowMs - cacheMs) / HOUR_MS);
  // The HEX pool rolls over at 00:00:00 UTC, so the cache is stale once the
  // current UTC day is past the cache's UTC day — regardless of hours elapsed.
  const staleDays = Math.max(0, utcDay(nowMs) - utcDay(cacheMs));
  const updateEnabled = staleDays > 0;
  return {
    hasCompleteScan: true,
    ageHours: Math.round(ageHours),
    staleDays,
    updateEnabled,
    reason: updateEnabled
      ? ""
      : "Cache is current for today (UTC); the HEX pool updates at 00:00 UTC.",
  };
}

module.exports = {
  runUpdate,
  updateStatus,
  stageWeights,
  CHAINS,
};
