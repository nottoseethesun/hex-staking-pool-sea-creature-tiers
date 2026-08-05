/**
 * @file src/hexleague.js
 * @description The hexleague core API: one facade over the scan/report pipeline
 * that both entry points call, so neither reimplements domain logic. The CLI
 * (bin/hexleague.js) and the dashboard server (server.js) map each core action
 * to a method here:
 *
 *   update()   run the full scan -> oa -> report pipeline (cancellable)
 *   stop()     cancel the running update at the next checkpoint-safe boundary
 *   isRunning()whether an update is in flight
 *   whereami() locate a staker in the report
 *
 * Cancellation is owned here, not in server.js: update() drives one in-process
 * AbortController whose signal the scan loops honour via signal.throwIfAborted().
 * That keeps server.js a thin UI + HTTP layer.
 */

"use strict";

const { runUpdate } = require("./pipeline");
const { locate } = require("./whereami");

// At most one update runs per process; its AbortController lets stop() cancel it.
let activeRun = null;

// Scan-engine ("[hexleague sync]") startup banner — light gray on very dark gray
// with a rocket each side, echoing the sibling lp-ranger tool's boot banners.
// Passed through log.info, which injects the timestamp after the tag.
const SYNC_STARTED =
  "\x1b[38;2;211;211;211;48;2;25;25;25m[hexleague sync] " +
  "🚀 Started. 🚀\x1b[0m";

/**
 * Run the full scan -> oa -> report pipeline for both chains. Cancellable via
 * stop(); only one runs at a time (a second call rejects). The `run` parameter
 * defaults to the real pipeline and is a seam overridden only by tests.
 * @param {object} ctx { config, log, force?, onProgress? }
 * @param {(c: object) => Promise<any>} [run] pipeline runner (test seam)
 * @returns {Promise<any>} the report result
 */
async function update(ctx, run = runUpdate) {
  if (activeRun) throw new Error("An update is already running.");
  const controller = new AbortController();
  activeRun = controller;
  const lg = ctx.log;
  if (lg && lg.info) lg.info(SYNC_STARTED);
  try {
    const result = await run({ ...ctx, signal: controller.signal });
    if (lg && lg.info) lg.info("[hexleague sync] ✅ Complete.");
    return result;
  } finally {
    if (activeRun === controller) activeRun = null;
  }
}

/**
 * Request cancellation of the running update, if any. The pipeline stops at the
 * next checkpoint-safe boundary, so the cache stays resumable.
 * @returns {boolean} true if an update was running and received the signal
 */
function stop() {
  if (!activeRun) return false;
  activeRun.abort();
  return true;
}

/**
 * Whether an update is currently in flight (in this process).
 * @returns {boolean}
 */
function isRunning() {
  return activeRun !== null;
}

/**
 * Locate a T-Share total or address set in the sea-creature leagues.
 * @param {object} summary out/summary.json contents
 * @param {object} query { tshares } | { addresses }
 * @returns {object}
 */
function whereami(summary, query) {
  return locate(summary, query);
}

module.exports = { update, stop, isRunning, whereami };
