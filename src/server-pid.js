/**
 * @file src/server-pid.js
 * @description The dashboard server's PID file, so `npm stop` (scripts/stop.js)
 * can find and signal the running server. The server writes it once it is
 * listening and removes it on exit / signal; it is keyed by port under the OS
 * temp directory, so two servers on different ports never collide.
 */

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

/**
 * Path to the PID file for a config (one per port).
 * @param {object} config
 * @returns {string}
 */
function pidPath(config) {
  return path.join(os.tmpdir(), `hexleague-server-${config.port}.pid`);
}

/**
 * Write a PID to the file.
 * @param {string} file
 * @param {number} [pid]
 */
function writePid(file, pid = process.pid) {
  fs.writeFileSync(file, `${pid}\n`);
}

/**
 * Read the PID from the file, or null if absent / unreadable / not a PID.
 * @param {string} file
 * @returns {number|null}
 */
function readPid(file) {
  try {
    const n = Number.parseInt(fs.readFileSync(file, "utf8").trim(), 10);
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/**
 * Remove the PID file (best-effort; ignore if already gone).
 * @param {string} file
 */
function clearPid(file) {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // best-effort cleanup; a stale file is harmless (the PID is re-checked)
  }
}

module.exports = { pidPath, writePid, readPid, clearPid };
