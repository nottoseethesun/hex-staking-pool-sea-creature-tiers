/**
 * @file scripts/stop.js
 * @description `npm stop` — stop the dashboard server started by `npm start`.
 * Finds the server through its PID file (src/server-pid.js) and sends SIGTERM,
 * the same clean shutdown as Ctrl+C. The immutable cache is written to survive a
 * hard stop, so this is safe even while a scan is running. To halt only a running
 * scan and leave the server up, use `hexleague stop` (`npm run scan:stop`).
 */

"use strict";

const { config } = require("../src/config");
const { pidPath, readPid, clearPid } = require("../src/server-pid");
const { log } = require("../src/log");

/**
 * Whether a process is alive (signal 0 probes without delivering a signal).
 * @param {number} pid
 * @returns {boolean}
 */
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Wait until `pid` exits or the timeout elapses.
 * @param {number} pid
 * @param {number} ms
 * @returns {Promise<boolean>} true if the process is gone
 */
async function waitGone(pid, ms) {
  const deadline = Date.now() + ms;
  while (isAlive(pid) && Date.now() < deadline) {
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
  }
  return !isAlive(pid);
}

/**
 * Stop the dashboard server.
 * @returns {Promise<void>}
 */
async function stop() {
  const file = pidPath(config);
  const pid = readPid(file);
  if (pid === null || !isAlive(pid)) {
    if (pid !== null) clearPid(file);
    log.info("Dashboard server is not running.");
    return;
  }
  process.kill(pid, "SIGTERM");
  const gone = await waitGone(pid, 3000);
  clearPid(file);
  if (gone) {
    log.info("Stopped the dashboard server (pid %d).", pid);
  } else {
    log.warn("Sent SIGTERM to pid %d, but it is still running.", pid);
  }
}

stop().catch((err) => {
  log.error("stop failed: %s", err.message);
  process.exit(1);
});
