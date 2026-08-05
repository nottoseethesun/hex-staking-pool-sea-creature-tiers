"use strict";

const test = require("node:test");
const { beforeEach, after } = test;
const assert = require("node:assert/strict");
const fs = require("fs");
const cp = require("../src/scan/checkpoint");
const { chainDir } = require("../src/cache/store");
const { resolveScanTip } = require("../src/scan/scan");
const { completeCycles } = require("../src/report/report");

// Throwaway chain keys under data/ so these tests never touch the real eth/pls
// cache; wiped before each test and after the suite.
const KEYS = ["cyc-test", "cyc-test-a", "cyc-test-b"];
const wipe = () => {
  for (const k of KEYS)
    fs.rmSync(chainDir(k), { recursive: true, force: true });
};
beforeEach(wipe);
after(wipe);

test("stickyTip returns an open cycle's tip, else null", () => {
  const k = "cyc-test";
  assert.equal(cp.stickyTip(k), null); // no cycle yet -> pin fresh
  cp.saveCycle(k, { tip: 111, complete: false });
  assert.equal(cp.stickyTip(k), 111); // in progress -> sticky
  assert.equal(cp.stickyTip(k, true), null); // force ignores the cycle
  cp.saveCycle(k, { tip: 111, complete: true });
  assert.equal(cp.stickyTip(k), null); // completed -> pin fresh
});

test("resolveScanTip reuses an open cycle's tip without reading the head", async () => {
  const k = "cyc-test";
  cp.saveCycle(k, { tip: 222, complete: false });
  let headReads = 0;
  const client = {
    getBlockNumber: async () => {
      headReads += 1;
      return 9_999_999;
    },
  };
  const tip = await resolveScanTip(client, k, { tipLagBlocks: 10 }, false);
  assert.equal(tip, 222); // the sticky tip
  assert.equal(headReads, 0); // no head read while a cycle is open
  assert.deepEqual(cp.loadCycle(k), { tip: 222, complete: false }); // untouched
});

test("resolveScanTip pins head-minus-lag and opens a cycle when none is open", async () => {
  const k = "cyc-test";
  const client = { getBlockNumber: async () => 1000 };
  const tip = await resolveScanTip(client, k, { tipLagBlocks: 10 }, false);
  assert.equal(tip, 990);
  assert.deepEqual(cp.loadCycle(k), { tip: 990, complete: false });
});

test("resolveScanTip re-pins from the head under force, ignoring an open cycle", async () => {
  const k = "cyc-test";
  cp.saveCycle(k, { tip: 222, complete: false });
  const client = { getBlockNumber: async () => 1000 };
  const tip = await resolveScanTip(client, k, { tipLagBlocks: 10 }, true);
  assert.equal(tip, 990);
  assert.deepEqual(cp.loadCycle(k), { tip: 990, complete: false });
});

test("resolveScanTip pins a fresh tip after the previous cycle completed", async () => {
  const k = "cyc-test";
  cp.saveCycle(k, { tip: 100, complete: true });
  const client = { getBlockNumber: async () => 400 };
  const tip = await resolveScanTip(client, k, { tipLagBlocks: 5 }, false);
  assert.equal(tip, 395);
  assert.deepEqual(cp.loadCycle(k), { tip: 395, complete: false });
});

test("completeCycles marks each chain's open cycle complete (tip preserved)", () => {
  const [a, b] = ["cyc-test-a", "cyc-test-b"];
  cp.saveCycle(a, { tip: 500, complete: false });
  // b has no cycle marker -> stays absent (no-op, no file created)
  completeCycles([a, b]);
  assert.deepEqual(cp.loadCycle(a), { tip: 500, complete: true });
  assert.equal(cp.loadCycle(b), null);
});
