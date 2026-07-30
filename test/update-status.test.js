"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  writeUpdateStatus,
  clearUpdateStatus,
  readUpdateStatus,
  etaSeconds,
  isAlive,
} = require("../src/update-status");

/** A per-case temp status file so cases never collide. */
const tmp = (name) => path.join(os.tmpdir(), `hexleague-us-${name}.json`);

/** A pid that is never a live process here (above Linux's max pid). */
const DEAD_PID = 2147483647;

test("write -> read round-trips live progress under the current pid", () => {
  const file = tmp("roundtrip");
  writeUpdateStatus(0.42, "Scanning eth", file);
  const s = readUpdateStatus(file);
  assert.equal(s.updating, true);
  assert.equal(s.progress, 0.42);
  assert.equal(s.phase, "Scanning eth");
  fs.rmSync(file, { force: true });
});

test("clear marks the update finished", () => {
  const file = tmp("clear");
  writeUpdateStatus(0.9, "OA cluster pls", file);
  clearUpdateStatus(file);
  const s = readUpdateStatus(file);
  assert.equal(s.updating, false);
  assert.equal(s.progress, 0);
  assert.equal(s.phase, "");
  fs.rmSync(file, { force: true });
});

test("a status file left by a dead writer reads as idle", () => {
  const file = tmp("dead");
  fs.writeFileSync(
    file,
    JSON.stringify({
      updating: true,
      progress: 0.5,
      phase: "x",
      pid: DEAD_PID,
    }),
  );
  assert.equal(readUpdateStatus(file).updating, false);
  fs.rmSync(file, { force: true });
});

test("a missing status file reads as idle", () => {
  assert.deepEqual(readUpdateStatus(tmp("nope-missing")), {
    updating: false,
    progress: 0,
    phase: "",
    startedAt: null,
  });
});

test("isAlive: current pid is alive; zero/null/sentinel are not", () => {
  assert.equal(isAlive(process.pid), true);
  assert.equal(isAlive(0), false);
  assert.equal(isAlive(null), false);
  assert.equal(isAlive(DEAD_PID), false);
});

test("startedAt is stamped once and preserved across ticks (same pid)", () => {
  const file = tmp("started");
  writeUpdateStatus(0.1, "a", file);
  const first = readUpdateStatus(file).startedAt;
  assert.ok(first, "startedAt should be set");
  writeUpdateStatus(0.5, "b", file);
  assert.equal(readUpdateStatus(file).startedAt, first);
  fs.rmSync(file, { force: true });
});

test("etaSeconds extrapolates remaining time, or null when too early", () => {
  // 60s elapsed at 50% done -> ~60s remaining.
  assert.equal(etaSeconds(0.5, 1_000_000, 1_060_000), 60);
  // Under ~1% done -> not meaningful yet.
  assert.equal(etaSeconds(0.005, 1_000_000, 1_060_000), null);
  // No start time.
  assert.equal(etaSeconds(0.5, null, 1_060_000), null);
});
