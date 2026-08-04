/**
 * @file src/resolve/resolve.js
 * @description Stage 2 (scan -> RESOLVE -> oa -> report). Builds a chain's
 * resolution cache from the HEX Stake Instance Manager (HSIM) ownership log and
 * the look-through wrapper tokens ($MAXI), scanned to the stakes checkpoint's
 * pinned tip. The cache (data/<chain>/resolution.json) holds the HEX Stake
 * Instance (HSI) -> owner map for currently-active HSIs plus each wrapper's holder
 * balances + supply, and is reused while the tip is unchanged (cf. oa.json).
 * Resolve is resumable: the HSIM replay and each wrapper scan checkpoint their
 * progress in batches to data/<chain>/resolution.progress.json (cleared once
 * resolution.json is written). buildResolvedShares (resolution.js) consumes it.
 */

"use strict";

const { HSIM_BY_CHAIN, WRAPPERS_BY_CHAIN } = require("../chain/constants");
const { findDeployBlock } = require("../chain/deploy-block");
const { buildActiveShares } = require("../scan/scan");
const { buildHsiOwnership } = require("./ownership");
const { scanWrapperBalances } = require("./wrapped");
const { resolutionPath } = require("./resolution");
const { logChunkFor } = require("../config");
const fs = require("fs");
const path = require("path");
const { readJson, writeJson, chainDir } = require("../cache/store");
const cp = require("../scan/checkpoint");

/** Bump when the resolution schema/semantics change. */
const RESOLUTION_SCHEMA = 1;

/** @param {string} chainKey @returns {string} */
function progressPath(chainKey) {
  return path.join(chainDir(chainKey), "resolution.progress.json");
}

/**
 * Per-sub-scan checkpoint IO over resolution.progress.json, keyed by `id` and
 * validated against `tip` — a moved tip invalidates the whole progress file, so
 * the sub-scans restart cleanly for the new tip.
 * @param {string} chainKey
 * @param {number} tip
 * @param {string} id
 * @param {boolean} force
 * @returns {{ load: () => object|null, save: (c: object) => void }}
 */
function subScanIO(chainKey, tip, id, force) {
  return {
    load() {
      if (force) return null;
      const p = readJson(progressPath(chainKey), null);
      const e = p && p.tip === tip && p.scans ? p.scans[id] : null;
      return e ? { cursor: e.cursor, snapshot: e.snapshot } : null;
    },
    save({ cursor, snapshot }) {
      const p = readJson(progressPath(chainKey), null);
      const base = p && p.tip === tip ? p : { tip, scans: {} };
      if (!base.scans) base.scans = {};
      base.scans[id] = { cursor, snapshot };
      writeJson(progressPath(chainKey), base);
    },
  };
}

/**
 * Remove the resolve progress file — called once resolution.json is written, so
 * the intermediate sub-scan snapshots don't linger.
 * @param {string} chainKey
 */
function clearProgress(chainKey) {
  fs.rmSync(progressPath(chainKey), { force: true });
}

/**
 * Keep only HSIs that are currently active stakers (present in the ledger).
 * @param {Map<string, string>} owners hsiAddr -> owner
 * @param {Map<string, bigint>} rawShares staker -> raw active shares
 * @returns {Record<string, string>}
 */
function activeHsiOwners(owners, rawShares) {
  const out = {};
  for (const [hsi, owner] of owners) {
    if (rawShares.has(hsi)) out[hsi] = owner;
  }
  return out;
}

/**
 * Scan one wrapper token's balances into a serializable cache entry.
 * @param {object} client
 * @param {{ token: string, label: string }} w
 * @param {object} ctx { toBlock, startChunk, signal }
 * @returns {Promise<object>} { address, label, supply, balances }
 */
async function scanWrapper(client, w, ctx) {
  const fromBlock = await findDeployBlock(client, w.token, ctx.toBlock);
  const { balances, supply } = await scanWrapperBalances(client, {
    token: w.token,
    fromBlock,
    toBlock: ctx.toBlock,
    startChunk: ctx.startChunk,
    signal: ctx.signal,
    load: ctx.load,
    save: ctx.save,
  });
  const obj = {};
  for (const [addr, bal] of balances) obj[addr] = bal.toString();
  return {
    address: w.token.toLowerCase(),
    label: w.label,
    supply: supply.toString(),
    balances: obj,
  };
}

/**
 * Reuse the cached resolution if it is current for this tip + schema.
 * @param {object|null} existing
 * @param {number} tip
 * @param {boolean} force
 * @returns {boolean}
 */
function isFresh(existing, tip, force) {
  return (
    !force &&
    Boolean(existing) &&
    existing.tip === tip &&
    existing.schemaVersion === RESOLUTION_SCHEMA
  );
}

/**
 * Build (or reuse) a chain's resolution cache.
 * @param {object} ctx { client, chainKey, config, log, force?, signal?,
 *   onProgress? }
 * @returns {Promise<object>} the resolution.json contents
 */
async function buildResolution(ctx) {
  const { client, chainKey, config, log, force = false, signal } = ctx;
  const checkpoint = cp.loadCheckpoint(chainKey);
  if (!checkpoint) {
    throw new Error(
      `Run 'hexleague scan --chain ${chainKey}' before 'resolve'.`,
    );
  }
  const tip = checkpoint.pinnedTip;
  const existing = readJson(resolutionPath(chainKey), null);
  if (isFresh(existing, tip, force)) {
    log.info("[resolve %s] cache up to date at tip %d", chainKey, tip);
    return existing;
  }
  const startChunk = logChunkFor(config, chainKey);
  const hsim = HSIM_BY_CHAIN[chainKey];
  let owners = new Map();
  if (hsim) {
    const fromBlock = await findDeployBlock(client, hsim, tip);
    const io = subScanIO(chainKey, tip, "ownership", force);
    owners = await buildHsiOwnership(client, {
      hsim,
      fromBlock,
      toBlock: tip,
      startChunk,
      signal,
      load: io.load,
      save: io.save,
      onProgress: (f) => ctx.onProgress && ctx.onProgress(f * 0.5),
    });
  }
  const rawShares = await buildActiveShares(chainKey);
  const hsiOwners = activeHsiOwners(owners, rawShares);
  if (ctx.onProgress) ctx.onProgress(0.5);
  const wrappers = [];
  for (const w of WRAPPERS_BY_CHAIN[chainKey] ?? []) {
    const io = subScanIO(
      chainKey,
      tip,
      `wrapper:${w.token.toLowerCase()}`,
      force,
    );
    wrappers.push(
      await scanWrapper(client, w, {
        toBlock: tip,
        startChunk,
        signal,
        load: io.load,
        save: io.save,
      }),
    );
  }
  if (ctx.onProgress) ctx.onProgress(1);
  const resolution = {
    schemaVersion: RESOLUTION_SCHEMA,
    chain: chainKey,
    tip,
    hsiOwners,
    wrappers,
  };
  writeJson(resolutionPath(chainKey), resolution);
  clearProgress(chainKey);
  log.info(
    "[resolve %s] %d active HSI owners, %d wrapper(s) at tip %d",
    chainKey,
    Object.keys(hsiOwners).length,
    wrappers.length,
    tip,
  );
  return resolution;
}

module.exports = { buildResolution, activeHsiOwners };
