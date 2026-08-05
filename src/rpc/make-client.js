/**
 * @file src/rpc/make-client.js
 * @description Single place that builds a guarded RPC client for a chain from
 * config — shared by the CLI and the update pipeline so the wiring is not
 * duplicated.
 */

"use strict";

const { createClient } = require("./client");
const { getRpcCache } = require("./cache");
const { effectiveRpcUrls } = require("../config");

/**
 * Build a guarded RPC client for a chain from config. When `config.rpcCache` is
 * set (RPC_CACHE=1), responses are memoized to disk so re-runs skip the RPC.
 * @param {object} config
 * @param {"eth"|"pls"} chainKey
 * @returns {object}
 */
function makeClient(config, chainKey) {
  return createClient({
    urls: effectiveRpcUrls(config, chainKey),
    concurrency: config.concurrency,
    cache: config.rpcCache ? getRpcCache(chainKey) : null,
  });
}

/**
 * Build a POOL of guarded clients — one per configured RPC URL, each pinned to a
 * single endpoint with its own adaptive limiter + unsupported-method set. The OA
 * wallet sweep shards its independent per-address batches across the pool for a
 * near-linear speedup; with one URL the pool has one client (no sharding).
 * @param {object} config
 * @param {"eth"|"pls"} chainKey
 * @returns {object[]}
 */
function makeClientPool(config, chainKey) {
  const cache = config.rpcCache ? getRpcCache(chainKey) : null;
  return effectiveRpcUrls(config, chainKey).map((url) =>
    createClient({ urls: [url], concurrency: config.concurrency, cache }),
  );
}

module.exports = { makeClient, makeClientPool };
