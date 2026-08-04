/**
 * @file src/cache/flush-gate.js
 * @description Decides WHEN a batched cache writer should flush its in-memory
 * buffer to disk: after `everyItems` accumulated units OR after `everyMs`
 * elapsed, whichever comes first. (The caller also flushes explicitly on
 * completion and on a clean shutdown.) Batching turns per-chunk cache writes
 * into per-few-minutes writes — far less disk wear and I/O jitter — while
 * bounding the crash-loss window to a single unflushed batch (seconds to a few
 * minutes, always well under an hour).
 */

"use strict";

/** Default units buffered before a flush is due. */
const DEFAULT_EVERY_ITEMS = 60;
/** Default milliseconds buffered before a flush is due. */
const DEFAULT_EVERY_MS = 180000;

/**
 * Create a flush gate. `now` is injectable for tests.
 * @param {{ everyItems?: number, everyMs?: number, now?: () => number }} [opts]
 * @returns {{ add: (n?: number) => void, due: () => boolean, reset: () => void,
 *   pending: () => number }}
 */
function createFlushGate(opts = {}) {
  const everyItems = Math.max(1, opts.everyItems ?? DEFAULT_EVERY_ITEMS);
  const everyMs = Math.max(0, opts.everyMs ?? DEFAULT_EVERY_MS);
  const now = opts.now ?? Date.now;
  let buffered = 0;
  let last = now();
  return {
    /** Record `n` newly-buffered units (default 1). */
    add(n = 1) {
      buffered += n;
    },
    /** True when a flush is warranted: something buffered AND a threshold hit. */
    due() {
      return (
        buffered > 0 && (buffered >= everyItems || now() - last >= everyMs)
      );
    },
    /** Reset the counters after a flush. */
    reset() {
      buffered = 0;
      last = now();
    },
    /** The current buffered-unit count. */
    pending() {
      return buffered;
    },
  };
}

module.exports = { createFlushGate, DEFAULT_EVERY_ITEMS, DEFAULT_EVERY_MS };
