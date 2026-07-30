/**
 * @file src/cli/scan-cmd.js
 * @description `scan` subcommand — runs (or incrementally tops up) the stake
 * ledger scan for a chain. `--rebuild` discards the cache and rescans from the
 * deploy block.
 */

"use strict";

const { parseArgs } = require("node:util");
const { config } = require("../config");
const { log } = require("../log");
const { makeClient, assertChain } = require("./context");
const { scanChain } = require("../scan/scan");
const { DISCLAIMER_SHORT } = require("../disclaimer");

/**
 * `scan` entry point.
 * @param {string[]} argv
 * @returns {Promise<void>}
 */
async function scan(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      chain: { type: "string" },
      rebuild: { type: "boolean", default: false },
    },
  });
  if (!values.chain) {
    throw new Error("scan requires --chain eth|pls");
  }
  const chainKey = assertChain(values.chain);
  const client = makeClient(config, chainKey);
  const result = await scanChain({
    client,
    chainKey,
    config,
    log,
    force: values.rebuild,
  });
  log.info(
    "[scan %s] done: tip=%d deployBlock=%d rows=%d",
    chainKey,
    result.tip,
    result.deployBlock,
    result.rows,
  );
  log.info(DISCLAIMER_SHORT);
}

module.exports = { scan };
