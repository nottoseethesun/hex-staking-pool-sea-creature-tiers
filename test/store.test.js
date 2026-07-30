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
  truncatePartialLine,
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

test("truncatePartialLine drops a partial trailing line, keeps whole rows", () => {
  const file = path.join(tmpDir(), "partial.ndjson");
  const whole = '{"e":0,"s":"a"}\n{"e":1,"s":"b"}\n';
  // A hard shutdown mid-append leaves whole rows, then a truncated one (no \n).
  fs.writeFileSync(file, `${whole}{"e":0,"s":"c`);
  truncatePartialLine(file);
  assert.equal(fs.readFileSync(file, "utf8"), whole);
});

test("truncatePartialLine leaves a cleanly-terminated file untouched", () => {
  const file = path.join(tmpDir(), "clean.ndjson");
  const clean = '{"e":0,"s":"a"}\n{"e":1,"s":"b"}\n';
  fs.writeFileSync(file, clean);
  truncatePartialLine(file);
  assert.equal(fs.readFileSync(file, "utf8"), clean);
});

test("truncatePartialLine on a missing file is a no-op (no throw)", () => {
  const gone = path.join(tmpDir(), "gone.ndjson");
  assert.doesNotThrow(() => truncatePartialLine(gone));
});

test("heal-then-append recovers a hard-shutdown ledger so readNdjson parses", async () => {
  const file = path.join(tmpDir(), "resume.ndjson");
  // Partial last row with no newline, as a power loss could leave it.
  fs.writeFileSync(file, '{"e":0,"s":"a"}\n{"e":0,"s":"b');
  // What scanChain does before re-appending, then the re-scan re-adds the row.
  truncatePartialLine(file);
  appendNdjson(file, [
    { e: 0, s: "b" },
    { e: 1, s: "c" },
  ]);
  const rows = [];
  const count = await readNdjson(file, (r) => rows.push(r));
  assert.equal(count, 3);
  assert.deepEqual(
    rows.map((r) => r.s),
    ["a", "b", "c"],
  );
});
