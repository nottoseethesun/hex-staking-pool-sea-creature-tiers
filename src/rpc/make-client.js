/**
 * @file src/rpc/make-client.js
 * @description Single place that builds a guarded RPC client for a chain from
 * config — shared by the CLI and the update pipeline so the wiring is not
 * duplicated.
 */

"use strict";

const { createClient } = require("./client");
const { getRpcCache } = require("./cache");
const { rpcUrlFor, fallbackUrlFor } = require("../config");

/**
 * Build a guarded RPC client for a chain from config. When `config.rpcCache` is
 * set (RPC_CACHE=1), responses are memoized to disk so re-runs skip the RPC.
 * @param {object} config
 * @param {"eth"|"pls"} chainKey
 * @returns {object}
 */
function makeClient(config, chainKey) {
  return createClient({
    url: rpcUrlFor(config, chainKey),
    fallbackUrl: fallbackUrlFor(config, chainKey),
    concurrency: config.concurrency,
    cache: config.rpcCache ? getRpcCache(chainKey) : null,
  });
}

module.exports = { makeClient };
