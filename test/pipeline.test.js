"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { updateStatus, stageWeights } = require("../src/pipeline");

// Fixed "now" at mid-day UTC so a cache can be placed on the same or an earlier
// UTC day deterministically.
const NOON = Date.UTC(2026, 6, 30, 12, 0, 0); // 2026-07-30 12:00:00 UTC

function summaryAt(ethMs, plsMs) {
  return {
    chains: {
      eth: { timeUtc: new Date(ethMs).toISOString() },
      pls: { timeUtc: new Date(plsMs).toISOString() },
    },
  };
}

test("no summary -> no complete scan, initial sync offered", () => {
  const s = updateStatus(null, NOON);
  assert.equal(s.hasCompleteScan, false);
  assert.equal(s.updateEnabled, true);
  assert.equal(s.staleDays, null);
});

test("same UTC day -> not stale (buttons disabled)", () => {
  const morning = Date.UTC(2026, 6, 30, 3, 0, 0); // same UTC day, 9h earlier
  const s = updateStatus(summaryAt(morning, morning), NOON);
  assert.equal(s.updateEnabled, false);
  assert.equal(s.staleDays, 0);
});

test("earlier UTC day -> stale even when only hours old", () => {
  const lastNight = Date.UTC(2026, 6, 29, 23, 30, 0); // 12.5h old, previous day
  const s = updateStatus(summaryAt(lastNight, lastNight), NOON);
  assert.equal(s.updateEnabled, true);
  assert.equal(s.staleDays, 1);
});

test("the stalest chain (oldest UTC day) drives staleness", () => {
  const today = Date.UTC(2026, 6, 30, 6, 0, 0);
  const daysAgo = Date.UTC(2026, 6, 27, 6, 0, 0); // 3 UTC days behind
  const s = updateStatus(summaryAt(today, daysAgo), NOON);
  assert.equal(s.updateEnabled, true);
  assert.equal(s.staleDays, 3);
});

test("stageWeights normalizes block-work; a cached stage gets ~0 of the bar", () => {
  const w = stageWeights({
    scanEth: 0,
    oaEth: 100,
    scanPls: 100,
    oaPls: 100,
    report: 10,
  });
  const total = w.scanEth + w.oaEth + w.scanPls + w.oaPls + w.report;
  assert.equal(Math.round(total * 1000) / 1000, 1);
  assert.equal(w.scanEth, 0);
  assert.ok(w.scanPls > w.report);
});

test("stageWeights with only report work puts all weight on report", () => {
  const w = stageWeights({
    scanEth: 0,
    oaEth: 0,
    scanPls: 0,
    oaPls: 0,
    report: 150000,
  });
  assert.equal(w.report, 1);
});

test("stageWeights guards divide-by-zero on all-zero work", () => {
  const w = stageWeights({
    scanEth: 0,
    oaEth: 0,
    scanPls: 0,
    oaPls: 0,
    report: 0,
  });
  assert.equal(Number.isNaN(w.report), false);
});
