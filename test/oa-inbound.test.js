"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { computeInbound } = require("../src/oa/oa");

/** Fake native inbound collector: emits `val` to each address in the batch. */
const fakeNative = (val) => async (_c, o) =>
  o.addresses.forEach((a) => o.onEdge({ to: a, asset: "native", value: val }));

test("computeInbound sums HEX + native per candidate across batches", async () => {
  const scanned = [];
  const totals = await computeInbound({}, ["a", "b", "c"], {
    fromBlock: 1,
    toBlock: 50,
    startChunk: 5,
    batchSize: 2, // -> batches [a,b], [c]
    collectHex: async (_c, o) => {
      scanned.push(o.addresses.join(","));
      o.addresses.forEach((a) => o.onEdge({ to: a, asset: "hex", value: 5n }));
    },
    collectNative: fakeNative(2n),
    load: () => null,
    save: () => {},
  });
  assert.deepEqual(scanned, ["a,b", "c"]); // both batches scanned
  assert.equal(totals.size, 3);
  assert.equal(totals.get("a").totalHex, 5n);
  assert.equal(totals.get("a").totalNative, 2n);
  assert.equal(totals.get("c").totalHex, 5n);
});

test("computeInbound resumes from a checkpoint and skips done batches", async () => {
  const scanned = [];
  const saved = [];
  const prev = {
    tip: 100,
    candidateCount: 4,
    batchCount: 2,
    doneBatches: 1, // batch 0 ([a,b]) already done
    totals: {
      a: { hex: "10", native: "3" },
      b: { hex: "10", native: "3" },
      c: { hex: "0", native: "0" },
      d: { hex: "0", native: "0" },
    },
  };
  const totals = await computeInbound({}, ["a", "b", "c", "d"], {
    fromBlock: 1,
    toBlock: 100,
    startChunk: 5,
    batchSize: 2,
    collectHex: async (_c, o) => {
      scanned.push(o.addresses.join(","));
      o.addresses.forEach((a) => o.onEdge({ to: a, asset: "hex", value: 7n }));
    },
    collectNative: fakeNative(1n),
    load: () => prev,
    save: (o) => saved.push(o),
  });
  assert.deepEqual(scanned, ["c,d"]); // ONLY the unfinished batch re-scanned
  assert.equal(totals.get("a").totalHex, 10n); // carried from the checkpoint
  assert.equal(totals.get("a").totalNative, 3n);
  assert.equal(totals.get("c").totalHex, 7n); // freshly scanned
  assert.equal(totals.get("c").totalNative, 1n);
  assert.equal(saved.at(-1).doneBatches, 2); // final checkpoint marks all done
});

test("computeInbound ignores a checkpoint for a different tip / candidate set", async () => {
  const scanned = [];
  const stale = {
    tip: 999, // different tip
    candidateCount: 2,
    batchCount: 1,
    doneBatches: 1,
    totals: { a: { hex: "999", native: "0" }, b: { hex: "0", native: "0" } },
  };
  const totals = await computeInbound({}, ["a", "b"], {
    fromBlock: 1,
    toBlock: 100,
    startChunk: 5,
    batchSize: 2,
    collectHex: async (_c, o) => {
      scanned.push(o.addresses.join(","));
      o.addresses.forEach((a) => o.onEdge({ to: a, asset: "hex", value: 4n }));
    },
    collectNative: fakeNative(0n),
    load: () => stale,
    save: () => {},
  });
  assert.deepEqual(scanned, ["a,b"]); // full fresh scan (stale checkpoint ignored)
  assert.equal(totals.get("a").totalHex, 4n); // NOT the stale 999
});

test("computeInbound records accumulated inbound-sweep elapsed time", async () => {
  const saved = [];
  let t = 1000;
  await computeInbound({}, ["a", "b", "c"], {
    fromBlock: 1,
    toBlock: 50,
    startChunk: 5,
    batchSize: 2, // -> batches [a,b], [c]
    now: () => t,
    collectHex: async () => {
      t += 5; // 5ms of "work" per HEX collect (one per batch)
    },
    collectNative: async () => {},
    load: () => null,
    save: (o) => saved.push(o),
  });
  assert.equal(saved.at(-1).elapsedMs, 10); // 2 batches x 5ms, from a zero base
});

test("computeInbound carries elapsed forward across a resume", async () => {
  const saved = [];
  let t = 500;
  const prev = {
    tip: 50,
    candidateCount: 3,
    batchCount: 2,
    doneBatches: 1, // batch 0 already done last session
    elapsedMs: 7, // ...which took 7ms
    totals: {
      a: { hex: "0", native: "0" },
      b: { hex: "0", native: "0" },
      c: { hex: "0", native: "0" },
    },
  };
  await computeInbound({}, ["a", "b", "c"], {
    fromBlock: 1,
    toBlock: 50,
    startChunk: 5,
    batchSize: 2,
    now: () => t,
    collectHex: async () => {
      t += 3; // the one remaining batch takes 3ms
    },
    collectNative: async () => {},
    load: () => prev,
    save: (o) => saved.push(o),
  });
  assert.equal(saved.at(-1).elapsedMs, 10); // 7ms carried + 3ms this session
});

test("computeInbound extends carried candidates over the new range, scans fresh ones fully", async () => {
  const seen = [];
  const totals = await computeInbound({}, ["a", "b", "c"], {
    fromBlock: 1,
    toBlock: 200,
    startChunk: 5,
    batchSize: 1, // one candidate per batch, so each batch's range is readable
    prior: {
      tip: 100,
      totals: { a: { hex: "10", native: "1" }, b: { hex: "20", native: "2" } },
    },
    collectHex: async (_c, o) => {
      seen.push({ addr: o.addresses[0], from: o.fromBlock });
      o.addresses.forEach((x) => o.onEdge({ to: x, asset: "hex", value: 5n }));
    },
    collectNative: async (_c, o) =>
      o.addresses.forEach((x) =>
        o.onEdge({ to: x, asset: "native", value: 0n }),
      ),
    load: () => null,
    save: () => {},
  });
  const from = Object.fromEntries(seen.map((s) => [s.addr, s.from]));
  assert.equal(from.a, 101); // carried -> rescanned from prior.tip + 1
  assert.equal(from.b, 101);
  assert.equal(from.c, 1); // fresh candidate -> full range from the deploy block
  assert.equal(totals.get("a").totalHex, 15n); // seeded 10 + new-range 5
  assert.equal(totals.get("b").totalHex, 25n); // seeded 20 + new-range 5
  assert.equal(totals.get("c").totalHex, 5n); // fresh 0 + 5
});

test("computeInbound shards batches across a client pool and sums correctly", async () => {
  const used = new Set();
  const totals = await computeInbound(null, ["a", "b", "c", "d"], {
    clients: [{ id: "A" }, { id: "B" }],
    fromBlock: 1,
    toBlock: 50,
    startChunk: 5,
    batchSize: 1, // 4 single-address batches, 2 workers
    collectHex: async (c, o) => {
      used.add(c.id);
      o.addresses.forEach((a) => o.onEdge({ to: a, asset: "hex", value: 3n }));
    },
    collectNative: async (_c, o) =>
      o.addresses.forEach((a) =>
        o.onEdge({ to: a, asset: "native", value: 1n }),
      ),
    load: () => null,
    save: () => {},
  });
  assert.equal(used.size, 2); // both endpoints were used
  for (const k of ["a", "b", "c", "d"]) {
    assert.equal(totals.get(k).totalHex, 3n);
    assert.equal(totals.get(k).totalNative, 1n);
  }
});

test("computeInbound checkpoints only the contiguous prefix under out-of-order completion", async () => {
  const saved = [];
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  let firstGrab = true;
  const totals = await computeInbound(null, ["a", "b", "c", "d"], {
    clients: [{ id: "slow" }, { id: "fast" }],
    fromBlock: 1,
    toBlock: 50,
    startChunk: 5,
    batchSize: 1,
    everyItems: 1, // save on every contiguous merge so the sequence is visible
    everyMs: 999999,
    collectHex: async (_c, o) => {
      const slow = firstGrab; // the worker that grabs batch 0 finishes LAST
      firstGrab = false;
      await delay(slow ? 30 : 1);
      o.addresses.forEach((a) => o.onEdge({ to: a, asset: "hex", value: 2n }));
    },
    collectNative: async () => {},
    load: () => null,
    save: (o) => saved.push(o.doneBatches),
  });
  // The checkpoint never skips ahead of an unfinished earlier batch.
  for (let i = 1; i < saved.length; i += 1) {
    assert.ok(saved[i] >= saved[i - 1]);
  }
  assert.equal(saved.at(-1), 4); // all four eventually merged
  assert.equal(totals.get("a").totalHex, 2n);
});
