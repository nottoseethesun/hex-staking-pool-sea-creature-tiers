"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildSummary } = require("../src/report/summary");
const {
  buildPoolData,
  whatIsMySeaCreature,
  parsePositiveTshares,
  buildRoster,
} = require("../src/report/pool-data");

const T = 1000000000000n; // 10^12 raw shares = 1 T-Share

/**
 * A small but realistic summary: eth has two non-OA stakers (10 + 90 T-Shares),
 * pls has one (20 T-Shares). Combined sums by address.
 * @returns {object}
 */
function fixtureSummary() {
  const ethTip = {
    block: 100,
    timeUtc: "2026-01-01T00:00:00.000Z",
    stakeSharesTotal: "50",
    nextStakeSharesTotal: "60",
    shareRate: "3",
    currentDay: "1000",
    totalSupply: "9",
  };
  const plsTip = {
    block: 200,
    timeUtc: "2026-01-02T00:00:00.000Z",
    stakeSharesTotal: "80",
    nextStakeSharesTotal: "90",
    shareRate: "3",
    currentDay: "1000",
    totalSupply: "9",
  };
  return buildSummary({
    eth: {
      shares: new Map([
        ["0xaaa", 10n * T],
        ["0xbbb", 90n * T],
      ]),
      oa: new Set(),
      tip: ethTip,
    },
    pls: {
      shares: new Map([["0xaaa", 20n * T]]),
      oa: new Set(),
      tip: plsTip,
    },
  });
}

test("buildPoolData: as-of block + UTC time per chain", () => {
  const data = buildPoolData(fixtureSummary());
  assert.deepEqual(data.asOf.eth, {
    block: 100,
    timeUtc: "2026-01-01T00:00:00.000Z",
  });
  assert.deepEqual(data.asOf.pls, {
    block: 200,
    timeUtc: "2026-01-02T00:00:00.000Z",
  });
  // The full pinned-tip chain state is also carried through.
  assert.equal(data.chains.eth.stakeSharesTotal, "50");
  assert.equal(data.chains.pls.currentDay, "1000");
});

test("buildPoolData: per-view pool totals mirror raw shares as T-Shares", () => {
  const data = buildPoolData(fixtureSummary());
  assert.equal(data.views.eth.pool.total.shares, (100n * T).toString());
  assert.equal(data.views.eth.pool.total.tShares, "100.00000000");
  assert.equal(data.views.eth.stakerCounts.nonOa, 2);
  assert.equal(data.views.eth.stakerCounts.oa, 0);
  // combined sums by address: 0xaaa = 10 + 20 = 30, 0xbbb = 90 -> 120 T-Shares.
  assert.equal(data.views.combined.pool.total.tShares, "120.00000000");
  // tiers are present as organized aggregates, not a raw address dump.
  assert.ok(Array.isArray(data.views.eth.tiers));
  assert.equal(data.views.eth.ranking, undefined);
  assert.equal(data.views.eth.oaAddresses, undefined);
  // 8-decimal precision keeps a small threshold that 3 decimals would flatten:
  // eth Shell = pool / 10^9 = 0.00000010 T-Shares (would be "0.000" at 3 dp).
  assert.equal(
    data.views.eth.tiers.find((t) => t.id === "shell").minTShares,
    "0.00000010",
  );
});

test("buildRoster: key-value roster, top-to-bottom with thresholds", () => {
  const roster = buildRoster();
  assert.equal(roster.poseidon.rank, 1);
  assert.equal(roster.poseidon.name, "Prosperous Poseidon");
  assert.equal(roster.poseidon.minShareFraction, "1/10");
  assert.equal(roster.poseidon.minSharePercent, "10");
  assert.equal(roster.whale.minSharePercent, "1");
  assert.equal(roster.shell.rank, 9);
  assert.equal(roster.shell.minShareFraction, "1/1000000000");
  assert.equal(roster.plankton.rank, null);
  assert.equal(roster.plankton.minSharePercent, "0");
  // Keyed by tier id, ordered top -> bottom, Plankton last.
  assert.deepEqual(Object.keys(roster).slice(0, 2), ["poseidon", "whale"]);
  assert.equal(Object.keys(roster).at(-1), "plankton");
});

test("whatIsMySeaCreature: ranking for a positive integer + full pool data", () => {
  const summary = fixtureSummary();
  const out = whatIsMySeaCreature(summary, "42");
  assert.equal(out.query.tshares, "42");
  assert.equal(out.disclaimer, summary.disclaimer);
  for (const view of ["eth", "pls", "combined"]) {
    assert.ok(out.ranking[view].league, `ranking has a league for ${view}`);
    assert.equal(typeof out.ranking[view].rank, "number");
  }
  assert.ok(out.stakingPool.roster.poseidon);
  assert.ok(out.stakingPool.asOf.eth.block === 100);
});

test("parsePositiveTshares accepts positive numbers up to 8 decimals", () => {
  assert.equal(parsePositiveTshares("42"), "42");
  assert.equal(parsePositiveTshares(" 42.5 "), "42.5"); // trimmed
  assert.equal(parsePositiveTshares("0.00000001"), "0.00000001"); // 8 dp
  assert.equal(parsePositiveTshares(7), "7");
  // zero / negative / non-numeric / malformed
  for (const bad of [
    "0",
    "0.0",
    "-5",
    "1e3",
    "abc",
    "",
    "  ",
    ".5",
    "42.",
    null,
  ]) {
    assert.throws(
      () => parsePositiveTshares(bad),
      /positive|non-zero/,
      `should reject ${JSON.stringify(bad)}`,
    );
  }
});

test("parsePositiveTshares rejects finer than 8 decimals (not truncated)", () => {
  assert.throws(
    () => parsePositiveTshares("0.000000001"), // 9 dp
    /at most 8 decimal places/,
  );
});

test("whatIsMySeaCreature honors a fractional tshares and rejects over-precision", () => {
  const out = whatIsMySeaCreature(fixtureSummary(), "42.5");
  assert.equal(out.query.tshares, "42.5");
  assert.ok(out.ranking.eth.league);
  assert.throws(
    () => whatIsMySeaCreature(fixtureSummary(), "1.123456789"), // 9 dp
    /at most 8 decimal places/,
  );
});
