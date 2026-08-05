"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveCluster } = require("../src/oa/oa");

const scanCtx = () => ({
  fromBlock: 10, // the deploy block
  toBlock: 200,
  log: { info() {} },
  chainKey: "eth",
});

const priorState = () => ({
  tip: 100,
  deployBlock: 10,
  reachable: new Map([["a", { depth: 1 }]]),
  contracts: new Map(),
  inbound: { a: { hex: "1", native: "0" } },
});

test("resolveCluster extends incrementally when a prior state is resumable", async () => {
  const prev = priorState();
  const res = await resolveCluster(null, scanCtx(), prev, () => {}, {
    deltaBfs: async () => ({
      reachable: prev.reachable,
      contracts: prev.contracts,
      needsFullRebuild: false,
    }),
    bfsFromOa: async () => {
      throw new Error("should not full-rebuild");
    },
  });
  assert.equal(res.reachable, prev.reachable);
  assert.equal(res.prior.tip, 100); // extends the prior inbound cache
});

test("resolveCluster falls back to a full BFS when the delta needs a rebuild", async () => {
  const fullReachable = new Map([["x", { depth: 1 }]]);
  const res = await resolveCluster(null, scanCtx(), priorState(), () => {}, {
    deltaBfs: async () => ({
      reachable: new Map(),
      contracts: new Map(),
      needsFullRebuild: true,
    }),
    bfsFromOa: async () => ({ reachable: fullReachable, contracts: new Map() }),
  });
  assert.equal(res.reachable, fullReachable);
  assert.equal(res.prior, null); // a full build carries no prior
});

test("resolveCluster does a full BFS when there is no prior state", async () => {
  const fullReachable = new Map();
  const res = await resolveCluster(null, scanCtx(), null, () => {}, {
    deltaBfs: async () => {
      throw new Error("no delta without a prior");
    },
    bfsFromOa: async () => ({ reachable: fullReachable, contracts: new Map() }),
  });
  assert.equal(res.reachable, fullReachable);
  assert.equal(res.prior, null);
});

test("resolveCluster does a full BFS when the deploy block changed", async () => {
  const ctx = { ...scanCtx(), fromBlock: 999 }; // != prior.deployBlock
  const res = await resolveCluster(null, ctx, priorState(), () => {}, {
    deltaBfs: async () => {
      throw new Error("a changed deploy block must not delta");
    },
    bfsFromOa: async () => ({
      reachable: new Map([["z", { depth: 1 }]]),
      contracts: new Map(),
    }),
  });
  assert.equal(res.prior, null);
});
