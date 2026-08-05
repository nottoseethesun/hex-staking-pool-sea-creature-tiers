"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { scanStats } = require("../src/report/report");

test("scanStats summarizes the tip, span, and OA sweep", () => {
  const s = scanStats("eth", {
    tip: {
      block: 100,
      timeUtc: "2026-08-01T00:00:00.000Z",
      currentDay: "2400",
    },
    oaJson: {
      deployBlock: 40,
      candidateStakerCount: 500,
      memberCount: 12,
      reachableCount: 800,
      sweep: { inboundMs: 3_600_000, candidates: 500 },
    },
  });
  assert.equal(s.tipBlock, 100);
  assert.equal(s.deployBlock, 40);
  assert.equal(s.blockSpan, 60);
  assert.equal(s.candidateStakerCount, 500);
  assert.equal(s.memberCount, 12);
  assert.equal(s.currentDay, "2400");
  assert.equal(s.oaSweep.inboundMs, 3_600_000);
});

test("scanStats degrades missing OA data to null (never invents numbers)", () => {
  // A throwaway chain key with no on-disk deploy block, so the fallback is null.
  const s = scanStats("zz-no-such-chain", {
    tip: { block: 100, timeUtc: "2026-08-01T00:00:00.000Z" },
    oaJson: { members: [] },
  });
  assert.equal(s.deployBlock, null);
  assert.equal(s.blockSpan, null);
  assert.equal(s.candidateStakerCount, null);
  assert.equal(s.memberCount, 0); // derivable from members[]
  assert.equal(s.currentDay, null);
  assert.equal(s.oaSweep, null);
});
