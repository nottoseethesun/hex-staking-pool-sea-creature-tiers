"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const hexleague = require("../src/hexleague");

const T = 10n ** 12n;

/** A minimal view the locator can read (mirrors whereami.test.js). */
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

test("isRunning/stop are idle no-ops when nothing is running", () => {
  assert.equal(hexleague.isRunning(), false);
  assert.equal(hexleague.stop(), false);
});

test("update runs, is cancellable by stop, and clears when done", async () => {
  // Fake pipeline that resolves only once its abort signal fires.
  const fakeRun = (ctx) =>
    new Promise((resolve) => {
      ctx.signal.addEventListener("abort", () => resolve("aborted"));
    });
  const p = hexleague.update({ config: {}, log: {} }, fakeRun);
  assert.equal(hexleague.isRunning(), true);
  assert.equal(hexleague.stop(), true);
  assert.equal(await p, "aborted");
  assert.equal(hexleague.isRunning(), false);
  assert.equal(hexleague.stop(), false);
});

test("update rejects a second concurrent run", async () => {
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  const p = hexleague.update({ config: {}, log: {} }, () => gate);
  await assert.rejects(
    hexleague.update({ config: {}, log: {} }, () => gate),
    /already running/,
  );
  release();
  await p;
  assert.equal(hexleague.isRunning(), false);
});

test("whereami delegates to locate over the summary", () => {
  const summary = {
    disclaimer: "d",
    views: { eth: view(), pls: view(), combined: view() },
  };
  const out = hexleague.whereami(summary, { tshares: "200" });
  assert.equal(out.results.combined.input, "tshares");
  assert.equal(out.results.combined.rank, 2);
});
