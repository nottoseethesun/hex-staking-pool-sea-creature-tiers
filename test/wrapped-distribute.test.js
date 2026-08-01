/**
 * @file test/wrapped-distribute.test.js
 * @description Unit tests for the pure wrapper look-through share-out
 * (src/resolve/wrapped.js distribute): exact BigInt floor division with the
 * remainder returned as dust so the total is conserved.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { distribute, foldTransfers, ZERO } = require("../src/resolve/wrapped");

test("distribute: exact division, no dust", () => {
  const balances = new Map([
    ["a", 1n],
    ["b", 1n],
    ["c", 2n],
  ]);
  const { perHolder, dust } = distribute(1000n, balances, 4n);
  assert.equal(perHolder.get("a"), 250n);
  assert.equal(perHolder.get("b"), 250n);
  assert.equal(perHolder.get("c"), 500n);
  assert.equal(dust, 0n);
});

test("distribute: floor leaves dust; sum + dust == total", () => {
  const balances = new Map([
    ["a", 1n],
    ["b", 1n],
    ["c", 1n],
  ]);
  const total = 10n;
  const { perHolder, dust } = distribute(total, balances, 3n);
  for (const v of perHolder.values()) assert.equal(v, 3n);
  assert.equal(dust, 1n);
  let sum = dust;
  for (const v of perHolder.values()) sum += v;
  assert.equal(sum, total);
});

test("distribute: skips non-positive balances", () => {
  const balances = new Map([
    ["a", 0n],
    ["b", 5n],
  ]);
  const { perHolder, dust } = distribute(100n, balances, 5n);
  assert.equal(perHolder.has("a"), false);
  assert.equal(perHolder.get("b"), 100n);
  assert.equal(dust, 0n);
});

test("distribute: zero total or supply yields all dust / empty", () => {
  const balances = new Map([["a", 1n]]);
  const zero = distribute(0n, balances, 1n);
  assert.equal(zero.perHolder.size, 0);
  assert.equal(zero.dust, 0n);
  const noSupply = distribute(10n, balances, 0n);
  assert.equal(noSupply.perHolder.size, 0);
  assert.equal(noSupply.dust, 10n);
});

test("foldTransfers: mints, transfers, burn yield balances + supply", () => {
  const transfers = [
    { from: ZERO, to: "0xa", value: 100n }, // mint 100 -> a
    { from: ZERO, to: "0xb", value: 50n }, // mint 50 -> b
    { from: "0xa", to: "0xb", value: 30n }, // a -> b 30
    { from: "0xb", to: ZERO, value: 20n }, // burn 20 from b
  ];
  const { balances, supply } = foldTransfers(transfers);
  assert.equal(balances.get("0xa"), 70n);
  assert.equal(balances.get("0xb"), 60n);
  assert.equal(supply, 130n); // 150 minted - 20 burned
});

test("foldTransfers: drops holders that net to zero", () => {
  const transfers = [
    { from: ZERO, to: "0xa", value: 100n },
    { from: "0xa", to: "0xb", value: 100n },
  ];
  const { balances, supply } = foldTransfers(transfers);
  assert.equal(balances.has("0xa"), false);
  assert.equal(balances.get("0xb"), 100n);
  assert.equal(supply, 100n);
});
