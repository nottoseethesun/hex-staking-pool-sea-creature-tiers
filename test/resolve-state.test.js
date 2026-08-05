"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const { chainDir } = require("../src/cache/store");
const {
  saveResolveState,
  loadResolveState,
} = require("../src/resolve/resolve-state");

test("saveResolveState/loadResolveState round-trips the replay snapshots", () => {
  const k = "resstate-test";
  try {
    saveResolveState(k, {
      tip: 100,
      ownership: { owner: [["0xh", "0xo"]], tokenIdToHsi: [], ended: [] },
      wrappers: { "0xt": { balances: [["0xa", "5"]] } },
    });
    const s = loadResolveState(k);
    assert.equal(s.tip, 100);
    assert.deepEqual(s.ownership.owner, [["0xh", "0xo"]]);
    assert.deepEqual(s.wrappers["0xt"], { balances: [["0xa", "5"]] });
  } finally {
    fs.rmSync(chainDir(k), { recursive: true, force: true });
  }
});

test("loadResolveState returns null when there is no state file", () => {
  const k = "resstate-missing";
  fs.rmSync(chainDir(k), { recursive: true, force: true });
  assert.equal(loadResolveState(k), null);
});
