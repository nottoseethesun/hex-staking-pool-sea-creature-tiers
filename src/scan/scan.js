/**
 * @file src/scan/scan.js
 * @description Stage 1 — the stake-ledger scan. One filtered eth_getLogs over
 * the three stake events, chunked from the deploy block to a pinned tip, decoded
 * to minimal rows and appended to data/<chain>/stakes.ndjson with a resume
 * checkpoint. Re-running performs an incremental top-up (only new blocks). The
 * active-shares map is rebuilt on demand by replaying the ledger — never cached
 * separately (minimal footprint).
 */

"use strict";

const { HEX_CONTRACT } = require("../chain/constants");
const { findDeployBlock } = require("../chain/deploy-block");
const { getLogsChunked } = require("../rpc/get-logs");
const { decodeStakeLog, STAKE_TOPICS } = require("../decode/stake-events");
const { appendNdjson, readNdjson } = require("../cache/store");
const { logChunkFor } = require("../config");
const cp = require("./checkpoint");

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
 * Persist a window of decoded rows and advance the checkpoint.
 * @param {object} args
 * @returns {number} updated running row count
 */
function persistWindow({
  chainKey,
  file,
  logs,
  range,
  tip,
  rows,
  chunkSize,
  log,
}) {
  const decoded = logs.map(decodeStakeLog).filter(Boolean);
  appendNdjson(file, decoded);
  const total = rows + decoded.length;
  cp.saveCheckpoint(chainKey, {
    lastScannedBlock: range.to,
    pinnedTip: tip,
    rows: total,
    chunkSize,
  });
  log.info("[scan %s] %d/%d blocks, %d rows", chainKey, range.to, tip, total);
  return total;
}

/**
 * Scan (or incrementally top up) a chain's stake ledger to a pinned tip.
 * @param {object} ctx { client, chainKey, config, log, force? }
 * @returns {Promise<object>} { chainKey, tip, deployBlock, rows, scanned }
 */
async function scanChain(ctx) {
  const { client, chainKey, config, log, force = false } = ctx;
  if (force) cp.resetChain(chainKey);
  const head = await client.getBlockNumber();
  const tip = head - config.tipLagBlocks;
  const deployBlock = await resolveDeployBlock(client, chainKey, tip, force);
  const checkpoint = cp.loadCheckpoint(chainKey);
  if (checkpoint && !cp.isCompatible(checkpoint)) {
    throw new Error(
      `Stale ${chainKey} cache schema — re-run scan with --rebuild.`,
    );
  }
  const startBlock = checkpoint ? checkpoint.lastScannedBlock + 1 : deployBlock;
  let rows = checkpoint ? checkpoint.rows : 0;
  if (startBlock > tip) {
    log.info("[scan %s] already up to date at block %d", chainKey, tip);
    return { chainKey, tip, deployBlock, rows, scanned: 0 };
  }
  const file = cp.stakesPath(chainKey);
  const chunkSize = logChunkFor(config, chainKey);
  await getLogsChunked(client, {
    address: HEX_CONTRACT,
    topics: [STAKE_TOPICS],
    fromBlock: startBlock,
    toBlock: tip,
    startChunk: chunkSize,
    onLogs: (logs, range) => {
      rows = persistWindow({
        chainKey,
        file,
        logs,
        range,
        tip,
        rows,
        chunkSize,
        log,
      });
      if (ctx.onProgress) {
        const span = tip - startBlock;
        const frac = span > 0 ? (range.to - startBlock) / span : 1;
        ctx.onProgress(Math.min(1, Math.max(0, frac)));
      }
    },
  });
  cp.saveCheckpoint(chainKey, {
    lastScannedBlock: tip,
    pinnedTip: tip,
    rows,
    chunkSize,
  });
  return { chainKey, tip, deployBlock, rows, scanned: tip - startBlock + 1 };
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

module.exports = { scanChain, buildActiveShares, resolveDeployBlock, applyRow };
