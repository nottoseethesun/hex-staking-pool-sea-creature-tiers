/**
 * @file test/resolve-stage.test.js
 * @description Unit test for the pure part of the resolve stage
 * (src/resolve/resolve.js activeHsiOwners): only HSIs that are currently active
 * stakers (present in the ledger) are kept in the cached owner map.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { activeHsiOwners } = require("../src/resolve/resolve");

test("activeHsiOwners keeps only HSIs that are active stakers", () => {
  const owners = new Map([
    ["0xh1", "0xa"],
    ["0xh2", "0xb"],
    ["0xh3", "0xc"],
  ]);
  const rawShares = new Map([
    ["0xh1", 10n],
    ["0xh3", 5n],
    ["0xnative", 1n],
  ]);
  const out = activeHsiOwners(owners, rawShares);
  assert.deepEqual(out, { "0xh1": "0xa", "0xh3": "0xc" });
});
