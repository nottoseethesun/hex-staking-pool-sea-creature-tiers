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
  pushSample,
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

test("etaSeconds: null during the first 2 minutes (warmup)", () => {
  const now = 1_000_000;
  const samples = [
    { t: now - 60_000, p: 0.1 },
    { t: now, p: 0.2 },
  ];
  // started 90s ago -> under the 2-min warmup -> no estimate yet.
  assert.equal(etaSeconds(now - 90_000, samples, now), null);
});

test("etaSeconds: after warmup, uses the recent-window rate", () => {
  const now = 1_000_000;
  // 0.1 of progress over the trailing 120s -> remaining 0.8 takes 960s.
  const samples = [
    { t: now - 120_000, p: 0.1 },
    { t: now, p: 0.2 },
  ];
  assert.equal(etaSeconds(now - 300_000, samples, now), 960);
});

test("etaSeconds: null with no start, one sample, or no progress", () => {
  const now = 1_000_000;
  const flat = [
    { t: now - 120_000, p: 0.2 },
    { t: now, p: 0.2 },
  ];
  assert.equal(etaSeconds(null, flat, now), null); // no start time
  assert.equal(etaSeconds(now - 300_000, [{ t: now, p: 0.2 }], now), null);
  assert.equal(etaSeconds(now - 300_000, flat, now), null); // no progress (dp=0)
});

test("pushSample downsamples close ticks and prunes the old window", () => {
  const t0 = 1_000_000;
  let s = pushSample([], t0, 0.1);
  s = pushSample(s, t0 + 1000, 0.15); // < 3s gap -> replaces the last sample
  assert.equal(s.length, 1);
  assert.equal(s[0].p, 0.15);
  s = pushSample(s, t0 + 5000, 0.2); // >= 3s -> appends
  assert.equal(s.length, 2);
  s = pushSample(s, t0 + 200_000, 0.9); // jump past the 2-min window
  assert.equal(s[s.length - 1].p, 0.9);
  assert.ok(s.length >= 2);
});

test("a fresh live run has no ETA yet (under the 2-min warmup)", () => {
  const file = tmp("warmup");
  writeUpdateStatus(0.3, "Resolving eth", file);
  const s = readUpdateStatus(file);
  assert.ok(Array.isArray(s.samples) && s.samples.length >= 1);
  const started = Date.parse(s.startedAt);
  assert.equal(etaSeconds(started, s.samples, Date.now()), null);
  fs.rmSync(file, { force: true });
});
