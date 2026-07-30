"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");
const fs = require("fs");
const path = require("path");
const {
  writeJson,
  readJson,
  appendNdjson,
  readNdjson,
} = require("../src/cache/store");

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hexstore-"));
}

test("writeJson / readJson round-trip; readJson falls back when missing", () => {
  const file = path.join(tmpDir(), "x.json");
  writeJson(file, { a: 1, b: "two" });
  assert.deepEqual(readJson(file), { a: 1, b: "two" });
  assert.equal(readJson(path.join(tmpDir(), "missing.json"), "fb"), "fb");
});

test("appendNdjson accumulates and readNdjson streams every row", async () => {
  const file = path.join(tmpDir(), "rows.ndjson");
  appendNdjson(file, [
    { e: 0, s: "a" },
    { e: 1, s: "b" },
  ]);
  appendNdjson(file, [{ e: 0, s: "c" }]);
  appendNdjson(file, []); // no-op
  const rows = [];
  const count = await readNdjson(file, (r) => rows.push(r));
  assert.equal(count, 3);
  assert.equal(rows[2].s, "c");
});

test("readNdjson returns 0 for a missing file", async () => {
  const count = await readNdjson(path.join(tmpDir(), "nope.ndjson"), () => {});
  assert.equal(count, 0);
});
