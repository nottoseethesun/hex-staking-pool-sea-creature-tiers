"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { updateStatus, FRESH_HOURS, stageWeights } = require("../src/pipeline");

const HOUR = 3600000;
const NOW = 1000000000000;

function summaryAgedHours(ethH, plsH) {
  return {
    chains: {
      eth: { timeUtc: new Date(NOW - ethH * HOUR).toISOString() },
      pls: { timeUtc: new Date(NOW - plsH * HOUR).toISOString() },
    },
  };
}

test("no summary -> no complete scan and update disabled", () => {
  const s = updateStatus(null, NOW);
  assert.equal(s.hasCompleteScan, false);
  assert.equal(s.updateEnabled, false);
  assert.match(s.reason, /initial scan/i);
});

test("fresh data (< 24h) -> update disabled", () => {
  const s = updateStatus(summaryAgedHours(2, 2), NOW);
  assert.equal(s.hasCompleteScan, true);
  assert.equal(s.updateEnabled, false);
  assert.equal(s.ageHours, 2);
});

test("stale data (> 24h, by the oldest chain) -> update enabled", () => {
  const s = updateStatus(summaryAgedHours(30, 5), NOW);
  assert.equal(s.updateEnabled, true);
  assert.equal(s.ageHours, 30);
});

test("FRESH_HOURS is 24", () => {
  assert.equal(FRESH_HOURS, 24);
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
