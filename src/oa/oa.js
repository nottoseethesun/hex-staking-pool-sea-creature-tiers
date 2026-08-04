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
const { bfsFromOa } = require("./graph");
const { classifyFunding } = require("./attribution");
const {
  collectHexInbound,
  collectNativeInbound,
  chunkArray,
} = require("./funding-graph");
const { logChunkFor } = require("../config");
const cp = require("../scan/checkpoint");
const { readJson, writeJson, chainDir } = require("../cache/store");
const tuning = require("../../config/tuning.json");
const { createFlushGate } = require("../cache/flush-gate");

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
 * candidate set, returning the batch index to resume from (0 = start fresh).
 * @param {object|null} prev checkpoint contents
 * @param {number} tip
 * @param {string[]} candidates
 * @param {any[][]} batches
 * @param {Map<string, object>} totals mutated in place with the restored totals
 * @returns {number}
 */
function resumeInbound(prev, tip, candidates, batches, totals) {
  if (
    !prev ||
    prev.tip !== tip ||
    prev.candidateCount !== candidates.length ||
    prev.batchCount !== batches.length
  ) {
    return 0;
  }
  for (const [a, t] of Object.entries(prev.totals)) {
    const cur = totals.get(a);
    if (cur) {
      cur.totalHex = BigInt(t.hex);
      cur.totalNative = BigInt(t.native);
    }
  }
  return prev.doneBatches ?? 0;
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
 *   collectHex?, collectNative?, batchSize?, signal? }
 * @returns {Promise<Map<string, { totalHex: bigint, totalNative: bigint }>>}
 */
async function computeInbound(client, candidates, ctx) {
  const collectHex = ctx.collectHex ?? collectHexInbound;
  const collectNative = ctx.collectNative ?? collectNativeInbound;
  const tip = ctx.toBlock;
  const totals = new Map();
  for (const a of candidates) totals.set(a, { totalHex: 0n, totalNative: 0n });
  const batches = chunkArray(candidates, ctx.batchSize ?? INBOUND_BATCH);
  const startBatch = resumeInbound(
    ctx.load ? ctx.load() : null,
    tip,
    candidates,
    batches,
    totals,
  );
  const gate = createFlushGate({
    everyItems: tuning.flushEveryChunks,
    everyMs: tuning.flushEveryMs,
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
      batchCount: batches.length,
      doneBatches: done,
      totals: obj,
    });
  };
  let done = startBatch;
  try {
    for (let i = startBatch; i < batches.length; i += 1) {
      ctx.signal?.throwIfAborted();
      const acc = new Map(batches[i].map((a) => [a, { hex: 0n, native: 0n }]));
      const onEdge = (e) => {
        const b = acc.get(e.to);
        if (!b) return;
        if (e.asset === "hex") b.hex += e.value;
        else b.native += e.value;
      };
      const base = {
        addresses: batches[i],
        fromBlock: ctx.fromBlock,
        toBlock: tip,
        onEdge,
        signal: ctx.signal,
      };
      await collectHex(client, { ...base, startChunk: ctx.startChunk });
      await collectNative(client, { ...base, startChunk: NATIVE_CHUNK });
      for (const [a, b] of acc) {
        const t = totals.get(a);
        t.totalHex += b.hex;
        t.totalNative += b.native;
      }
      done = i + 1;
      gate.add(1);
      if (gate.due()) save(done);
      if (ctx.onProgress) ctx.onProgress(done / batches.length);
    }
  } finally {
    // Persist completed batches on normal completion OR a clean abort.
    save(done);
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
  // OA progress: the BFS drives the first half, inbound the second half.
  const { reachable, contracts } = await bfsFromOa(client, {
    ...scanCtx,
    onProgress: (f) => ctx.onProgress && ctx.onProgress(f * 0.5),
  });
  saveCodeCache(chainKey, codeCache);
  const oaLower = ORIGIN_ADDRESS.toLowerCase();
  const candidates = [...reachable.keys()].filter(
    (a) => a !== oaLower && activeStakers.has(a),
  );
  const totals = await computeInbound(client, candidates, {
    ...scanCtx,
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
  const oaJson = {
    oa: checksum(ORIGIN_ADDRESS),
    chain: chainKey,
    tip,
    params: {
      maxHops: config.oaMaxHops,
      fundingThreshold: config.oaFundingThreshold,
    },
    reachableCount: reachable.size - 1,
    candidateStakerCount: candidates.length,
    memberCount: members.length,
    members,
    contractsSeen: [...contracts.entries()].map(([addr, firstTx]) => ({
      addr: checksum(addr),
      firstTx,
    })),
  };
  writeJson(oaPath(chainKey), oaJson);
  // The inbound sweep is complete and captured in oa.json; drop its checkpoint.
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
  memberAddressSet,
  oaPath,
};
