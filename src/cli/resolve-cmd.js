/**
 * @file src/cli/resolve-cmd.js
 * @description `resolve` subcommand — builds a chain's resolution cache: HSI
 * ownership (via the HSIM) plus look-through wrapper token balances ($MAXI),
 * scanned to the stakes checkpoint's pinned tip. Run after `scan`, before `oa`.
 * `--rebuild` recomputes even when the tip is unchanged.
 */

"use strict";

const { parseArgs } = require("node:util");
const { config } = require("../config");
const { log } = require("../log");
const { makeClient, assertChain } = require("./context");
const { buildResolution } = require("../resolve/resolve");
const { DISCLAIMER_SHORT } = require("../disclaimer");

/**
 * `resolve` entry point.
 * @param {string[]} argv
 * @returns {Promise<void>}
 */
async function resolve(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      chain: { type: "string" },
      rebuild: { type: "boolean", default: false },
    },
  });
  if (!values.chain) {
    throw new Error("resolve requires --chain eth|pls");
  }
  const chainKey = assertChain(values.chain);
  const client = makeClient(config, chainKey);
  const result = await buildResolution({
    client,
    chainKey,
    config,
    log,
    force: values.rebuild,
  });
  log.info(
    "[resolve %s] done: tip=%d hsiOwners=%d wrappers=%d",
    chainKey,
    result.tip,
    Object.keys(result.hsiOwners).length,
    result.wrappers.length,
  );
  log.info(DISCLAIMER_SHORT);
}

module.exports = { resolve };
