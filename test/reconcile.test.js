"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { reconcile, sumShares } = require("../src/validate/reconcile");

test("sumShares totals the map values", () => {
  assert.equal(
    sumShares(
      new Map([
        ["a", 3n],
        ["b", 4n],
      ]),
    ),
    7n,
  );
  assert.equal(sumShares(new Map()), 0n);
});

test("reconcile passes when sum == stakeSharesTotal + nextStakeSharesTotal", () => {
  const m = new Map([
    ["a", 10n],
    ["b", 5n],
  ]);
  const r = reconcile(m, {
    stakeSharesTotal: "12",
    nextStakeSharesTotal: "3",
  });
  assert.equal(r.ok, true);
  assert.equal(r.sum, "15");
  assert.equal(r.expected, "15");
  assert.equal(r.diff, "0");
});

test("reconcile reports the signed difference on mismatch", () => {
  const m = new Map([["a", 10n]]);
  const r = reconcile(m, { stakeSharesTotal: "7", nextStakeSharesTotal: "0" });
  assert.equal(r.ok, false);
  assert.equal(r.diff, "3");
});
