/**
 * @file src/cli/stop-cmd.js
 * @description `stop` subcommand — cancel a running scan. A scan runs inside the
 * process that started it, so a separate CLI process cannot abort it directly;
 * this asks the running dashboard to stop its in-process scan over HTTP
 * (POST /api/update/stop, the bridge to the server's `hexleague.stop()`). A
 * foreground `hexleague update` in another terminal is stopped with Ctrl-C.
 */

"use strict";

const { config } = require("../config");
const { log } = require("../log");
const { readUpdateStatus } = require("../update-status");

/**
 * `stop` entry point.
 * @returns {Promise<void>}
 */
async function stop() {
  const base = `http://${config.host}:${config.port}`;
  const res = await fetch(`${base}/api/update/stop`, { method: "POST" }).catch(
    () => null,
  );
  if (res && res.status === 202) {
    log.info("Stopping the dashboard scan; it halts at the next checkpoint.");
    return;
  }
  if (readUpdateStatus().updating) {
    log.info(
      "A scan is running but not in the dashboard (e.g. 'hexleague update' " +
        "in another terminal); stop that process with Ctrl-C.",
    );
    return;
  }
  log.info("No scan is running.");
}

module.exports = { stop };
