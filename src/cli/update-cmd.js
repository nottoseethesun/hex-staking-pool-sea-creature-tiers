/**
 * @file src/cli/update-cmd.js
 * @description `update` subcommand — runs the full pipeline (scan -> oa ->
 * report for both chains). This is the same work the dashboard's Update button
 * performs; use it for the initial scan and for incremental top-ups.
 */

"use strict";

const { parseArgs } = require("node:util");
const { config } = require("../config");
const { log } = require("../log");
const hexleague = require("../hexleague");
const { DISCLAIMER_SHORT } = require("../disclaimer");

/**
 * `update` entry point.
 * @param {string[]} argv
 * @returns {Promise<void>}
 */
async function update(argv) {
  const { values } = parseArgs({
    args: argv,
    options: { rebuild: { type: "boolean", default: false } },
  });
  await hexleague.update({ config, log, force: values.rebuild });
  log.info("[update] complete — scan + oa + report for both chains");
  log.info(DISCLAIMER_SHORT);
}

module.exports = { update };
