"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const { chainDir } = require("../src/cache/store");
const {
  serializeReachable,
  deserializeReachable,
  serializeInbound,
  saveOaState,
  loadOaState,
} = require("../src/oa/oa-state");

test("serializeReachable/deserializeReachable round-trips BigInt totals (JSON-safe)", () => {
  const reachable = new Map([
    ["0xoa", { depth: 0, via: null, oaHex: 0n, oaNative: 0n, evidence: [] }],
    [
      "0xa",
      {
        depth: 1,
        via: "0xoa",
        oaHex: 123n,
        oaNative: 45n,
        evidence: [{ kind: "hex", txHash: "0x1", block: 9, amount: "123" }],
      },
    ],
  ]);
  const snap = serializeReachable(reachable);
  assert.deepEqual(JSON.parse(JSON.stringify(snap)), snap); // survives JSON
  const back = deserializeReachable(snap);
  assert.equal(back.get("0xa").oaHex, 123n);
  assert.equal(back.get("0xa").oaNative, 45n);
  assert.equal(back.get("0xa").depth, 1);
  assert.equal(back.get("0xa").via, "0xoa");
  assert.equal(back.get("0xa").evidence[0].txHash, "0x1");
});

test("serializeInbound emits the { hex, native } shape prior.totals expects", () => {
  const totals = new Map([
    ["0xa", { totalHex: 100n, totalNative: 7n }],
    ["0xb", { totalHex: 0n, totalNative: 0n }],
  ]);
  assert.deepEqual(serializeInbound(totals), {
    "0xa": { hex: "100", native: "7" },
    "0xb": { hex: "0", native: "0" },
  });
});

test("deserializeReachable tolerates an absent/empty map", () => {
  assert.equal(deserializeReachable(null).size, 0);
  assert.equal(deserializeReachable({}).size, 0);
});

test("saveOaState/loadOaState round-trips through disk (throwaway chain)", () => {
  const k = "oastate-test";
  try {
    saveOaState(k, {
      tip: 200,
      deployBlock: 10,
      reachable: new Map([
        [
          "0xa",
          { depth: 1, via: "0xoa", oaHex: 5n, oaNative: 0n, evidence: [] },
        ],
      ]),
      contracts: new Map([["0xc", "0xtx"]]),
      inbound: new Map([["0xa", { totalHex: 50n, totalNative: 0n }]]),
    });
    const s = loadOaState(k);
    assert.equal(s.tip, 200);
    assert.equal(s.deployBlock, 10);
    assert.equal(s.reachable.get("0xa").oaHex, 5n);
    assert.equal(s.contracts.get("0xc"), "0xtx");
    assert.deepEqual(s.inbound["0xa"], { hex: "50", native: "0" });
  } finally {
    fs.rmSync(chainDir(k), { recursive: true, force: true });
  }
});

test("loadOaState returns null when there is no state file", () => {
  const k = "oastate-missing";
  fs.rmSync(chainDir(k), { recursive: true, force: true });
  assert.equal(loadOaState(k), null);
});
