/**
 * @file src/oa/graph.js
 * @description Forward BFS from the OA over HEX + native funding edges to depth
 * OA_MAX_HOPS. Accumulates, per reached EOA, the OA-attributed inbound value per
 * asset (numerator for the >=20% test), its shortest hop depth, a funding
 * predecessor, and capped evidence tx hashes. Contracts are terminal (recorded,
 * not propagated). This reachable set is provably identical to reverse-spidering
 * <= maxHops from every staker, but rooted at one address instead of ~236k.
 */

"use strict";

const {
  collectHexOut,
  collectNativeOut,
  classifyAddresses,
  chunkArray,
} = require("./funding-graph");
const tuning = require("../../config/tuning.json");

/** Addresses per topic-OR filter / getCode batch. */
const BATCH = tuning.batchSize;
/** Max evidence tx hashes retained per member (auditable, minimal footprint). */
const MAX_EVIDENCE = tuning.maxEvidence;

/**
 * Accumulate one funding edge into the current layer's recipient aggregate.
 * @param {Map<string, object>} recipients
 * @param {object} e edge { from, to, asset, value, block, txHash }
 */
function accumulateEdge(recipients, e) {
  if (e.to === e.from) return;
  let r = recipients.get(e.to);
  if (!r) {
    r = { hex: 0n, native: 0n, via: e.from, ev: [] };
    recipients.set(e.to, r);
  }
  if (e.asset === "hex") r.hex += e.value;
  else r.native += e.value;
  if (r.ev.length < MAX_EVIDENCE) {
    r.ev.push({
      kind: e.asset,
      txHash: e.txHash,
      block: e.block,
      amount: e.value.toString(),
    });
  }
}

/**
 * Merge a layer's recipient inflow into the reachable node record.
 * @param {Map<string, object>} reachable
 * @param {string} addr
 * @param {object} agg
 * @param {number} depth
 */
function mergeReachable(reachable, addr, agg, depth) {
  let node = reachable.get(addr);
  if (!node) {
    node = { depth, via: agg.via, oaHex: 0n, oaNative: 0n, evidence: [] };
    reachable.set(addr, node);
  }
  node.oaHex += agg.hex;
  node.oaNative += agg.native;
  for (const ev of agg.ev) {
    if (node.evidence.length < MAX_EVIDENCE) node.evidence.push(ev);
  }
}

/**
 * Collect every funding edge out of a frontier into a recipients map.
 * @param {object} client
 * @param {string[]} frontier
 * @param {object} ctx
 * @returns {Promise<Map<string, object>>}
 */
async function collectLayer(client, frontier, ctx) {
  const recipients = new Map();
  const onEdge = (e) => accumulateEdge(recipients, e);
  const common = {
    fromBlock: ctx.fromBlock,
    toBlock: ctx.toBlock,
    onEdge,
  };
  const batches = chunkArray(frontier, BATCH);
  const report = (i, f) =>
    ctx.onLayerProgress && ctx.onLayerProgress((i + f) / batches.length);
  for (let i = 0; i < batches.length; i += 1) {
    await collectHexOut(client, {
      ...common,
      addresses: batches[i],
      startChunk: ctx.startChunk,
      onProgress: (f) => report(i, f),
    });
    await collectNativeOut(client, {
      ...common,
      addresses: batches[i],
      startChunk: ctx.nativeChunk,
    });
    report(i + 1, 0);
  }
  return recipients;
}

/**
 * Process one recipient: skip/record contracts, merge EOA inflow, and queue
 * fresh EOAs for the next hop.
 * @param {string} addr
 * @param {object} agg
 * @param {object} state { reachable, contracts, codes, depth, maxHops, next }
 */
function processRecipient(addr, agg, state) {
  const { reachable, contracts, codes, depth, maxHops, next } = state;
  if (contracts.has(addr)) return;
  if (codes.get(addr) === true) {
    contracts.set(addr, agg.ev[0] ? agg.ev[0].txHash : null);
    return;
  }
  mergeReachable(reachable, addr, agg, depth);
  if (codes.has(addr) && depth < maxHops) next.push(addr);
}

/**
 * Run the forward BFS from the OA.
 * @param {object} client
 * @param {object} ctx { oa, fromBlock, toBlock, startChunk, nativeChunk, maxHops, codeCache, log, chainKey, onProgress? } — onProgress(0..1) fires per completed hop
 * @returns {Promise<{ reachable: Map<string, object>, contracts: Map<string, string> }>}
 */
async function bfsFromOa(client, ctx) {
  const oa = ctx.oa.toLowerCase();
  const reachable = new Map();
  const contracts = new Map();
  reachable.set(oa, {
    depth: 0,
    via: null,
    oaHex: 0n,
    oaNative: 0n,
    evidence: [],
  });
  let frontier = [oa];
  for (let depth = 1; depth <= ctx.maxHops && frontier.length > 0; depth += 1) {
    const base = depth - 1;
    const recipients = await collectLayer(client, frontier, {
      ...ctx,
      onLayerProgress: (f) =>
        ctx.onProgress && ctx.onProgress((base + f) / ctx.maxHops),
    });
    const fresh = [...recipients.keys()].filter(
      (a) => a !== oa && !reachable.has(a) && !contracts.has(a),
    );
    const codes = await classifyAddresses(client, fresh, ctx.codeCache);
    const next = [];
    for (const [addr, agg] of recipients) {
      if (addr === oa) continue;
      processRecipient(addr, agg, {
        reachable,
        contracts,
        codes,
        depth,
        maxHops: ctx.maxHops,
        next,
      });
    }
    ctx.log.info(
      "[oa %s] hop %d: %d recipients, next frontier %d",
      ctx.chainKey,
      depth,
      recipients.size,
      next.length,
    );
    if (ctx.onProgress) ctx.onProgress(depth / ctx.maxHops);
    frontier = next;
  }
  return { reachable, contracts };
}

module.exports = {
  bfsFromOa,
  accumulateEdge,
  mergeReachable,
  processRecipient,
};
