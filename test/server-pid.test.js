/**
 * @file test/server-pid.test.js
 * @description Unit tests for the server PID-file helpers (src/server-pid.js):
 * the port-keyed path, and the write / read / clear round-trip. Hermetic — writes
 * only to a unique temp directory.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { pidPath, writePid, readPid, clearPid } = require("../src/server-pid");

/** A unique temp PID-file path. */
function tempPidFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "hexpid-")), "s.pid");
}

test("pidPath is under the temp dir and keyed by port", () => {
  const p = pidPath({ port: 3693 });
  assert.ok(p.startsWith(os.tmpdir()));
  assert.match(p, /3693/);
  assert.notEqual(pidPath({ port: 5555 }), p);
});

test("write / read / clear round-trip", () => {
  const file = tempPidFile();
  assert.equal(readPid(file), null); // absent
  writePid(file, 4242);
  assert.equal(readPid(file), 4242);
  clearPid(file);
  assert.equal(readPid(file), null); // cleared
});

test("readPid returns null on garbage contents", () => {
  const file = tempPidFile();
  fs.writeFileSync(file, "not-a-pid\n");
  assert.equal(readPid(file), null);
  clearPid(file);
});
