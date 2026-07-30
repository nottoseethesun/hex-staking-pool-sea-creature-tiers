/**
 * @file src/rpc/cache.js
 * @description Optional raw RPC-response cache for the experimental stage. When
 * `RPC_CACHE=1`, getCode / getLogs / send responses are memoized by (method,
 * params) in data/rpc-cache-<chain>.json so a re-run never repeats an RPC call.
 * OFF by default — production relies on the incremental ledger plus the tip / oa
 * / codes caches, and this file can grow large (it holds raw getLogs windows).
 * It is an experimentation aid to avoid burning public-endpoint time.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { DATA_DIR, ensureDir } = require("../cache/store");

/** Flush to disk after this many new entries. */
const FLUSH_EVERY = 50;

/** @param {string} chainKey @returns {string} */
function cachePath(chainKey) {
  return path.join(DATA_DIR, `rpc-cache-${chainKey}.json`);
}

/**
 * Create a file-backed RPC cache with has/get/set/flush.
 * @param {string} file JSON cache path
 * @returns {{ has: Function, get: Function, set: Function, flush: Function }}
 */
function createRpcCache(file) {
  let map;
  try {
    map = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    map = {};
  }
  let dirty = 0;
  const flush = () => {
    if (dirty === 0) return;
    ensureDir(path.dirname(file));
    fs.writeFileSync(file, JSON.stringify(map));
    dirty = 0;
  };
  return {
    has: (key) => Object.hasOwn(map, key),
    get: (key) => map[key],
    set: (key, value) => {
      map[key] = value;
      dirty += 1;
      if (dirty >= FLUSH_EVERY) flush();
    },
    flush,
  };
}

/** Per-chain memoized cache instances (one file, flushed on process exit). */
const CACHES = new Map();

/**
 * Get the shared RPC cache for a chain (creating + registering flush once).
 * @param {string} chainKey
 * @returns {object}
 */
function getRpcCache(chainKey) {
  if (CACHES.has(chainKey)) return CACHES.get(chainKey);
  ensureDir(DATA_DIR);
  const cache = createRpcCache(cachePath(chainKey));
  process.on("exit", cache.flush);
  CACHES.set(chainKey, cache);
  return cache;
}

module.exports = { createRpcCache, getRpcCache, cachePath };
