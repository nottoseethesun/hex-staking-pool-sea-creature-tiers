/**
 * @file src/cli/oa-cmd.js
 * @description `oa` subcommand — builds the OA funding cluster for a chain
 * (>=3-hop reverse funding via forward BFS + >=20% per-asset threshold). Reads
 * the cached stake ledger to know which reachable wallets are active stakers.
 */

"use strict";

const { parseArgs } = require("node:util");
const { config } = require("../config");
const { log } = require("../log");
const { makeClient, assertChain } = require("./context");
const { buildActiveShares } = require("../scan/scan");
const { buildOa } = require("../oa/oa");
const { DISCLAIMER_SHORT } = require("../disclaimer");

/**
 * `oa` entry point.
 * @param {string[]} argv
 * @returns {Promise<void>}
 */
async function oa(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      chain: { type: "string" },
      rebuild: { type: "boolean", default: false },
    },
  });
  if (!values.chain) {
    throw new Error("oa requires --chain eth|pls");
  }
  const chainKey = assertChain(values.chain);
  const client = makeClient(config, chainKey);
  const activeStakers = await buildActiveShares(chainKey);
  const result = await buildOa({
    client,
    chainKey,
    config,
    log,
    activeStakers,
    force: values.rebuild,
  });
  log.info(
    "[oa %s] members=%d contractsSeen=%d (maxHops=%d threshold=%d%%)",
    chainKey,
    result.memberCount,
    result.contractsSeen.length,
    config.oaMaxHops,
    Math.round(config.oaFundingThreshold * 100),
  );
  log.info(DISCLAIMER_SHORT);
}

module.exports = { oa };
