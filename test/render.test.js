"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildSummary } = require("../src/report/summary");
const { renderMarkdown } = require("../src/report/markdown");
const { leaguesCsv, oaWalletsCsv } = require("../src/report/csv");
const { buildDisplay } = require("../src/report/display");
const { buildMembers, memberAddressSet } = require("../src/oa/oa");

const T = 10n ** 12n;
const A = `0x${"a".repeat(40)}`;
const B = `0x${"b".repeat(40)}`;
const OA = `0x${"9".repeat(40)}`;

function fixtureSummary() {
  const tip = (block, shareRate) => ({
    block,
    timeUtc: "2026-07-01T00:00:00.000Z",
    shareRate,
  });
  return buildSummary({
    eth: {
      shares: new Map([
        [A, 100n * T],
        [B, 3n * T],
      ]),
      oa: new Set(),
      tip: tip(100, "150000"),
    },
    pls: {
      shares: new Map([[A, 50n * T]]),
      oa: new Set(),
      tip: tip(200, "120000"),
    },
  });
}

test("renderMarkdown produces all three views and their tables", () => {
  const md = renderMarkdown(fixtureSummary(), {});
  assert.match(md, /# HEX Sea-Creature League/);
  assert.match(md, /Ethereum view/);
  assert.match(md, /PulseChain view/);
  assert.match(md, /Combined/);
  assert.match(md, /Sea Creature Table/);
  assert.match(md, /Prosperous Poseidon/);
});

test("leaguesCsv has a header and ranked rows", () => {
  const csv = leaguesCsv(fixtureSummary().views.eth, {});
  const lines = csv.trim().split("\n");
  assert.match(lines[0], /^rank,address,tshares/);
  assert.ok(lines.length >= 3);
});

test("oaWalletsCsv renders evidence-backed members", () => {
  const csv = oaWalletsCsv({
    eth: {
      members: [
        {
          addr: A,
          depth: 1,
          via: OA,
          fracHex: 0.5,
          fracNative: 0,
          evidence: [{ txHash: "0x1" }],
        },
      ],
    },
    pls: { members: [] },
  });
  assert.match(csv, /^chain,address,hop_depth/);
  assert.match(csv, /0x1/);
});

test("buildDisplay produces tier + top display strings", () => {
  const d = buildDisplay(fixtureSummary().views.eth, "150000", {
    [A.toLowerCase()]: true,
  });
  assert.equal(d.tiers.length, 10);
  assert.ok(d.top.length >= 1);
  assert.match(d.poolTotalTShares, /[0-9]/);
  assert.equal(d.top[0].contract, "yes");
});

test("buildMembers flags a candidate over the per-asset threshold", () => {
  const reachable = new Map([
    [
      A.toLowerCase(),
      {
        depth: 1,
        via: OA.toLowerCase(),
        oaHex: 30n,
        oaNative: 0n,
        evidence: [],
      },
    ],
    [
      B.toLowerCase(),
      { depth: 2, via: A.toLowerCase(), oaHex: 5n, oaNative: 1n, evidence: [] },
    ],
  ]);
  const totals = new Map([
    [A.toLowerCase(), { totalHex: 100n, totalNative: 100n }],
    [B.toLowerCase(), { totalHex: 100n, totalNative: 100n }],
  ]);
  const members = buildMembers(
    [A.toLowerCase(), B.toLowerCase()],
    reachable,
    totals,
    0.2,
  );
  assert.equal(members.length, 1);
  assert.equal(members[0].addr.toLowerCase(), A.toLowerCase());
  assert.equal(members[0].depth, 1);
});

test("memberAddressSet includes OA and members, lowercased", () => {
  const set = memberAddressSet({ oa: A, members: [{ addr: B }] });
  assert.ok(set.has(A.toLowerCase()));
  assert.ok(set.has(B.toLowerCase()));
});
