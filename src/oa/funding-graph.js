/**
 * @file src/oa/funding-graph.js
 * @description Primitives for the OA funding scan: collect HEX Transfer and
 * native value transfers OUT of / IN to a batch of addresses, and classify
 * addresses as contract vs EOA. Contracts are terminal — recorded in a review
 * list but never propagated (so an OA -> DEX-pair sell can't taint every buyer).
 * `collect*Out` powers the forward BFS numerator; `collect*Inbound` powers the
 * per-candidate total-inbound denominator.
 */

"use strict";

const { HEX_CONTRACT } = require("../chain/constants");
const { TRANSFER_TOPIC, iface } = require("../decode/stake-events");
const { getLogsChunked } = require("../rpc/get-logs");
const { traceOutgoing, traceIncoming } = require("../rpc/trace-filter");

/**
 * Left-pad an address to a 32-byte topic for topic-position filtering.
 * @param {string} addr
 * @returns {string}
 */
function addressTopic(addr) {
  return `0x${addr.toLowerCase().replace(/^0x/, "").padStart(64, "0")}`;
}

/**
 * Split an array into fixed-size batches.
 * @param {any[]} arr
 * @param {number} size
 * @returns {any[][]}
 */
function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

/**
 * Parse HEX Transfer logs into normalized edges. Shared by out + inbound scans.
 * @param {any[]} logs
 * @param {(edge: object) => void} onEdge
 */
function emitTransferEdges(logs, onEdge) {
  for (const logRow of logs) {
    const parsed = iface.parseLog({ topics: logRow.topics, data: logRow.data });
    if (!parsed || parsed.name !== "Transfer") continue;
    onEdge({
      from: parsed.args.from.toLowerCase(),
      to: parsed.args.to.toLowerCase(),
      asset: "hex",
      value: parsed.args.value,
      block: logRow.blockNumber,
      txHash: logRow.transactionHash,
    });
  }
}

/**
 * Normalize a native trace transfer into an edge.
 * @param {object} t
 * @returns {object}
 */
function nativeEdge(t) {
  return {
    from: t.from.toLowerCase(),
    to: t.to.toLowerCase(),
    asset: "native",
    value: t.value,
    block: t.block,
    txHash: t.txHash,
  };
}

/**
 * Stream HEX Transfer edges OUT of `addresses` (from-position topic filter).
 * @param {object} client
 * @param {object} opts { addresses, fromBlock, toBlock, startChunk, onEdge, onProgress? } — onProgress(0..1) reports block coverage
 * @returns {Promise<void>}
 */
function collectHexOut(client, opts) {
  const { addresses, fromBlock, toBlock, startChunk, onEdge, onProgress } =
    opts;
  const span = Math.max(1, toBlock - fromBlock);
  return getLogsChunked(client, {
    address: HEX_CONTRACT,
    topics: [TRANSFER_TOPIC, addresses.map(addressTopic)],
    fromBlock,
    toBlock,
    startChunk,
    onLogs: (logs) => emitTransferEdges(logs, onEdge),
    onProgress: onProgress
      ? (p) => onProgress(Math.min(1, Math.max(0, (p.to - fromBlock) / span)))
      : undefined,
  });
}

/**
 * Stream HEX Transfer edges IN to `addresses` (to-position topic filter).
 * @param {object} client
 * @param {object} opts { addresses, fromBlock, toBlock, startChunk, onEdge }
 * @returns {Promise<void>}
 */
function collectHexInbound(client, opts) {
  const { addresses, fromBlock, toBlock, startChunk, onEdge } = opts;
  return getLogsChunked(client, {
    address: HEX_CONTRACT,
    topics: [TRANSFER_TOPIC, null, addresses.map(addressTopic)],
    fromBlock,
    toBlock,
    startChunk,
    onLogs: (logs) => emitTransferEdges(logs, onEdge),
  });
}

/**
 * Stream native value-transfer edges OUT of `addresses` (incl. internal).
 * @param {object} client
 * @param {object} opts { addresses, fromBlock, toBlock, startChunk, onEdge }
 * @returns {Promise<void>}
 */
function collectNativeOut(client, opts) {
  const { onEdge } = opts;
  return traceOutgoing(client, {
    ...opts,
    onTransfer: (t) => onEdge(nativeEdge(t)),
  });
}

/**
 * Stream native value-transfer edges IN to `addresses` (incl. internal).
 * @param {object} client
 * @param {object} opts { addresses, fromBlock, toBlock, startChunk, onEdge }
 * @returns {Promise<void>}
 */
function collectNativeInbound(client, opts) {
  const { onEdge } = opts;
  return traceIncoming(client, {
    ...opts,
    onTransfer: (t) => onEdge(nativeEdge(t)),
  });
}

/**
 * Classify addresses as contract (true) vs EOA (false), memoized in codeCache.
 * @param {object} client
 * @param {string[]} addresses
 * @param {Map<string, boolean>} codeCache
 * @returns {Promise<Map<string, boolean>>}
 */
async function classifyAddresses(client, addresses, codeCache) {
  const result = new Map();
  for (const addr of addresses) {
    if (codeCache.has(addr)) {
      result.set(addr, codeCache.get(addr));
      continue;
    }
    const code = await client.getCode(addr);
    const isContract = Boolean(code) && code !== "0x";
    codeCache.set(addr, isContract);
    result.set(addr, isContract);
  }
  return result;
}

module.exports = {
  addressTopic,
  chunkArray,
  emitTransferEdges,
  nativeEdge,
  collectHexOut,
  collectHexInbound,
  collectNativeOut,
  collectNativeInbound,
  classifyAddresses,
};
