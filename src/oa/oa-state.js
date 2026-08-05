/**
 * @file src/oa/oa-state.js
 * @description Persist the OA cluster's full working state across sync cycles so
 * a Re-Scan can extend it incrementally instead of rebuilding from the deploy
 * block. Holds the reachable set (per-node OA-attributed totals, hop depth,
 * funder, capped evidence), the terminal-contract list, and every candidate's
 * cached inbound denominator — all keyed to the tip they were computed at, and
 * to the deploy block (a changed deploy block invalidates the state). BigInts
 * serialize as decimal strings; the file is written compactly (it can be large).
 */

"use strict";

const path = require("path");
const { readJson, writeJsonCompact, chainDir } = require("../cache/store");

/** @param {string} chainKey @returns {string} */
function oaStatePath(chainKey) {
  return path.join(chainDir(chainKey), "oa-state.json");
}

/**
 * Serialize the reachable map (BigInt totals -> strings).
 * @param {Map<string, object>} reachable
 * @returns {Record<string, object>}
 */
function serializeReachable(reachable) {
  const out = {};
  for (const [addr, n] of reachable) {
    out[addr] = {
      depth: n.depth,
      via: n.via,
      oaHex: n.oaHex.toString(),
      oaNative: n.oaNative.toString(),
      evidence: n.evidence,
    };
  }
  return out;
}

/**
 * Rehydrate the reachable map (strings -> BigInt totals).
 * @param {Record<string, object>} obj
 * @returns {Map<string, object>}
 */
function deserializeReachable(obj) {
  const m = new Map();
  for (const [addr, n] of Object.entries(obj || {})) {
    m.set(addr, {
      depth: n.depth,
      via: n.via,
      oaHex: BigInt(n.oaHex),
      oaNative: BigInt(n.oaNative),
      evidence: n.evidence || [],
    });
  }
  return m;
}

/**
 * Serialize per-candidate inbound totals (BigInt -> string), keyed { hex, native }
 * so the shape matches `computeInbound`'s `prior.totals`.
 * @param {Map<string, { totalHex: bigint, totalNative: bigint }>} totals
 * @returns {Record<string, { hex: string, native: string }>}
 */
function serializeInbound(totals) {
  const out = {};
  for (const [addr, t] of totals) {
    out[addr] = {
      hex: t.totalHex.toString(),
      native: t.totalNative.toString(),
    };
  }
  return out;
}

/**
 * Persist the OA state for the next cycle to extend.
 * @param {string} chainKey
 * @param {object} state { tip, deployBlock, reachable, contracts, inbound }
 */
function saveOaState(chainKey, state) {
  writeJsonCompact(oaStatePath(chainKey), {
    tip: state.tip,
    deployBlock: state.deployBlock,
    reachable: serializeReachable(state.reachable),
    contracts: Object.fromEntries(state.contracts),
    inbound: serializeInbound(state.inbound),
  });
}

/**
 * Load the cached OA state, or null when absent. `inbound` is returned as the
 * plain `{ addr: { hex, native } }` object (ready to pass as `prior.totals`).
 * @param {string} chainKey
 * @returns {{ tip: number, deployBlock: number, reachable: Map, contracts: Map,
 *   inbound: Record<string, object> } | null}
 */
function loadOaState(chainKey) {
  const raw = readJson(oaStatePath(chainKey), null);
  if (!raw) return null;
  return {
    tip: raw.tip,
    deployBlock: raw.deployBlock,
    reachable: deserializeReachable(raw.reachable),
    contracts: new Map(Object.entries(raw.contracts || {})),
    inbound: raw.inbound || {},
  };
}

module.exports = {
  oaStatePath,
  saveOaState,
  loadOaState,
  serializeReachable,
  deserializeReachable,
  serializeInbound,
};
