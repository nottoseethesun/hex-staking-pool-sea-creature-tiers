/**
 * @file src/config.js
 * @description Runtime configuration: shipped defaults from config/tuning.json,
 * config/server.json, and config/chains.json, with `.env` (via dotenv)
 * overriding the environment-facing values. `loadConfig(env)` is pure over its
 * `env` argument so tests can pass a mock environment; `config` is the default
 * instance. Deeper tunables (retry, trace-chunk, batch sizes, evidence cap) live
 * in config/tuning.json and are read directly by the modules that use them.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");
const { CHAINS } = require("./chain/constants");
const tuning = require("../config/tuning.json");
const serverCfg = require("../config/server.json");

dotenv.config();

/** Template placeholder in config/secrets.example.json (treated as "unset"). */
const ANKR_KEY_PLACEHOLDER = "YOUR_ANKR_ETH_API_KEY";

/**
 * Load the gitignored local secrets file (config/secrets.json), or {} when it
 * is absent or unreadable. Copy config/secrets.example.json to create it.
 * @returns {Record<string, string>}
 */
function loadSecrets() {
  try {
    const file = path.join(__dirname, "..", "config", "secrets.json");
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

/**
 * Build the Ankr Ethereum RPC endpoint from an API key, or null when the key is
 * missing or still the template placeholder. The key is a secret, so it lives
 * only in the gitignored secrets file — never in tracked config or logs.
 * @param {string | undefined} key
 * @returns {string | null}
 */
function ankrEthUrlFromKey(key) {
  if (!key || key === ANKR_KEY_PLACEHOLDER) return null;
  return `https://rpc.ankr.com/eth/${key}`;
}

const secrets = loadSecrets();

/**
 * Parse a positive-integer env value, falling back to `dflt`.
 * @param {string | undefined} value
 * @param {number} dflt
 * @returns {number}
 */
function intOr(value, dflt) {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

/**
 * Parse a fraction env value in (0, 1], falling back to `dflt`.
 * @param {string | undefined} value
 * @param {number} dflt
 * @returns {number}
 */
function fractionOr(value, dflt) {
  const n = Number.parseFloat(value ?? "");
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : dflt;
}

/**
 * Build the config object from an environment map.
 * @param {Record<string, string | undefined>} [env]
 * @returns {object}
 */
function loadConfig(env = process.env) {
  return {
    ethRpcUrl: env.ETH_RPC_URL || CHAINS.eth.defaultRpc,
    ethRpcFallback:
      env.ETH_RPC_URL_FALLBACK ||
      ankrEthUrlFromKey(secrets.ankrEthApiKey) ||
      CHAINS.eth.fallbackRpc ||
      null,
    plsRpcUrl: env.PLS_RPC_URL || CHAINS.pls.defaultRpc,
    plsRpcFallback: env.PLS_RPC_URL_FALLBACK || CHAINS.pls.fallbackRpc || null,
    port: intOr(env.PORT, serverCfg.port),
    host: env.HOST || serverCfg.host,
    concurrency: intOr(env.CONCURRENCY, tuning.concurrency),
    tipLagBlocks: intOr(env.TIP_LAG_BLOCKS, tuning.tipLagBlocks),
    ethLogChunk: intOr(env.ETH_LOG_CHUNK, CHAINS.eth.defaultLogChunk),
    plsLogChunk: intOr(env.PLS_LOG_CHUNK, CHAINS.pls.defaultLogChunk),
    oaMaxHops: intOr(env.OA_MAX_HOPS, tuning.oaMaxHops),
    oaFundingThreshold: fractionOr(
      env.OA_FUNDING_THRESHOLD,
      tuning.oaFundingThreshold,
    ),
    rpcCache: env.RPC_CACHE === "1" || env.RPC_CACHE === "true",
  };
}

/**
 * Resolve the RPC URL for a chain key from a config object.
 * @param {object} cfg
 * @param {"eth" | "pls"} chainKey
 * @returns {string}
 */
function rpcUrlFor(cfg, chainKey) {
  return chainKey === "eth" ? cfg.ethRpcUrl : cfg.plsRpcUrl;
}

/**
 * Resolve the starting eth_getLogs chunk size for a chain key.
 * @param {object} cfg
 * @param {"eth" | "pls"} chainKey
 * @returns {number}
 */
function logChunkFor(cfg, chainKey) {
  return chainKey === "eth" ? cfg.ethLogChunk : cfg.plsLogChunk;
}

/**
 * Resolve the backup RPC URL for a chain key (or null if none).
 * @param {object} cfg
 * @param {"eth" | "pls"} chainKey
 * @returns {string|null}
 */
function fallbackUrlFor(cfg, chainKey) {
  return chainKey === "eth" ? cfg.ethRpcFallback : cfg.plsRpcFallback;
}

module.exports = {
  loadConfig,
  rpcUrlFor,
  logChunkFor,
  fallbackUrlFor,
  ankrEthUrlFromKey,
  loadSecrets,
  config: loadConfig(),
};
