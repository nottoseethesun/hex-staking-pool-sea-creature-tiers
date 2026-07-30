"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { fraction, classifyFunding } = require("../src/oa/attribution");

test("fraction is oa/total, zero-guarded and capped at 1", () => {
  assert.equal(fraction(20n, 100n), 0.2);
  assert.equal(fraction(0n, 100n), 0);
  assert.equal(fraction(50n, 0n), 0);
  assert.equal(fraction(150n, 100n), 1);
});

test("classifyFunding flags OA when EITHER asset meets the threshold", () => {
  const hexOnly = classifyFunding(
    { oaHex: 25n, totalHex: 100n, oaNative: 0n, totalNative: 100n },
    0.2,
  );
  assert.equal(hexOnly.isOa, true);

  const nativeOnly = classifyFunding(
    { oaHex: 0n, totalHex: 100n, oaNative: 30n, totalNative: 100n },
    0.2,
  );
  assert.equal(nativeOnly.isOa, true);
});

test("classifyFunding rejects when both assets are below the threshold", () => {
  const r = classifyFunding(
    { oaHex: 10n, totalHex: 100n, oaNative: 5n, totalNative: 100n },
    0.2,
  );
  assert.equal(r.isOa, false);
  assert.equal(r.fracHex, 0.1);
  assert.equal(r.fracNative, 0.05);
});

test("classifyFunding treats the threshold as inclusive", () => {
  const r = classifyFunding(
    { oaHex: 20n, totalHex: 100n, oaNative: 0n, totalNative: 0n },
    0.2,
  );
  assert.equal(r.isOa, true);
});
