/**
 * @file src/cli/report-cmd.js
 * @description `report` subcommand — builds all out/ artifacts from the cached
 * ledgers + OA clusters, reading the pinned-tip totals live (and caching them)
 * so reconciliation can run. `--offline` skips RPC (requires cached tips).
 */

"use strict";

const { parseArgs } = require("node:util");
const { config } = require("../config");
const { log } = require("../log");
const { makeClient } = require("./context");
const { generateReport } = require("../report/report");
const { DISCLAIMER_SHORT } = require("../disclaimer");

/**
 * `report` entry point.
 * @param {string[]} argv
 * @returns {Promise<void>}
 */
async function report(argv) {
  const { values } = parseArgs({
    args: argv,
    options: { offline: { type: "boolean", default: false } },
  });
  const clients = values.offline
    ? {}
    : { eth: makeClient(config, "eth"), pls: makeClient(config, "pls") };
  const { reconciliation } = await generateReport({ clients, log });
  for (const chainKey of ["eth", "pls"]) {
    const rec = reconciliation[chainKey];
    log.info(
      "[report %s] reconciliation %s (diff=%s)",
      chainKey,
      rec.ok ? "PASS" : "FAIL",
      rec.diff,
    );
  }
  log.info(DISCLAIMER_SHORT);
}

module.exports = { report };
