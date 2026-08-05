/**
 * @file src/scan/scan.js
 * @description Stage 1 — the stake-ledger scan. One filtered eth_getLogs over
 * the three stake events, chunked from the deploy block to a pinned tip, decoded
 * to minimal rows and appended to data/<chain>/stakes.ndjson with a resume
 * checkpoint. Re-running performs an incremental top-up (only new blocks). The
 * pinned tip follows the sticky-tip rule (see checkpoint.js): while a sync cycle
 * is in progress it stays fixed across restarts, so the later stages' resumable
 * checkpoints keep matching; a fresh tip is pinned only when a new cycle starts.
 * The active-shares map is rebuilt on demand by replaying the ledger — never
 * cached separately (minimal footprint).
 */

"use strict";

const { HEX_CONTRACT } = require("../chain/constants");
const { findDeployBlock } = require("../chain/deploy-block");
const { getLogsChunked } = require("../rpc/get-logs");
const { decodeStakeLog, STAKE_TOPICS } = require("../decode/stake-events");
const {
  appendNdjson,
  readNdjson,
  truncatePartialLine,
} = require("../cache/store");
const { logChunkFor } = require("../config");
const { makeProgressLogger } = require("../log");
const cp = require("./checkpoint");
const { createFlushGate } = require("../cache/flush-gate");
const tuning = require("../../config/tuning.json");

/**
 * Resolve (and cache) the HEX deploy block for a chain.
 * @param {object} client
 * @param {string} chainKey
 * @param {number} tip
 * @param {boolean} force
 * @returns {Promise<number>}
 */
async function resolveDeployBlock(client, chainKey, tip, force) {
  if (!force) {
    const cached = cp.loadDeployBlock(chainKey);
    if (cached !== null) return cached;
  }
  const block = await findDeployBlock(client, HEX_CONTRACT, tip);
  cp.saveDeployBlock(chainKey, block);
  return block;
}

/**
 * A batched ledger writer: it buffers decoded rows in memory and flushes them
 * (append the rows, then advance the checkpoint) only when the flush gate says
 * so — cutting per-chunk cache writes down to roughly one every few minutes.
 * Rows are appended BEFORE the cursor advances, so a crash never leaves the
 * checkpoint pointing past unwritten rows; and the ledger replay is idempotent
 * to a re-scanned batch, so any duplicate rows after a crash are harmless.
 * `append` / `save` are injectable for tests.
 * @param {object} args { chainKey, file, tip, chunkSize, startBlock, rows,
 *   everyItems?, everyMs?, append?, save? }
 * @returns {{ add: (decoded: object[], rangeTo: number) => void,
 *   flush: () => void, rows: () => number }}
 */
function createLedgerWriter(args) {
  const {
    chainKey,
    file,
    tip,
    chunkSize,
    startBlock,
    append = appendNdjson,
    save = cp.saveCheckpoint,
  } = args;
  const gate = createFlushGate({
    everyItems: args.everyItems,
    everyMs: args.everyMs,
  });
  const buffer = [];
  let rows = args.rows;
  let pendingTo = startBlock - 1;
  let flushedTo = startBlock - 1;
  const flush = () => {
    if (buffer.length > 0) {
      append(file, buffer); // data first
      buffer.length = 0;
    }
    if (pendingTo > flushedTo) {
      save(chainKey, {
        lastScannedBlock: pendingTo, // then the cursor
        pinnedTip: tip,
        rows,
        chunkSize,
      });
      flushedTo = pendingTo;
    }
    gate.reset();
  };
  return {
    add(decoded, rangeTo) {
      for (const d of decoded) buffer.push(d);
      rows += decoded.length;
      pendingTo = rangeTo;
      gate.add(1);
      if (gate.due()) flush();
    },
    flush,
    rows: () => rows,
  };
}

/**
 * Decide the tip this scan targets, applying the sticky-tip rule. While a sync
 * cycle is in progress its pinned tip is held fixed across restarts, so the
 * resumable resolve/OA checkpoints stay valid and resume instead of restarting
 * against a freshly-advanced head; otherwise a fresh tip is pinned from the live
 * head (minus the reorg-safety lag) and a new cycle is opened.
 * @param {object} client
 * @param {string} chainKey
 * @param {object} config
 * @param {boolean} force
 * @returns {Promise<number>}
 */
async function resolveScanTip(client, chainKey, config, force) {
  const sticky = cp.stickyTip(chainKey, force);
  if (sticky !== null) return sticky;
  const head = await client.getBlockNumber();
  const tip = head - config.tipLagBlocks;
  cp.saveCycle(chainKey, { tip, complete: false });
  return tip;
}

/**
 * Scan (or incrementally top up) a chain's stake ledger to a pinned tip.
 * @param {object} ctx { client, chainKey, config, log, force?, signal? }
 * @returns {Promise<object>} { chainKey, tip, deployBlock, rows, scanned }
 */
async function scanChain(ctx) {
  const { client, chainKey, config, log, force = false } = ctx;
  if (force) cp.resetChain(chainKey);
  const tip = await resolveScanTip(client, chainKey, config, force);
  const deployBlock = await resolveDeployBlock(client, chainKey, tip, force);
  const checkpoint = cp.loadCheckpoint(chainKey);
  if (checkpoint && !cp.isCompatible(checkpoint)) {
    throw new Error(
      `Stale ${chainKey} cache schema — re-run scan with --rebuild.`,
    );
  }
  const startBlock = checkpoint ? checkpoint.lastScannedBlock + 1 : deployBlock;
  const rows = checkpoint ? checkpoint.rows : 0;
  if (startBlock > tip) {
    log.info("[scan %s] already up to date at block %d", chainKey, tip);
    return { chainKey, tip, deployBlock, rows, scanned: 0 };
  }
  const file = cp.stakesPath(chainKey);
  // Heal any partial trailing line a hard shutdown may have left mid-append, so
  // this session's appends never fuse onto a truncated row.
  truncatePartialLine(file);
  const chunkSize = logChunkFor(config, chainKey);
  const writer = createLedgerWriter({
    chainKey,
    file,
    tip,
    chunkSize,
    startBlock,
    rows,
    everyItems: tuning.flushEveryChunks,
    everyMs: tuning.flushEveryMs,
  });
  const progress = makeProgressLogger(`[scan ${chainKey}]`, "block scan", {
    log,
  });
  try {
    await getLogsChunked(client, {
      address: HEX_CONTRACT,
      topics: [STAKE_TOPICS],
      fromBlock: startBlock,
      toBlock: tip,
      startChunk: chunkSize,
      signal: ctx.signal,
      onLogs: (logs, range) => {
        writer.add(logs.map(decodeStakeLog).filter(Boolean), range.to);
        const span = tip - startBlock;
        const frac = span > 0 ? (range.to - startBlock) / span : 1;
        progress(frac, `block ${range.to}/${tip}, ${writer.rows()} rows`);
        if (ctx.onProgress) ctx.onProgress(Math.min(1, Math.max(0, frac)));
      },
    });
  } finally {
    // Persist the final (or in-flight) batch on normal completion OR a clean
    // abort, so `npm stop` / Stop Sync never loses buffered rows.
    writer.flush();
  }
  return {
    chainKey,
    tip,
    deployBlock,
    rows: writer.rows(),
    scanned: tip - startBlock + 1,
  };
}

/**
 * Apply one ledger row to the active-stake map (keyed by staker:stakeId).
 * @param {Map<string, bigint>} active
 * @param {object} row
 */
function applyRow(active, row) {
  const key = `${row.s}:${row.i}`;
  if (row.e === 0) active.set(key, BigInt(row.h));
  else active.delete(key);
}

/**
 * Rebuild the active-shares map for a chain by replaying its ledger.
 * @param {string} chainKey
 * @param {string} [file] ledger path (defaults to the chain's stakes.ndjson)
 * @returns {Promise<Map<string, bigint>>} address -> total active raw shares
 */
async function buildActiveShares(chainKey, file = cp.stakesPath(chainKey)) {
  const active = new Map();
  await readNdjson(file, (row) => applyRow(active, row));
  const totals = new Map();
  for (const [key, shares] of active) {
    const s = key.slice(0, key.indexOf(":"));
    totals.set(s, (totals.get(s) ?? 0n) + shares);
  }
  for (const [s, v] of totals) {
    if (v === 0n) totals.delete(s);
  }
  return totals;
}

module.exports = {
  scanChain,
  buildActiveShares,
  resolveDeployBlock,
  resolveScanTip,
  applyRow,
  createLedgerWriter,
};
