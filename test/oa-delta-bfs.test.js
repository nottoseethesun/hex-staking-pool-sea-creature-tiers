"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { deltaBfs, accumulateEdge } = require("../src/oa/graph");

/** A reachable-node record. */
function node(depth, oaHex = 0n, oaNative = 0n) {
  return { depth, via: null, oaHex, oaNative, evidence: [] };
}

/**
 * Fake edge collector over a static edge list: emits every edge whose sender is
 * in the frontier and whose block falls within the requested range.
 */
function fakeCollect(edges) {
  return async (_client, frontier, ctx) => {
    const inFrontier = new Set(frontier);
    for (const e of edges) {
      if (
        inFrontier.has(e.from) &&
        e.block >= ctx.fromBlock &&
        e.block <= ctx.toBlock
      ) {
        accumulateEdge(ctx.into, {
          from: e.from,
          to: e.to,
          asset: e.asset ?? "hex",
          value: e.value,
          block: e.block,
          txHash: e.tx ?? `0x${e.block}`,
        });
      }
    }
  };
}

/** Fake contract classifier: addresses in `contracts` are contracts. */
function fakeClassify(contracts = new Set()) {
  return async (_client, addrs, cache) => {
    const m = new Map();
    for (const a of addrs) {
      const isContract = contracts.has(a);
      cache.set(a, isContract);
      m.set(a, isContract);
    }
    return m;
  };
}

function ctx(reachable, contracts, overrides) {
  return {
    oa: "oa",
    deployBlock: 1,
    prevTip: 100,
    toBlock: 200,
    maxHops: 3,
    codeCache: new Map(),
    reachable,
    contracts,
    classify: fakeClassify(),
    ...overrides,
  };
}

test("deltaBfs with no new-range edges leaves the cluster unchanged", async () => {
  const reachable = new Map([
    ["oa", node(0)],
    ["a", node(1, 100n)],
  ]);
  const res = await deltaBfs(
    null,
    ctx(reachable, new Map(), {
      collect: fakeCollect([{ from: "oa", to: "a", value: 100n, block: 50 }]),
    }),
  );
  assert.equal(res.needsFullRebuild, false);
  assert.equal(reachable.get("a").oaHex, 100n); // untouched (old edge)
  assert.equal(reachable.size, 2);
});

test("deltaBfs adds a new-range edge to an existing node's numerator", async () => {
  const reachable = new Map([
    ["oa", node(0)],
    ["a", node(1, 100n)],
  ]);
  const res = await deltaBfs(
    null,
    ctx(reachable, new Map(), {
      collect: fakeCollect([{ from: "oa", to: "a", value: 50n, block: 150 }]),
    }),
  );
  assert.equal(res.needsFullRebuild, false);
  assert.equal(reachable.get("a").oaHex, 150n); // 100 + the new 50
});

test("deltaBfs explores a newly-joined node's full history for descendants", async () => {
  const reachable = new Map([["oa", node(0)]]);
  const res = await deltaBfs(
    null,
    ctx(reachable, new Map(), {
      collect: fakeCollect([
        { from: "oa", to: "b", value: 100n, block: 150 }, // new: OA funds B
        { from: "b", to: "c", value: 30n, block: 50 }, // OLD: B had funded C
      ]),
    }),
  );
  assert.equal(res.needsFullRebuild, false);
  assert.equal(reachable.get("b").depth, 1);
  assert.equal(reachable.get("b").oaHex, 100n);
  assert.ok(reachable.has("c")); // found via B's pre-existing (old) edge
  assert.equal(reachable.get("c").depth, 2);
  assert.equal(reachable.get("c").oaHex, 30n);
});

test("deltaBfs promotes a former leaf and scans its full range", async () => {
  const reachable = new Map([
    ["oa", node(0)],
    ["a", node(1)],
    ["l", node(2, 10n)], // leaf at depth 2 (== maxHops here), unexplored
  ]);
  const res = await deltaBfs(
    null,
    ctx(reachable, new Map(), {
      maxHops: 2,
      collect: fakeCollect([
        { from: "oa", to: "l", value: 200n, block: 150 }, // new: OA funds L -> depth 1
        { from: "l", to: "m", value: 40n, block: 50 }, // OLD: L funded M
      ]),
    }),
  );
  assert.equal(res.needsFullRebuild, false);
  assert.equal(reachable.get("l").depth, 1); // promoted 2 -> 1
  assert.equal(reachable.get("l").oaHex, 210n); // 10 + 200
  assert.ok(reachable.has("m")); // discovered via L's now-scanned full range
  assert.equal(reachable.get("m").depth, 2);
});

test("deltaBfs falls back to full rebuild when an explored node's depth shortens", async () => {
  const reachable = new Map([
    ["oa", node(0)],
    ["a", node(1)],
    ["b", node(2, 5n)], // already explored (2 < maxHops 3)
  ]);
  const res = await deltaBfs(
    null,
    ctx(reachable, new Map(), {
      collect: fakeCollect([
        { from: "oa", to: "b", value: 100n, block: 150 }, // new: OA -> B shortens 2 to 1
      ]),
    }),
  );
  assert.equal(res.needsFullRebuild, true);
});

test("deltaBfs records a contract recipient as terminal, not reachable", async () => {
  const reachable = new Map([["oa", node(0)]]);
  const contracts = new Map();
  const res = await deltaBfs(
    null,
    ctx(reachable, contracts, {
      collect: fakeCollect([
        { from: "oa", to: "k", value: 100n, block: 150, tx: "0xk" },
      ]),
      classify: fakeClassify(new Set(["k"])),
    }),
  );
  assert.equal(res.needsFullRebuild, false);
  assert.ok(contracts.has("k"));
  assert.equal(reachable.has("k"), false);
});
