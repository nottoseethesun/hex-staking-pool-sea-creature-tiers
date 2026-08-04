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
