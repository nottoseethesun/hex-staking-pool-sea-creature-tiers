/**
 * @file src/cli/context.js
 * @description Shared CLI helpers: build a guarded RPC client for a chain and
 * validate the --chain flag.
 */

"use strict";

const { makeClient } = require("../rpc/make-client");
const { CHAIN_KEYS } = require("../chain/constants");

/**
 * Validate and return a chain key.
 * @param {string} chainKey
 * @returns {string}
 */
function assertChain(chainKey) {
  if (!CHAIN_KEYS.includes(chainKey)) {
    throw new Error(`--chain must be one of: ${CHAIN_KEYS.join(", ")}`);
  }
  return chainKey;
}

module.exports = { makeClient, assertChain };
