/**
 * @file src/oa/oa.js
 * @description Stage 3 — Origin-Address (OA) cluster construction. Forward-BFS
 * from the OA to OA_MAX_HOPS (numerator per asset), then for each reached wallet
 * that is an active staker, fetch its total inbound (denominator) and classify it
 * as OA when >= OA_FUNDING_THRESHOLD of HEX or native inbound is OA-attributed.
 * The inbound sweep — the heaviest part — is resumable: it checkpoints per-batch
 * totals to data/<chain>/oa-inbound.json (cleared once oa.json is written), so an
 * interrupted sweep resumes from the next unfinished batch instead of restarting.
 * Writes an evidence-backed data/<chain>/oa.json (reused when the tip is
 * unchanged) and an immutable getCode cache (data/<chain>/codes.json).
 */

"use strict";

const path = require("path");
const fs = require("fs");
const { ORIGIN_ADDRESS } = require("../chain/constants");
const { checksum } = require("../chain/address");
const { bfsFromOa, deltaBfs } = require("./graph");
const { loadOaState, saveOaState } = require("./oa-state");
const { classifyFunding } = require("./attribution");
const {
  collectHexInbound,
  collectNativeInbound,
  chunkArray,
} = require("./funding-graph");
const { logChunkFor } = require("../config");
const { makeProgressLogger } = require("../log");
const cp = require("../scan/checkpoint");
const { readJson, writeJson, chainDir } = require("../cache/store");
const tuning = require("../../config/tuning.json");
const { createFlushGate } = require("../cache/flush-gate");
const { makeClientPool } = require("../rpc/make-client");

/** trace_filter block window for OA native scans (traces are heavy). */
const NATIVE_CHUNK = tuning.nativeTraceChunk;
/** Addresses per inbound-denominator batch. */
const INBOUND_BATCH = tuning.batchSize;

/** @param {string} chainKey @returns {string} */
function codesPath(chainKey) {
  return path.join(chainDir(chainKey), "codes.json");
}

/** @param {string} chainKey @returns {string} */
function oaPath(chainKey) {
  return path.join(chainDir(chainKey), "oa.json");
}

/** @param {string} chainKey @returns {string} */
function oaInboundPath(chainKey) {
  return path.join(chainDir(chainKey), "oa-inbound.json");
}

/** @param {string} chainKey @returns {Map<string, boolean>} */
function loadCodeCache(chainKey) {
  return new Map(Object.entries(readJson(codesPath(chainKey), {})));
}

/** @param {string} chainKey @param {Map<string, boolean>} cache */
function saveCodeCache(chainKey, cache) {
  writeJson(codesPath(chainKey), Object.fromEntries(cache));
}

/**
 * Restore prior inbound totals when the checkpoint is for this exact tip and
 * candidate set, returning the batch index to resume from (0 = start fresh) and
 * the accumulated inbound-sweep wall-clock so far (0 = start fresh).
 * @param {object|null} prev checkpoint contents
 * @param {number} tip
 * @param {string[]} candidates
 * @param {any[][]} batches
 * @param {Map<string, object>} totals mutated in place with the restored totals
 * @returns {{ startBatch: number, elapsedMs: number }}
 */
function resumeInbound(prev, tip, candidates, batches, totals) {
  if (
    !prev ||
    prev.tip !== tip ||
    prev.candidateCount !== candidates.length ||
    prev.batchCount !== batches.length
  ) {
    return { startBatch: 0, elapsedMs: 0 };
  }
  for (const [a, t] of Object.entries(prev.totals)) {
    const cur = totals.get(a);
    if (cur) {
      cur.totalHex = BigInt(t.hex);
      cur.totalNative = BigInt(t.native);
    }
  }
  return { startBatch: prev.doneBatches ?? 0, elapsedMs: prev.elapsedMs ?? 0 };
}

/**
 * Seed each candidate's running total from a prior cycle's cached inbound (when
 * present), so an incremental sweep extends it; unseen candidates start at zero.
 * @param {string[]} candidates
 * @param {object} [prior] { tip, totals: { addr: { hex, native } } }
 * @returns {Map<string, { totalHex: bigint, totalNative: bigint }>}
 */
function seedTotals(candidates, prior) {
  const base = prior && prior.totals ? prior.totals : {};
  const totals = new Map();
  for (const a of candidates) {
    const p = base[a];
    totals.set(a, {
      totalHex: p ? BigInt(p.hex) : 0n,
      totalNative: p ? BigInt(p.native) : 0n,
    });
  }
  return totals;
}

/**
 * Plan the inbound batches. Without a prior, every candidate is scanned over the
 * full range (`ctx.fromBlock`). With a prior, candidates carried forward are
 * rescanned only over (prior.tip, tip]; genuinely new candidates get the full
 * range. Each batch is tagged with the fromBlock it should be scanned over.
 * @param {string[]} candidates
 * @param {object} ctx { fromBlock, prior?, batchSize? }
 * @returns {{ addresses: string[], fromBlock: number }[]}
 */
function planInbound(candidates, ctx) {
  const size = ctx.batchSize ?? INBOUND_BATCH;
  const tag = (addresses, fromBlock) => ({ addresses, fromBlock });
  const carried = ctx.prior && ctx.prior.totals;
  if (!carried) {
    return chunkArray(candidates, size).map((b) => tag(b, ctx.fromBlock));
  }
  const known = candidates.filter((a) => carried[a]);
  const fresh = candidates.filter((a) => !carried[a]);
  return [
    ...chunkArray(known, size).map((b) => tag(b, ctx.prior.tip + 1)),
    ...chunkArray(fresh, size).map((b) => tag(b, ctx.fromBlock)),
  ];
}

/**
 * Scan one candidate batch's total inbound (HEX via getLogs, native via
 * trace_filter) over its range, returning per-address { hex, native } deltas.
 * @param {object} client the endpoint to use (a pool worker's shard)
 * @param {{ addresses: string[], fromBlock: number }} entry
 * @param {object} ctx { tip, startChunk, signal, collectHex, collectNative }
 * @returns {Promise<Map<string, { hex: bigint, native: bigint }>>}
 */
async function scanInboundBatch(client, entry, ctx) {
  const acc = new Map(entry.addresses.map((a) => [a, { hex: 0n, native: 0n }]));
  const onEdge = (e) => {
    const b = acc.get(e.to);
    if (!b) return;
    if (e.asset === "hex") b.hex += e.value;
    else b.native += e.value;
  };
  const base = {
    addresses: entry.addresses,
    fromBlock: entry.fromBlock,
    toBlock: ctx.tip,
    onEdge,
    signal: ctx.signal,
  };
  await ctx.collectHex(client, { ...base, startChunk: ctx.startChunk });
  await ctx.collectNative(client, { ...base, startChunk: NATIVE_CHUNK });
  return acc;
}

/**
 * Total inbound (HEX + native) per candidate address, batched and RESUMABLE.
 * After each batch completes, its totals are folded into the running result,
 * which is checkpointed (in batches via the flush gate, and on a clean abort)
 * through `ctx.load` / `ctx.save` — so an interrupted inbound scan resumes from
 * the next unfinished batch instead of restarting the whole (multi-hour) sweep.
 * Each batch accumulates into a batch-local map and merges only on completion, so
 * a mid-batch abort never leaves a partial, double-countable total.
 * `collectHex` / `collectNative` and `batchSize` are injectable for tests.
 * @param {object} client
 * @param {string[]} candidates
 * @param {object} ctx { fromBlock, toBlock, startChunk, onProgress?, load?, save?,
 *   collectHex?, collectNative?, batchSize?, signal?, now?, prior?, clients? } —
 *   `prior` ({ tip, totals }) makes it incremental (carried candidates extend
 *   from prior.tip, new ones scan the full range); `clients` (a pool) shards the
 *   batches across endpoints, merging only the contiguous done-prefix into the
 *   checkpoint so a resumed run never double-counts.
 * @returns {Promise<Map<string, { totalHex: bigint, totalNative: bigint }>>}
 */
async function computeInbound(client, candidates, ctx) {
  const collectHex = ctx.collectHex ?? collectHexInbound;
  const collectNative = ctx.collectNative ?? collectNativeInbound;
  const tip = ctx.toBlock;
  const totals = seedTotals(candidates, ctx.prior);
  const plan = planInbound(candidates, ctx);
  const { startBatch, elapsedMs: baseElapsed } = resumeInbound(
    ctx.load ? ctx.load() : null,
    tip,
    candidates,
    plan,
    totals,
  );
  // Accumulate the inbound sweep's wall-clock across resumes so the report can
  // surface a measured re-scan cost. `ctx.now` is injectable for tests.
  const now = ctx.now ?? Date.now;
  const startedAt = now();
  const gate = createFlushGate({
    everyItems: ctx.everyItems ?? tuning.flushEveryChunks,
    everyMs: ctx.everyMs ?? tuning.flushEveryMs,
  });
  const save = (done) => {
    if (!ctx.save) return;
    const obj = {};
    for (const [a, t] of totals) {
      obj[a] = { hex: t.totalHex.toString(), native: t.totalNative.toString() };
    }
    ctx.save({
      tip,
      candidateCount: candidates.length,
      batchCount: plan.length,
      doneBatches: done,
      elapsedMs: baseElapsed + (now() - startedAt),
      totals: obj,
    });
  };
  const clients = ctx.clients ?? [client];
  const batchCtx = {
    tip,
    startChunk: ctx.startChunk,
    signal: ctx.signal,
    collectHex,
    collectNative,
  };
  // Per-10% progress line for the OA wallet sweep (the long pole of a re-scan),
  // so a headless operator sees it advance. A no-op when no logger is injected.
  const progress = ctx.log
    ? makeProgressLogger(`[oa ${ctx.chainKey}]`, "OA wallet scan", {
        log: ctx.log,
      })
    : () => {};
  const pending = new Map();
  let nextIdx = startBatch;
  let cursor = startBatch; // count of batches merged into `totals` (contiguous)
  const mergeContiguous = () => {
    while (pending.has(cursor)) {
      const acc = pending.get(cursor);
      pending.delete(cursor);
      for (const [a, b] of acc) {
        const t = totals.get(a);
        t.totalHex += b.hex;
        t.totalNative += b.native;
      }
      cursor += 1;
      gate.add(1);
      if (gate.due()) save(cursor);
      if (ctx.onProgress) ctx.onProgress(cursor / plan.length);
      progress(cursor / plan.length, `${cursor}/${plan.length} batches`);
    }
  };
  const worker = async (workerClient) => {
    while (nextIdx < plan.length) {
      ctx.signal?.throwIfAborted();
      const i = nextIdx;
      nextIdx += 1;
      pending.set(i, await scanInboundBatch(workerClient, plan[i], batchCtx));
      mergeContiguous();
    }
  };
  try {
    await Promise.all(clients.map((c) => worker(c)));
  } finally {
    // Merge whatever finished, then persist the contiguous prefix (survives a
    // clean abort; the checkpoint never counts an out-of-order batch).
    mergeContiguous();
    save(cursor);
  }
  return totals;
}

/**
 * Classify candidate stakers into OA members with evidence + fractions.
 * @param {string[]} candidates
 * @param {Map<string, object>} reachable
 * @param {Map<string, object>} totals
 * @param {number} threshold
 * @returns {object[]}
 */
function buildMembers(candidates, reachable, totals, threshold) {
  const members = [];
  for (const addr of candidates) {
    const node = reachable.get(addr);
    const inb = totals.get(addr);
    const funding = {
      oaHex: node.oaHex,
      totalHex: inb.totalHex,
      oaNative: node.oaNative,
      totalNative: inb.totalNative,
    };
    const cls = classifyFunding(funding, threshold);
    if (!cls.isOa) continue;
    members.push({
      addr: checksum(addr),
      depth: node.depth,
      via: node.via ? checksum(node.via) : null,
      fracHex: cls.fracHex,
      fracNative: cls.fracNative,
      oaHex: node.oaHex.toString(),
      totalHex: inb.totalHex.toString(),
      oaNative: node.oaNative.toString(),
      totalNative: inb.totalNative.toString(),
      evidence: node.evidence,
    });
  }
  return members;
}

/**
 * Resolve the OA reachable set for this tip. When a cached state exists for an
 * earlier tip (same deploy block), extend it incrementally via `deltaBfs` —
 * falling back to a full `bfsFromOa` if that pass reports it can't stay exact.
 * Otherwise, a full BFS from scratch. Returns the cluster plus the prior inbound
 * cache to extend (null on a full build).
 * @param {object} client
 * @param {object} scanCtx
 * @param {object|null} prevState loadOaState() result
 * @param {(f: number) => void} onProgress
 * @param {object} [deps] { deltaBfs, bfsFromOa } — injectable for tests
 * @returns {Promise<{ reachable: Map, contracts: Map, prior: object|null }>}
 */
async function resolveCluster(
  client,
  scanCtx,
  prevState,
  onProgress,
  deps = { deltaBfs, bfsFromOa },
) {
  const resumable =
    prevState &&
    prevState.tip < scanCtx.toBlock &&
    prevState.deployBlock === scanCtx.fromBlock;
  if (resumable) {
    const delta = await deps.deltaBfs(client, {
      ...scanCtx,
      prevTip: prevState.tip,
      reachable: prevState.reachable,
      contracts: prevState.contracts,
    });
    if (!delta.needsFullRebuild) {
      scanCtx.log.info(
        "[oa %s] extended cluster incrementally from tip %d",
        scanCtx.chainKey,
        prevState.tip,
      );
      onProgress(1);
      return {
        reachable: delta.reachable,
        contracts: delta.contracts,
        prior: { tip: prevState.tip, totals: prevState.inbound },
      };
    }
    scanCtx.log.info(
      "[oa %s] cluster shifted; falling back to a full rebuild",
      scanCtx.chainKey,
    );
  }
  const full = await deps.bfsFromOa(client, { ...scanCtx, onProgress });
  return { reachable: full.reachable, contracts: full.contracts, prior: null };
}

/**
 * Build (or reuse) the OA cluster for a chain.
 * @param {object} ctx { client, chainKey, config, log, activeStakers, force?,
 *   onProgress? } — onProgress(0..1) reports inbound-batch progress.
 * @returns {Promise<object>} the oa.json contents
 */
async function buildOa(ctx) {
  const { client, chainKey, config, log, activeStakers, force = false } = ctx;
  const deployBlock = cp.loadDeployBlock(chainKey);
  const checkpoint = cp.loadCheckpoint(chainKey);
  if (deployBlock === null || !checkpoint) {
    throw new Error(`Run 'hexleague scan --chain ${chainKey}' before 'oa'.`);
  }
  const tip = checkpoint.pinnedTip;
  const existing = readJson(oaPath(chainKey), null);
  if (!force && existing && existing.tip === tip) {
    log.info("[oa %s] cache up to date at tip %d", chainKey, tip);
    return existing;
  }
  const codeCache = loadCodeCache(chainKey);
  const scanCtx = {
    oa: ORIGIN_ADDRESS,
    fromBlock: deployBlock,
    toBlock: tip,
    startChunk: logChunkFor(config, chainKey),
    nativeChunk: NATIVE_CHUNK,
    maxHops: config.oaMaxHops,
    codeCache,
    log,
    chainKey,
    signal: ctx.signal,
  };
  // OA progress: the BFS drives the first half, inbound the second half. A
  // cached state (from an earlier tip) lets the BFS + inbound extend over only
  // the new block range instead of rebuilding from the deploy block.
  const prevState = force ? null : loadOaState(chainKey);
  const { reachable, contracts, prior } = await resolveCluster(
    client,
    scanCtx,
    prevState,
    (f) => ctx.onProgress && ctx.onProgress(f * 0.5),
  );
  saveCodeCache(chainKey, codeCache);
  const oaLower = ORIGIN_ADDRESS.toLowerCase();
  const candidates = [...reachable.keys()].filter(
    (a) => a !== oaLower && activeStakers.has(a),
  );
  const totals = await computeInbound(client, candidates, {
    ...scanCtx,
    prior,
    clients: makeClientPool(config, chainKey),
    load: () => readJson(oaInboundPath(chainKey), null),
    save: (obj) => writeJson(oaInboundPath(chainKey), obj),
    onProgress: (f) => ctx.onProgress && ctx.onProgress(0.5 + f * 0.5),
  });
  const members = buildMembers(
    candidates,
    reachable,
    totals,
    config.oaFundingThreshold,
  );
  // The inbound sweep just completed; its final checkpoint carries the measured
  // wall-clock, which we fold into oa.json as the re-scan cost estimate.
  const inboundCp = readJson(oaInboundPath(chainKey), null);
  const oaJson = {
    oa: checksum(ORIGIN_ADDRESS),
    chain: chainKey,
    tip,
    deployBlock,
    params: {
      maxHops: config.oaMaxHops,
      fundingThreshold: config.oaFundingThreshold,
    },
    reachableCount: reachable.size - 1,
    candidateStakerCount: candidates.length,
    memberCount: members.length,
    sweep: {
      inboundMs: inboundCp ? (inboundCp.elapsedMs ?? null) : null,
      candidates: candidates.length,
      finishedUtc: new Date().toISOString(),
    },
    members,
    contractsSeen: [...contracts.entries()].map(([addr, firstTx]) => ({
      addr: checksum(addr),
      firstTx,
    })),
  };
  // Persist the full cluster + inbound totals so the next cycle can extend them.
  saveOaState(chainKey, {
    tip,
    deployBlock,
    reachable,
    contracts,
    inbound: totals,
  });
  writeJson(oaPath(chainKey), oaJson);
  // oa.json now captures the sweep; drop its intermediate within-run checkpoint
  // (oa-state.json persists across cycles for the next incremental Re-Scan).
  fs.rmSync(oaInboundPath(chainKey), { force: true });
  log.info(
    "[oa %s] %d OA-staker members of %d candidates; %d contracts flagged",
    chainKey,
    members.length,
    candidates.length,
    contracts.size,
  );
  return oaJson;
}

/**
 * Lowercased set of OA member addresses (+ OA itself) from an oa.json.
 * @param {object} oaJson
 * @returns {Set<string>}
 */
function memberAddressSet(oaJson) {
  const set = new Set();
  if (!oaJson) return set;
  set.add(oaJson.oa.toLowerCase());
  for (const m of oaJson.members || []) set.add(m.addr.toLowerCase());
  return set;
}

module.exports = {
  buildOa,
  buildMembers,
  computeInbound,
  resolveCluster,
  memberAddressSet,
  oaPath,
};
