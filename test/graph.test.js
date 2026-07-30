"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  bfsFromOa,
  accumulateEdge,
  mergeReachable,
  processRecipient,
} = require("../src/oa/graph");
const { addressTopic } = require("../src/oa/funding-graph");
const { iface } = require("../src/decode/stake-events");

const noopLog = { info() {} };

test("accumulateEdge sums per asset, skips self-edges, caps evidence at 3", () => {
  const r = new Map();
  const e = (asset, value, tx) => ({
    from: "a",
    to: "b",
    asset,
    value,
    txHash: tx,
    block: 1,
  });
  accumulateEdge(r, e("hex", 10n, "0x1"));
  accumulateEdge(r, e("hex", 5n, "0x2"));
  accumulateEdge(r, e("native", 3n, "0x3"));
  accumulateEdge(r, e("native", 1n, "0x4"));
  const b = r.get("b");
  assert.equal(b.hex, 15n);
  assert.equal(b.native, 4n);
  assert.equal(b.ev.length, 3);
  assert.equal(b.via, "a");
  accumulateEdge(r, { from: "z", to: "z", asset: "hex", value: 9n, block: 1 });
  assert.equal(r.has("z"), false);
});

test("mergeReachable accumulates inflow and keeps the first-seen depth", () => {
  const reach = new Map();
  mergeReachable(reach, "b", { hex: 5n, native: 1n, via: "a", ev: [] }, 1);
  mergeReachable(reach, "b", { hex: 2n, native: 0n, via: "c", ev: [] }, 2);
  const node = reach.get("b");
  assert.equal(node.oaHex, 7n);
  assert.equal(node.oaNative, 1n);
  assert.equal(node.depth, 1);
});

test("processRecipient records contracts terminally (no merge, no propagate)", () => {
  const state = {
    reachable: new Map(),
    contracts: new Map(),
    codes: new Map([["0xc", true]]),
    depth: 1,
    maxHops: 3,
    next: [],
  };
  processRecipient("0xc", { hex: 5n, native: 0n, via: "x", ev: [] }, state);
  assert.equal(state.contracts.has("0xc"), true);
  assert.equal(state.reachable.has("0xc"), false);
  assert.equal(state.next.length, 0);
});

test("processRecipient propagates a fresh EOA only below maxHops", () => {
  const below = {
    reachable: new Map(),
    contracts: new Map(),
    codes: new Map([["0xe", false]]),
    depth: 1,
    maxHops: 3,
    next: [],
  };
  processRecipient("0xe", { hex: 5n, native: 2n, via: "x", ev: [] }, below);
  assert.equal(below.reachable.get("0xe").oaHex, 5n);
  assert.deepEqual(below.next, ["0xe"]);

  const atMax = {
    reachable: new Map(),
    contracts: new Map(),
    codes: new Map([["0xe", false]]),
    depth: 3,
    maxHops: 3,
    next: [],
  };
  processRecipient("0xe", { hex: 5n, native: 0n, via: "x", ev: [] }, atMax);
  assert.equal(atMax.reachable.has("0xe"), true);
  assert.equal(atMax.next.length, 0);
});

// --- End-to-end BFS with a mock client (contract-terminal + 3 hops) ---

function transferLog(from, to, value, block, txHash) {
  const enc = iface.encodeEventLog("Transfer", [from, to, value]);
  return {
    topics: enc.topics,
    data: enc.data,
    blockNumber: block,
    transactionHash: txHash,
  };
}

function mockClient(edges, codeMap) {
  return {
    getLogs: async ({ topics, fromBlock, toBlock }) => {
      const fromTopics = topics[1];
      return edges
        .filter(
          (e) =>
            fromTopics.includes(addressTopic(e.from)) &&
            e.block >= fromBlock &&
            e.block <= toBlock,
        )
        .map((e) => transferLog(e.from, e.to, e.value, e.block, e.txHash));
    },
    send: async () => [],
    getCode: async (addr) => (codeMap[addr] ? "0x60" : "0x"),
  };
}

const OA = `0x${"9".repeat(40)}`;
const A = `0x${"a".repeat(40)}`;
const B = `0x${"b".repeat(40)}`;
const C = `0x${"c".repeat(40)}`;
const K = `0x${"d".repeat(40)}`; // contract

const EDGES = [
  { from: OA, to: A, value: 100n, block: 1, txHash: "0x1" },
  { from: OA, to: K, value: 50n, block: 2, txHash: "0x2" },
  { from: A, to: B, value: 40n, block: 3, txHash: "0x3" },
  { from: B, to: C, value: 10n, block: 4, txHash: "0x4" },
  { from: K, to: C, value: 999n, block: 5, txHash: "0x5" },
];

function ctx(maxHops) {
  return {
    oa: OA,
    fromBlock: 0,
    toBlock: 100,
    startChunk: 100,
    nativeChunk: 100,
    maxHops,
    codeCache: new Map(),
    log: noopLog,
    chainKey: "test",
  };
}

test("bfsFromOa reaches EOAs up to 3 hops; contracts are terminal", async () => {
  const client = mockClient(EDGES, { [K]: true });
  const { reachable, contracts } = await bfsFromOa(client, ctx(3));
  assert.equal(reachable.has(A.toLowerCase()), true);
  assert.equal(reachable.has(B.toLowerCase()), true);
  assert.equal(reachable.has(C.toLowerCase()), true);
  assert.equal(contracts.has(K.toLowerCase()), true);
  assert.equal(reachable.has(K.toLowerCase()), false);
  // C is only funded via B (K is terminal, its K->C edge is never scanned).
  assert.equal(reachable.get(C.toLowerCase()).oaHex, 10n);
  assert.equal(reachable.get(C.toLowerCase()).depth, 3);
});

test("bfsFromOa respects the hop cap", async () => {
  const client = mockClient(EDGES, { [K]: true });
  const { reachable } = await bfsFromOa(client, ctx(2));
  assert.equal(reachable.has(B.toLowerCase()), true);
  assert.equal(reachable.has(C.toLowerCase()), false);
});
