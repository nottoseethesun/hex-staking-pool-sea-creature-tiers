/**
 * @file src/oa/graph.js
 * @description Forward BFS from the OA over HEX + native funding edges to depth
 * OA_MAX_HOPS. Accumulates, per reached EOA, the OA-attributed inbound value per
 * asset (numerator for the >=20% test), its shortest hop depth, a funding
 * predecessor, and capped evidence tx hashes. Contracts are terminal (recorded,
 * not propagated). This reachable set is provably identical to reverse-spidering
 * <= maxHops from every staker, but rooted at one address instead of ~236k.
 *
 * `deltaBfs` extends an already-built reachable set to a newer tip without
 * rescanning history: existing nodes are rescanned only over the new block
 * range, newly-joined nodes over the full range (a wallet that only now joined
 * the cluster may have funded others at any past block), and numerators
 * accumulate additively so no edge is double-counted. A rare change that would
 * shorten an already-explored node's hop depth (a relaxation this pass can't
 * complete without the full edge set) returns `needsFullRebuild: true`, so the
 * caller falls back to a full BFS and the result always equals a from-scratch
 * scan.
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
  const recipients = ctx.into ?? new Map();
  const onEdge = (e) => accumulateEdge(recipients, e);
  const common = {
    fromBlock: ctx.fromBlock,
    toBlock: ctx.toBlock,
    onEdge,
    signal: ctx.signal,
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
    ctx.signal?.throwIfAborted();
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

/**
 * Collect funding edges out of `nodes` over one block range into a shared
 * recipients accumulator (a no-op for an empty node list).
 * @param {object} client
 * @param {Function} collect collectLayer (injectable for tests)
 * @param {string[]} nodes
 * @param {object} ctx carries fromBlock/toBlock/startChunk/nativeChunk/signal
 * @param {Map<string, object>} into shared recipients accumulator
 */
async function collectRange(client, collect, nodes, ctx, into) {
  if (nodes.length === 0) return;
  await collect(client, nodes, { ...ctx, into });
}

/**
 * Apply one recipient aggregate during a delta pass: record contracts, add the
 * new inflow to an existing node's numerator, or register a brand-new node.
 * Returns "cascade" when the change would shorten an ALREADY-explored node's hop
 * depth — a relaxation this pass can't complete without the full edge set, so
 * the caller must fall back to a full BFS.
 * @param {string} addr
 * @param {object} agg recipient aggregate { hex, native, via, ev }
 * @param {number} depth this hop's depth
 * @param {object} state { reachable, contracts, codes, maxHops, next, newSet }
 * @returns {"ok" | "cascade"}
 */
function applyDeltaRecipient(addr, agg, depth, state) {
  const { reachable, contracts, codes, maxHops, next, newSet } = state;
  if (contracts.has(addr)) return "ok";
  if (codes.get(addr) === true) {
    contracts.set(addr, agg.ev[0] ? agg.ev[0].txHash : null);
    return "ok";
  }
  const node = reachable.get(addr);
  if (!node) {
    reachable.set(addr, {
      depth,
      via: agg.via,
      oaHex: agg.hex,
      oaNative: agg.native,
      evidence: agg.ev.slice(0, MAX_EVIDENCE),
    });
    newSet.add(addr);
    if (codes.has(addr) && depth < maxHops) next.push(addr);
    return "ok";
  }
  node.oaHex += agg.hex;
  node.oaNative += agg.native;
  for (const ev of agg.ev) {
    if (node.evidence.length < MAX_EVIDENCE) node.evidence.push(ev);
  }
  if (depth < node.depth) {
    const wasExplored = node.depth < maxHops;
    node.depth = depth;
    if (wasExplored) return "cascade";
    newSet.add(addr); // a former leaf, now explored -> scan its full range
    if (depth < maxHops) next.push(addr);
  }
  return "ok";
}

/**
 * Incrementally extend a cached reachable set from `prevTip` to `toBlock`, hop
 * by hop (see the module note for the correctness argument + fallback). The
 * cached `reachable` / `contracts` maps are mutated in place.
 * @param {object} client
 * @param {object} ctx { oa, deployBlock, prevTip, toBlock, startChunk,
 *   nativeChunk, maxHops, codeCache, reachable, contracts, log, chainKey,
 *   signal, collect?, classify? }
 * @returns {Promise<{ reachable: Map, contracts: Map, needsFullRebuild: boolean }>}
 */
async function deltaBfs(client, ctx) {
  const collect = ctx.collect ?? collectLayer;
  const classify = ctx.classify ?? classifyAddresses;
  const { reachable, contracts, maxHops, deployBlock, prevTip, toBlock } = ctx;
  const oa = ctx.oa.toLowerCase();
  const cachedDepth = new Map([...reachable].map(([a, n]) => [a, n.depth]));
  const newSet = new Set();
  const newRange = { fromBlock: prevTip + 1, toBlock };
  const fullRange = { fromBlock: deployBlock, toBlock };
  let carry = []; // nodes discovered/promoted last hop -> scan their full range

  for (let depth = 1; depth <= maxHops; depth += 1) {
    ctx.signal?.throwIfAborted();
    const existers = [...cachedDepth]
      .filter(([, d]) => d === depth - 1 && d < maxHops)
      .map(([a]) => a);
    if (existers.length === 0 && carry.length === 0) continue;
    const recipients = new Map();
    await collectRange(
      client,
      collect,
      existers,
      { ...ctx, ...newRange },
      recipients,
    );
    await collectRange(
      client,
      collect,
      carry,
      { ...ctx, ...fullRange },
      recipients,
    );
    const fresh = [...recipients.keys()].filter(
      (a) => a !== oa && !reachable.has(a) && !contracts.has(a),
    );
    const codes = await classify(client, fresh, ctx.codeCache);
    const next = [];
    for (const [addr, agg] of recipients) {
      if (addr === oa) continue;
      const state = { reachable, contracts, codes, maxHops, next, newSet };
      if (applyDeltaRecipient(addr, agg, depth, state) === "cascade") {
        return { reachable, contracts, needsFullRebuild: true };
      }
    }
    carry = next;
  }
  return { reachable, contracts, needsFullRebuild: false };
}

module.exports = {
  bfsFromOa,
  deltaBfs,
  accumulateEdge,
  mergeReachable,
  processRecipient,
  applyDeltaRecipient,
};
