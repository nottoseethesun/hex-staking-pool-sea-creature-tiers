/**
 * @file src/rpc/trace-filter.js
 * @description Streams native-coin (ETH / PLS) value transfers via Erigon
 * trace_filter — including internal transfers, the whole reason to use traces
 * over plain tx scanning. `traceOutgoing` filters by fromAddress, `traceIncoming`
 * by toAddress. Windows are chunked (halving on over-large responses) and each
 * window is paged with Erigon `after` / `count`. Only value-bearing `call`
 * traces with a recipient are emitted.
 */

"use strict";

/** Traces requested per page within a block window. */
const PAGE = 1000;

/**
 * Hex-encode a block number for JSON-RPC params.
 * @param {number} n
 * @returns {string}
 */
function toHex(n) {
  return `0x${n.toString(16)}`;
}

/**
 * Extract a native value transfer from a raw trace, or null.
 * @param {any} trace
 * @returns {{ from: string, to: string, value: bigint } | null}
 */
function nativeTransfer(trace) {
  const a = trace.action;
  if (!a || trace.type !== "call") return null;
  if (!a.to || !a.value || a.value === "0x0") return null;
  return { from: a.from, to: a.to, value: BigInt(a.value) };
}

/**
 * Page one block window with Erigon after/count, emitting native transfers.
 * @param {object} client
 * @param {object} opts { addresses, field, from, to, onTransfer }
 * @returns {Promise<void>}
 */
async function pageWindow(client, opts) {
  const { addresses, field, from, to, onTransfer, signal } = opts;
  let after = 0;
  for (;;) {
    signal?.throwIfAborted();
    const params = [
      {
        fromBlock: toHex(from),
        toBlock: toHex(to),
        [field]: addresses,
        after,
        count: PAGE,
      },
    ];
    const traces = await client.send("trace_filter", params);
    if (!traces || traces.length === 0) return;
    for (const trace of traces) {
      const t = nativeTransfer(trace);
      if (t) {
        onTransfer({
          ...t,
          block: trace.blockNumber,
          txHash: trace.transactionHash,
        });
      }
    }
    if (traces.length < PAGE) return;
    after += traces.length;
  }
}

/**
 * Stream native transfers filtered by `field` (fromAddress or toAddress).
 * @param {object} client
 * @param {object} opts { addresses, field, fromBlock, toBlock, startChunk, onTransfer }
 * @returns {Promise<void>}
 */
async function traceStream(client, opts) {
  const { addresses, field, fromBlock, toBlock, onTransfer, signal } = opts;
  const minChunk = opts.minChunk ?? 1;
  let chunk = opts.startChunk ?? toBlock - fromBlock + 1;
  let from = fromBlock;
  while (from <= toBlock) {
    signal?.throwIfAborted();
    const to = Math.min(from + chunk - 1, toBlock);
    try {
      await pageWindow(client, {
        addresses,
        field,
        from,
        to,
        onTransfer,
        signal,
      });
    } catch (err) {
      if (chunk > minChunk) {
        chunk = Math.max(minChunk, Math.floor(chunk / 2));
        continue;
      }
      throw err;
    }
    from = to + 1;
  }
}

/**
 * Stream native transfers OUT of `addresses`.
 * @param {object} client
 * @param {object} opts { addresses, fromBlock, toBlock, startChunk, onTransfer }
 * @returns {Promise<void>}
 */
function traceOutgoing(client, opts) {
  return traceStream(client, { ...opts, field: "fromAddress" });
}

/**
 * Stream native transfers IN to `addresses`.
 * @param {object} client
 * @param {object} opts { addresses, fromBlock, toBlock, startChunk, onTransfer }
 * @returns {Promise<void>}
 */
function traceIncoming(client, opts) {
  return traceStream(client, { ...opts, field: "toAddress" });
}

module.exports = {
  traceOutgoing,
  traceIncoming,
  traceStream,
  nativeTransfer,
  toHex,
};
