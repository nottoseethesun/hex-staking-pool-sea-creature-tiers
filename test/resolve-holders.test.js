/**
 * @file test/resolve-holders.test.js
 * @description Unit tests for the pure re-attribution resolver
 * (src/resolve/holders.js buildResolvedShares): native passthrough, HSI re-key to
 * owner, wrapper per-holder look-through, exact conservation of the total, and
 * per-provenance subtotals.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveHolders } = require("../src/resolve/holders");

const NONE = { hsiOwners: new Map(), wrappers: [] };

/** Sum a Map's BigInt values. */
function sum(map) {
  let s = 0n;
  for (const v of map.values()) s += v;
  return s;
}

test("native stakes pass through unchanged", () => {
  const raw = new Map([
    ["0xa", 100n],
    ["0xb", 5n],
  ]);
  const { shares, subtotals } = resolveHolders(raw, NONE);
  assert.equal(shares.get("0xa"), 100n);
  assert.equal(shares.get("0xb"), 5n);
  assert.equal(subtotals.native, 105n);
  assert.equal(subtotals.hsi, 0n);
});

test("an HSI stake is re-keyed to its owner", () => {
  const raw = new Map([["0xhsi", 50n]]);
  const res = { hsiOwners: new Map([["0xhsi", "0xowner"]]), wrappers: [] };
  const { shares, subtotals } = resolveHolders(raw, res);
  assert.equal(shares.has("0xhsi"), false);
  assert.equal(shares.get("0xowner"), 50n);
  assert.equal(subtotals.hsi, 50n);
});

test("an HSI owner merges with the owner's own native stake", () => {
  const raw = new Map([
    ["0xowner", 100n],
    ["0xhsi", 50n],
  ]);
  const res = { hsiOwners: new Map([["0xhsi", "0xowner"]]), wrappers: [] };
  const { shares, subtotals } = resolveHolders(raw, res);
  assert.equal(shares.get("0xowner"), 150n);
  assert.equal(subtotals.native, 100n);
  assert.equal(subtotals.hsi, 50n);
});

test("an HSI held by a wrapper counts as wrapped, then distributes", () => {
  const raw = new Map([["0xhsi", 1000n]]);
  const res = {
    hsiOwners: new Map([["0xhsi", "0xmaxi"]]),
    wrappers: [
      {
        address: "0xmaxi",
        label: "MAXI",
        balances: new Map([
          ["0xa", 1n],
          ["0xb", 1n],
        ]),
        supply: 2n,
      },
    ],
  };
  const { shares, subtotals } = resolveHolders(raw, res);
  assert.equal(shares.get("0xa"), 500n);
  assert.equal(shares.get("0xb"), 500n);
  assert.equal(shares.has("0xmaxi"), false);
  assert.equal(subtotals.wrapped.MAXI, 1000n);
  assert.equal(subtotals.hsi, 0n); // wrapped, not hsi
  assert.equal(subtotals.native, 0n);
});

test("wrapper T-Shares distribute to holders; a holder merges", () => {
  const raw = new Map([
    ["0xmaxi", 1000n],
    ["0xowner", 100n],
  ]);
  const res = {
    hsiOwners: new Map(),
    wrappers: [
      {
        address: "0xmaxi",
        label: "MAXI",
        balances: new Map([
          ["0xowner", 1n],
          ["0xx", 1n],
        ]),
        supply: 2n,
      },
    ],
  };
  const { shares, subtotals, labels } = resolveHolders(raw, res);
  assert.equal(shares.get("0xowner"), 600n); // 100 native + 500 wrapped
  assert.equal(shares.get("0xx"), 500n);
  assert.equal(shares.has("0xmaxi"), false); // no dust
  assert.equal(subtotals.wrapped.MAXI, 1000n);
  assert.deepEqual(labels.get("0xmaxi"), { label: "MAXI", kind: "wrapped" });
});

test("wrapper rounding dust stays under the wrapper address", () => {
  const raw = new Map([["0xmaxi", 10n]]);
  const res = {
    hsiOwners: new Map(),
    wrappers: [
      {
        address: "0xmaxi",
        label: "MAXI",
        balances: new Map([
          ["0xa", 1n],
          ["0xb", 1n],
          ["0xc", 1n],
        ]),
        supply: 3n,
      },
    ],
  };
  const { shares, subtotals } = resolveHolders(raw, res);
  assert.equal(shares.get("0xa"), 3n);
  assert.equal(shares.get("0xmaxi"), 1n); // dust
  assert.equal(subtotals.wrapped.MAXI, 10n);
  assert.equal(sum(shares), 10n);
});

test("total is conserved and subtotals sum to the raw total", () => {
  const raw = new Map([
    ["0xowner", 100n],
    ["0xhsi", 50n],
    ["0xmaxi", 999n],
    ["0xnative2", 7n],
  ]);
  const res = {
    hsiOwners: new Map([["0xhsi", "0xowner"]]),
    wrappers: [
      {
        address: "0xmaxi",
        label: "MAXI",
        balances: new Map([
          ["0xh1", 2n],
          ["0xh2", 1n],
        ]),
        supply: 3n,
      },
    ],
  };
  const { shares, subtotals } = resolveHolders(raw, res);
  const rawTotal = sum(raw);
  assert.equal(sum(shares), rawTotal);
  let wrapped = 0n;
  for (const v of Object.values(subtotals.wrapped)) wrapped += v;
  assert.equal(subtotals.native + subtotals.hsi + wrapped, rawTotal);
});
