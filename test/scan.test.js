"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");
const fs = require("fs");
const path = require("path");
const {
  applyRow,
  buildActiveShares,
  createLedgerWriter,
} = require("../src/scan/scan");
const { appendNdjson } = require("../src/cache/store");

test("applyRow adds on StakeStart and removes on StakeEnd / GoodAccounting", () => {
  const active = new Map();
  applyRow(active, { e: 0, s: "0xa", i: "1", h: "100", b: 1 });
  applyRow(active, { e: 0, s: "0xa", i: "2", h: "50", b: 2 });
  assert.equal(active.get("0xa:1"), 100n);
  applyRow(active, { e: 1, s: "0xa", i: "1", b: 3 });
  assert.equal(active.has("0xa:1"), false);
  applyRow(active, { e: 2, s: "0xa", i: "2", b: 4 });
  assert.equal(active.has("0xa:2"), false);
});

test("buildActiveShares replays a ledger and aggregates per staker", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hexscan-"));
  const file = path.join(dir, "stakes.ndjson");
  appendNdjson(file, [
    { e: 0, s: "0xaa", i: "1", h: "100", b: 1 },
    { e: 0, s: "0xaa", i: "2", h: "50", b: 2 },
    { e: 0, s: "0xbb", i: "9", h: "7", b: 3 },
    { e: 1, s: "0xaa", i: "1", b: 4 },
  ]);
  const totals = await buildActiveShares("unused", file);
  assert.equal(totals.get("0xaa"), 50n);
  assert.equal(totals.get("0xbb"), 7n);
  assert.equal(totals.size, 2);
});

test("createLedgerWriter batches appends and advances the cursor only on flush", () => {
  const appends = [];
  const saves = [];
  const w = createLedgerWriter({
    chainKey: "eth",
    file: "/tmp/ignored",
    tip: 100,
    chunkSize: 5,
    startBlock: 1,
    rows: 0,
    everyItems: 2, // flush every 2 chunks
    everyMs: 999999,
    append: (_f, batch) => appends.push(batch.length),
    save: (_c, cpObj) => saves.push(cpObj),
  });
  w.add([{ e: 0, s: "a", i: "1", h: "5", b: 1 }], 10); // chunk 1: not due
  assert.equal(appends.length, 0);
  assert.equal(saves.length, 0);
  w.add([{ e: 0, s: "b", i: "2", h: "7", b: 2 }], 20); // chunk 2: flush
  assert.equal(appends.length, 1);
  assert.equal(appends[0], 2); // both chunks' rows in one append
  assert.equal(saves.length, 1);
  assert.equal(saves[0].lastScannedBlock, 20); // cursor at last flushed block
  assert.equal(w.rows(), 2);
  // a trailing partial batch is persisted only by the explicit final flush
  w.add([{ e: 1, s: "a", i: "1", b: 3 }], 30);
  assert.equal(saves.length, 1);
  w.flush();
  assert.equal(appends.length, 2);
  assert.equal(saves[1].lastScannedBlock, 30);
  assert.equal(w.rows(), 3);
});
