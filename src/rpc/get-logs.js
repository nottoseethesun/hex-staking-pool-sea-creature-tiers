/**
 * @file src/rpc/get-logs.js
 * @description Adaptive eth_getLogs chunking. Scans a block range in windows
 * that start at `startChunk` and halve when the endpoint reports the window is
 * too large (isChunkError — which also reads the nested "exceeds server limit /
 * narrow your filter" JSON-RPC message), then grow back on success. Logs stream
 * to `onLogs` per window so the caller never holds them all in memory. Be a
 * polite client of the public endpoints.
 */

"use strict";

const { isChunkError } = require("./client");

/**
 * Stream logs over [fromBlock, toBlock] with adaptive chunking.
 * @param {object} client guarded RPC client (see rpc/client.js)
 * @param {object} opts
 * @param {string} opts.address contract address filter
 * @param {Array} opts.topics topic filter
 * @param {number} opts.fromBlock
 * @param {number} opts.toBlock
 * @param {number} opts.startChunk starting window size (blocks)
 * @param {(logs: any[], range: {from: number, to: number}) => (void|Promise<void>)} opts.onLogs
 * @param {(p: object) => void} [opts.onProgress]
 * @returns {Promise<void>}
 */
async function getLogsChunked(client, opts) {
  const { address, topics, fromBlock, toBlock, onLogs } = opts;
  const minChunk = opts.minChunk ?? 1;
  const maxChunk = opts.maxChunk ?? opts.startChunk;
  let chunk = opts.startChunk;
  let from = fromBlock;
  while (from <= toBlock) {
    const to = Math.min(from + chunk - 1, toBlock);
    let logs;
    try {
      logs = await client.getLogs({
        address,
        topics,
        fromBlock: from,
        toBlock: to,
      });
    } catch (err) {
      if (chunk > minChunk && isChunkError(err)) {
        chunk = Math.max(minChunk, Math.floor(chunk / 2));
        continue;
      }
      throw err;
    }
    await onLogs(logs, { from, to });
    from = to + 1;
    chunk = Math.min(maxChunk, chunk * 2);
    if (opts.onProgress) {
      opts.onProgress({ from, to, toBlock, count: logs.length });
    }
  }
}

module.exports = { getLogsChunked, isChunkError };
