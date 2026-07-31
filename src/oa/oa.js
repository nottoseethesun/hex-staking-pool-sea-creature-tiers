/**
 * @file src/oa/oa.js
 * @description Stage 3 — OA cluster construction. Forward-BFS from the OA to
 * OA_MAX_HOPS (numerator per asset), then for each reached wallet that is an
 * active staker, fetch its total inbound (denominator) and classify it as OA
 * when >= OA_FUNDING_THRESHOLD of HEX or native inbound is OA-attributed. Writes
 * an evidence-backed data/<chain>/oa.json (reused when the tip is unchanged) and
 * an immutable getCode cache (data/<chain>/codes.json).
 */

"use strict";

const path = require("path");
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

/** @param {string} chainKey @returns {Map<string, boolean>} */
function loadCodeCache(chainKey) {
  return new Map(Object.entries(readJson(codesPath(chainKey), {})));
}

/** @param {string} chainKey @param {Map<string, boolean>} cache */
function saveCodeCache(chainKey, cache) {
  writeJson(codesPath(chainKey), Object.fromEntries(cache));
}

/**
 * Total inbound (HEX + native) per candidate address, batched. Reports batch
 * progress (0..1) via `ctx.onProgress` so the OA stage can drive the bar.
 * @param {object} client
 * @param {string[]} candidates
 * @param {object} ctx { fromBlock, toBlock, startChunk, onProgress? }
 * @returns {Promise<Map<string, { totalHex: bigint, totalNative: bigint }>>}
 */
async function computeInbound(client, candidates, ctx) {
  const totals = new Map();
  for (const a of candidates) {
    totals.set(a, { totalHex: 0n, totalNative: 0n });
  }
  const onEdge = (e) => {
    const t = totals.get(e.to);
    if (!t) return;
    if (e.asset === "hex") t.totalHex += e.value;
    else t.totalNative += e.value;
  };
  const batches = chunkArray(candidates, INBOUND_BATCH);
  for (let i = 0; i < batches.length; i += 1) {
    ctx.signal?.throwIfAborted();
    const base = {
      addresses: batches[i],
      fromBlock: ctx.fromBlock,
      toBlock: ctx.toBlock,
      onEdge,
      signal: ctx.signal,
    };
    await collectHexInbound(client, { ...base, startChunk: ctx.startChunk });
    await collectNativeInbound(client, { ...base, startChunk: NATIVE_CHUNK });
    if (ctx.onProgress) ctx.onProgress((i + 1) / batches.length);
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
