/**
 * @file src/resolve/resolve.js
 * @description Stage 2 (scan -> RESOLVE -> oa -> report). Builds a chain's
 * resolution cache from the HSIM ownership log and the look-through wrapper
 * tokens ($MAXI), scanned to the stakes checkpoint's pinned tip. The cache
 * (data/<chain>/resolution.json) holds the HSI->owner map for currently-active
 * HSIs plus each wrapper's holder balances + supply, and is reused while the tip
 * is unchanged (cf. oa.json). buildResolvedShares (resolution.js) consumes it.
 */

"use strict";

const { HSIM_BY_CHAIN, WRAPPERS_BY_CHAIN } = require("../chain/constants");
const { findDeployBlock } = require("../chain/deploy-block");
const { buildActiveShares } = require("../scan/scan");
const { buildHsiOwnership } = require("./ownership");
const { scanWrapperBalances } = require("./wrapped");
const { resolutionPath } = require("./resolution");
const { logChunkFor } = require("../config");
const { readJson, writeJson } = require("../cache/store");
const cp = require("../scan/checkpoint");

/** Bump when the resolution schema/semantics change. */
const RESOLUTION_SCHEMA = 1;

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
    owners = await buildHsiOwnership(client, {
      hsim,
      fromBlock,
      toBlock: tip,
      startChunk,
      signal,
      onProgress: (f) => ctx.onProgress && ctx.onProgress(f * 0.5),
    });
  }
  const rawShares = await buildActiveShares(chainKey);
  const hsiOwners = activeHsiOwners(owners, rawShares);
  if (ctx.onProgress) ctx.onProgress(0.5);
  const wrappers = [];
  for (const w of WRAPPERS_BY_CHAIN[chainKey] ?? []) {
    wrappers.push(
      await scanWrapper(client, w, { toBlock: tip, startChunk, signal }),
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
