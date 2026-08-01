/**
 * @file test/resolution.test.js
 * @description Unit tests for the pure resolution-cache parser
 * (src/resolve/resolution.js parseResolution): identity on null, and JSON ->
 * Maps/BigInts conversion for HSI owners and wrapper balances.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { parseResolution } = require("../src/resolve/resolution");

test("parseResolution: null yields the identity resolution", () => {
  const r = parseResolution(null);
  assert.equal(r.hsiOwners.size, 0);
  assert.equal(r.wrappers.length, 0);
});

test("parseResolution: converts JSON to Maps and BigInts", () => {
  const r = parseResolution({
    hsiOwners: { "0xhsi": "0xowner" },
    wrappers: [
      {
        address: "0xmaxi",
        label: "MAXI",
        supply: "3",
        balances: { "0xa": "2", "0xb": "1" },
      },
    ],
  });
  assert.equal(r.hsiOwners.get("0xhsi"), "0xowner");
  assert.equal(r.wrappers.length, 1);
  assert.equal(r.wrappers[0].label, "MAXI");
  assert.equal(r.wrappers[0].supply, 3n);
  assert.equal(r.wrappers[0].balances.get("0xa"), 2n);
  assert.equal(r.wrappers[0].balances.get("0xb"), 1n);
});
