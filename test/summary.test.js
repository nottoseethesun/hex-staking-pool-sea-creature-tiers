"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildView,
  buildSummary,
  combineShares,
} = require("../src/report/summary");

const T = 10n ** 12n;

test("buildView splits OA vs non-OA and ranks descending", () => {
  const shares = new Map([
    ["0xaa", 100n * T],
    ["0xbb", 50n * T],
    ["0xoa", 30n * T],
  ]);
  const v = buildView(shares, new Set(["0xoa"]));
  assert.equal(v.poolTotalShares, String(180n * T));
  assert.equal(v.oaExcludedShares, String(30n * T));
  assert.equal(v.poolNonOaShares, String(150n * T));
  assert.equal(v.nonOaStakerCount, 2);
  assert.equal(v.oaStakerCount, 1);
  assert.deepEqual(v.ranking[0], ["0xaa", String(100n * T)]);
  assert.deepEqual(v.ranking[1], ["0xbb", String(50n * T)]);
});

test("buildView tier wallet counts sum to the non-OA staker count", () => {
  const shares = new Map([
    ["0xaa", 100n * T],
    ["0xbb", 50n * T],
    ["0xcc", 1n * T],
  ]);
  const v = buildView(shares, new Set());
  const sumWallets = v.tiers.reduce((a, t) => a + t.wallets, 0);
  assert.equal(sumWallets, 3);
  assert.equal(v.tiers[v.tiers.length - 1].id, "plankton");
});

test("combineShares sums per address", () => {
  const a = new Map([
    ["x", 1n],
    ["y", 2n],
  ]);
  const b = new Map([
    ["y", 3n],
    ["z", 4n],
  ]);
  const c = combineShares(a, b);
  assert.equal(c.get("y"), 5n);
  assert.equal(c.get("x"), 1n);
  assert.equal(c.get("z"), 4n);
});

test("buildSummary produces all three views + disclaimer", () => {
  const eth = { shares: new Map([["x", 10n * T]]), oa: new Set(), tip: {} };
  const pls = { shares: new Map([["x", 20n * T]]), oa: new Set(), tip: {} };
  const s = buildSummary({ eth, pls });
  assert.equal(s.views.combined.poolTotalShares, String(30n * T));
  assert.ok(s.disclaimer.length > 0);
  assert.ok(s.views.eth && s.views.pls && s.views.combined);
});
