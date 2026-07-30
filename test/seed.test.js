"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const {
  seed,
  sha256File,
  assertChecksum,
  dataDirPopulated,
} = require("../src/seed");

const tmp = (name) => path.join(os.tmpdir(), `hexleague-seed-test-${name}`);

test("sha256File matches Node's own digest of the bytes", async () => {
  const file = tmp("hash.bin");
  const bytes = Buffer.from("hex sea-creature league snapshot\n".repeat(1000));
  fs.writeFileSync(file, bytes);
  const expected = crypto.createHash("sha256").update(bytes).digest("hex");
  assert.equal(await sha256File(file), expected);
  fs.rmSync(file, { force: true });
});

test("assertChecksum accepts a match (case/0x-insensitive), rejects otherwise", () => {
  const h = "ABC123def456";
  assert.doesNotThrow(() => assertChecksum(h, h.toLowerCase()));
  assert.doesNotThrow(() => assertChecksum(h, `0x${h}`));
  assert.throws(() => assertChecksum(h, "deadbeef"), /SHA-256 mismatch/);
  assert.throws(() => assertChecksum(h, ""), /SHA-256 mismatch/);
});

test("dataDirPopulated is true only when a subdirectory exists", () => {
  const dir = tmp(`dir-${process.pid}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  assert.equal(dataDirPopulated(dir), false); // empty
  fs.writeFileSync(path.join(dir, "note.txt"), "x");
  assert.equal(dataDirPopulated(dir), false); // a loose file, not a scan
  fs.mkdirSync(path.join(dir, "eth"));
  assert.equal(dataDirPopulated(dir), true); // a chain subdirectory
  assert.equal(dataDirPopulated(tmp("does-not-exist")), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("seed refuses to run without a url + sha256", async () => {
  await assert.rejects(() => seed({ log: { info() {} } }), /requires --url/);
});
