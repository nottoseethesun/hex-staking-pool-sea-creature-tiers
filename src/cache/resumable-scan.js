/**
 * @file src/cache/resumable-scan.js
 * @description Run a `getLogsChunked` scan that accumulates in-memory state,
 * checkpointing `{ cursor, snapshot }` to disk in batches (via the flush gate)
 * and on a clean abort — so an interrupted scan resumes from the last flushed
 * block instead of re-scanning from the start. The snapshot bundles the cursor
 * with the state built up to it and is written atomically (one `writeJson`
 * tmp+rename), so a crash leaves either the previous complete checkpoint or the
 * next one, never a torn mix. Flushing every few minutes keeps the disk cost
 * tiny relative to the work it protects.
 *
 * Used by Resolve (HSIM ownership + wrapper balances) and reusable for OA's
 * getLogs sub-scans.
 */

"use strict";

const { getLogsChunked } = require("../rpc/get-logs");
const { createFlushGate } = require("./flush-gate");
const tuning = require("../../config/tuning.json");

/**
 * Accumulate a filtered log stream into `opts.state`, resuming from and
 * checkpointing to `opts.load` / `opts.save`. `state` is mutated in place; the
 * caller finalizes it after this resolves.
 * @param {object} client guarded RPC client
 * @param {object} opts {
 *   address, topics, fromBlock, toBlock, startChunk, signal?, onProgress?,
 *   state,                       // mutable accumulator
 *   applyLogs,                   // (state, logs) => void
 *   serialize,                   // (state) => JSON-safe snapshot
 *   restore,                     // (state, snapshot) => void  (rehydrate)
 *   load,                        // () => { cursor, snapshot } | null  (null if none/stale)
 *   save,                        // ({ cursor, snapshot }) => void  (atomic)
 *   scan?,                       // getLogsChunked (injectable for tests)
 *   everyItems?, everyMs?,       // flush thresholds (default: tuning.json)
 * }
 * @returns {Promise<void>}
 */
async function runResumableLogScan(client, opts) {
  const { fromBlock, toBlock } = opts;
  const scan = opts.scan ?? getLogsChunked;
  const resumed = opts.load();
  let start = fromBlock;
  if (
    resumed &&
    Number.isInteger(resumed.cursor) &&
    resumed.cursor >= fromBlock
  ) {
    opts.restore(opts.state, resumed.snapshot);
    start = resumed.cursor + 1;
  }
  if (start > toBlock) return; // already covered by the checkpoint
  const gate = createFlushGate({
    everyItems: opts.everyItems ?? tuning.flushEveryChunks,
    everyMs: opts.everyMs ?? tuning.flushEveryMs,
  });
  let cursor = start - 1;
  const flush = () => {
    if (cursor >= start) {
      opts.save({ cursor, snapshot: opts.serialize(opts.state) });
    }
    gate.reset();
  };
  try {
    await scan(client, {
      address: opts.address,
      topics: opts.topics,
      fromBlock: start,
      toBlock,
      startChunk: opts.startChunk,
      signal: opts.signal,
      onLogs: (logs, range) => {
        opts.applyLogs(opts.state, logs);
        cursor = range.to;
        gate.add(1);
        if (gate.due()) flush();
      },
      onProgress: opts.onProgress,
    });
  } finally {
    // Persist the final (or in-flight) batch on completion OR a clean abort.
    flush();
  }
}

module.exports = { runResumableLogScan };
