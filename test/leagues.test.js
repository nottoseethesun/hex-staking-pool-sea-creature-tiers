"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  classify,
  qualifies,
  thresholdShares,
  LADDER,
  TABLE_TIERS,
} = require("../src/report/leagues");

const T = 10n ** 12n; // raw shares per T-Share
const POOL = 1000000n * T; // 1,000,000 T-Share non-OA pool

test("ladder has 9 tiers with 1/10^k thresholds", () => {
  assert.equal(LADDER.length, 9);
  assert.equal(LADDER[0].id, "poseidon");
  assert.equal(LADDER[0].den, 10n);
  assert.equal(LADDER[8].id, "shell");
  assert.equal(LADDER[8].den, 1000000000n);
});

test("thresholdShares = pool * num / den (floor)", () => {
  assert.equal(thresholdShares(LADDER[0], POOL), POOL / 10n);
  assert.equal(thresholdShares(LADDER[1], POOL), POOL / 100n);
});

test("classify: >=10% is Poseidon and the boundary is inclusive", () => {
  assert.equal(classify(POOL / 10n, POOL).id, "poseidon");
  assert.equal(classify(POOL / 10n - 1n, POOL).id, "whale");
});

test("classify buckets each named tier", () => {
  assert.equal(classify(POOL / 100n, POOL).id, "whale");
  assert.equal(classify(POOL / 1000n, POOL).id, "shark");
  assert.equal(classify(POOL / 10000n, POOL).id, "dolphin");
  assert.equal(classify(POOL / 1000000000n, POOL).id, "shell");
});

test("below Shell (and zero) is Plankton", () => {
  assert.equal(classify(POOL / 10000000000n, POOL).id, "plankton");
  assert.equal(classify(0n, POOL).id, "plankton");
});

test("non-positive pool degrades to Plankton", () => {
  assert.equal(classify(5n, 0n).id, "plankton");
});

test("qualifies uses exact cross-multiplication (no floats)", () => {
  assert.equal(qualifies(POOL / 10n, LADDER[0], POOL), true);
  assert.equal(qualifies(POOL / 10n - 1n, LADDER[0], POOL), false);
});

test("TABLE_TIERS is the 9 tiers plus Plankton", () => {
  assert.equal(TABLE_TIERS.length, 10);
  assert.equal(TABLE_TIERS[9].id, "plankton");
  assert.equal(TABLE_TIERS[0].emoji, "🔱");
});
