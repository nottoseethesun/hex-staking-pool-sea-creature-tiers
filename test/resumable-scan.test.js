"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { runResumableLogScan } = require("../src/cache/resumable-scan");

/**
 * A fake getLogsChunked that walks `[fromBlock, toBlock]` in fixed windows,
 * calling onLogs with one synthetic log per window (its value = the window's
 * end block), honoring the abort signal.
 * @param {number} windowSize
 * @returns {Function}
 */
function fakeScan(windowSize) {
  return async (_client, o) => {
    for (let from = o.fromBlock; from <= o.toBlock; from += windowSize) {
      o.signal?.throwIfAborted?.();
      const to = Math.min(from + windowSize - 1, o.toBlock);
      o.onLogs([{ v: to }], { from, to });
    }
  };
}

/** Sum-accumulator plumbing shared by the tests. */
function sink() {
  const state = { sum: 0, seen: [] };
  return {
    state,
    applyLogs: (s, logs) =>
      logs.forEach((l) => {
        s.sum += l.v;
        s.seen.push(l.v);
      }),
    serialize: (s) => ({ sum: s.sum, seen: [...s.seen] }),
    restore: (s, snap) => {
      s.sum = snap.sum;
      s.seen = [...snap.seen];
    },
  };
}

test("runResumableLogScan flushes in batches and on completion", async () => {
  const { state, applyLogs, serialize, restore } = sink();
  const saves = [];
  await runResumableLogScan(
    {},
    {
      fromBlock: 1,
      toBlock: 100,
      startChunk: 10,
      state,
      applyLogs,
      serialize,
      restore,
      scan: fakeScan(10), // 10 windows: ends 10,20,…,100
      everyItems: 3, // flush every 3 windows
      everyMs: 999999,
      load: () => null,
      save: (c) => saves.push(c),
    },
  );
  // 10 windows / flush-every-3 → flushes after 3,6,9 windows + final = 4 saves.
  assert.equal(saves.length, 4);
  assert.equal(saves[0].cursor, 30);
  assert.equal(saves.at(-1).cursor, 100); // final flush at the tip
  assert.equal(state.sum, 10 + 20 + 30 + 40 + 50 + 60 + 70 + 80 + 90 + 100);
});

test("runResumableLogScan resumes from a checkpoint (no re-scan of covered blocks)", async () => {
  const { state, applyLogs, serialize, restore } = sink();
  // Pretend a prior run covered [1,50] with sum 10+20+30+40+50 = 150.
  const prior = {
    cursor: 50,
    snapshot: { sum: 150, seen: [10, 20, 30, 40, 50] },
  };
  await runResumableLogScan(
    {},
    {
      fromBlock: 1,
      toBlock: 100,
      startChunk: 10,
      state,
      applyLogs,
      serialize,
      restore,
      scan: fakeScan(10),
      everyItems: 999,
      everyMs: 999999,
      load: () => prior,
      save: () => {},
    },
  );
  // Restored 150, then scanned only 51..100 → windows end 60,70,80,90,100.
  assert.deepEqual(state.seen, [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
  assert.equal(state.sum, 550);
});

test("runResumableLogScan does nothing when the checkpoint already covers the range", async () => {
  const { state, applyLogs, serialize, restore } = sink();
  let scanned = false;
  await runResumableLogScan(
    {},
    {
      fromBlock: 1,
      toBlock: 100,
      startChunk: 10,
      state,
      applyLogs,
      serialize,
      restore,
      scan: async () => {
        scanned = true;
      },
      load: () => ({ cursor: 100, snapshot: { sum: 1, seen: [1] } }),
      save: () => {},
    },
  );
  assert.equal(scanned, false); // start (101) > toBlock (100) → skip
  assert.equal(state.sum, 1); // restored, not re-scanned
});
