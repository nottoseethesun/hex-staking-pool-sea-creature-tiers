"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  newState,
  applyEvent,
  serializeState,
  restoreState,
  finalizeOwners,
} = require("../src/resolve/ownership");
const {
  serializeBalances,
  restoreBalances,
} = require("../src/resolve/wrapped");

test("ownership serialize/restore round-trips the replay state (JSON-safe)", () => {
  const s = newState();
  applyEvent(s, { name: "HSIStart", hsi: "0xh1", staker: "0xa" });
  applyEvent(s, {
    name: "HSITokenize",
    tokenId: "7",
    hsi: "0xh2",
    staker: "0xb",
  });
  applyEvent(s, { name: "HSIEnd", hsi: "0xh3" });
  const snap = serializeState(s);
  assert.deepEqual(JSON.parse(JSON.stringify(snap)), snap); // survives a JSON round-trip
  const s2 = newState();
  restoreState(s2, snap);
  assert.deepEqual([...s2.owner], [...s.owner]);
  assert.deepEqual([...s2.tokenIdToHsi], [...s.tokenIdToHsi]);
  assert.deepEqual([...s2.ended], [...s.ended]);
  assert.deepEqual([...finalizeOwners(s2)], [...finalizeOwners(s)]);
});

test("wrapper balances serialize/restore round-trips (BigInt-safe)", () => {
  const st = {
    balances: new Map([
      ["0xa", 100n],
      ["0xb", 7n],
    ]),
  };
  const snap = serializeBalances(st);
  assert.deepEqual(JSON.parse(JSON.stringify(snap)), snap); // strings -> JSON-safe
  const st2 = { balances: new Map() };
  restoreBalances(st2, snap);
  assert.equal(st2.balances.get("0xa"), 100n);
  assert.equal(st2.balances.get("0xb"), 7n);
  assert.equal(st2.balances.size, 2);
});
