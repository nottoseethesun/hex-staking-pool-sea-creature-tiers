"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  locate,
  locateInView,
  tsharesToRaw,
  countGreater,
  nextTierUp,
} = require("../src/whereami");
const { LADDER } = require("../src/report/leagues");

const T = 10n ** 12n;

function view() {
  return {
    poolNonOaShares: String(1000n * T),
    nonOaStakerCount: 3,
    ranking: [
      ["0xaa", String(500n * T)],
      ["0xbb", String(200n * T)],
      ["0xcc", String(5n * T)],
    ],
    oaAddresses: ["0xoa"],
  };
}

test("tsharesToRaw scales exactly up to 12 decimals", () => {
  assert.equal(tsharesToRaw("1"), T);
  assert.equal(tsharesToRaw("1.5"), (3n * T) / 2n);
  assert.equal(tsharesToRaw("0.000000000001"), 1n);
});

test("countGreater counts strictly-greater entries (descending)", () => {
  const r = view().ranking;
  assert.equal(countGreater(r, 500n * T), 0);
  assert.equal(countGreater(r, 200n * T), 1);
  assert.equal(countGreater(r, 1n * T), 3);
});

test("nextTierUp climbs the ladder and stops at the top", () => {
  assert.equal(nextTierUp(LADDER[1]).id, LADDER[0].id);
  assert.equal(nextTierUp(LADDER[0]), null);
});

test("locateInView returns tier, rank, and staker count", () => {
  const r = locateInView(view(), 500n * T);
  assert.equal(r.rank, 1);
  assert.equal(r.nonOaStakerCount, 3);
  assert.ok(r.league.id);
  assert.equal(r.tshares, "500.000");
});

test("locate flags OA addresses and sums the rest across views", () => {
  const summary = {
    disclaimer: "d",
    views: { eth: view(), pls: view(), combined: view() },
  };
  const out = locate(summary, { addresses: ["0xaa", "0xoa"] });
  assert.equal(out.results.eth.oaHits[0], "0xoa");
  assert.equal(out.results.eth.found[0], "0xaa");
  assert.equal(out.results.eth.tshares, "500.000");
});

test("locate supports a raw --tshares query", () => {
  const summary = {
    disclaimer: "d",
    views: { eth: view(), pls: view(), combined: view() },
  };
  const out = locate(summary, { tshares: "200" });
  assert.equal(out.results.eth.input, "tshares");
  assert.equal(out.results.eth.rank, 2);
});
