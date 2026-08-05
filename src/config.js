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
const holder = require("./secrets/holder");

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
 * Parse a whitespace/comma-separated list of RPC URLs, or null when unset/empty.
 * @param {string | undefined} value
 * @returns {string[] | null}
 */
function parseUrlList(value) {
  if (!value) return null;
  const urls = value
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return urls.length ? urls : null;
}

/**
 * Build the config object from an environment map.
 * @param {Record<string, string | undefined>} [env]
 * @returns {object}
 */
function loadConfig(env = process.env) {
  const ethPrimary = env.ETH_RPC_URL || CHAINS.eth.defaultRpc;
  const ethFallback =
    env.ETH_RPC_URL_FALLBACK ||
    ankrEthUrlFromKey(secrets.ankrEthApiKey) ||
    CHAINS.eth.fallbackRpc ||
    null;
  const plsPrimary = env.PLS_RPC_URL || CHAINS.pls.defaultRpc;
  const plsFallback =
    env.PLS_RPC_URL_FALLBACK || CHAINS.pls.fallbackRpc || null;
  const ethRpcUrls =
    parseUrlList(env.ETH_RPC_URLS) || [ethPrimary, ethFallback].filter(Boolean);
  const plsRpcUrls =
    parseUrlList(env.PLS_RPC_URLS) || [plsPrimary, plsFallback].filter(Boolean);
  return {
    ethRpcUrl: ethRpcUrls[0],
    ethRpcFallback: ethFallback,
    ethRpcUrls,
    plsRpcUrl: plsRpcUrls[0],
    plsRpcFallback: plsFallback,
    plsRpcUrls,
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
    tracePreflight: !(
      env.TRACE_PREFLIGHT === "0" || env.TRACE_PREFLIGHT === "false"
    ),
    tracePreflightMin: intOr(env.TRACE_PREFLIGHT_MIN, tuning.tracePreflightMin),
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
 * Resolve the ordered RPC URL list for a chain key (primary first).
 * @param {object} cfg
 * @param {"eth" | "pls"} chainKey
 * @returns {string[]}
 */
function rpcUrlsFor(cfg, chainKey) {
  return chainKey === "eth" ? cfg.ethRpcUrls : cfg.plsRpcUrls;
}

/**
 * The RPC URLs a chain should actually use: any unlocked secret RPC URLs for the
 * chain FIRST, in order, then the configured list, de-duplicated. The vault holds
 * up to three keyed Moralis node URLs (`<chain>Rpc1..3`) and up to three generic,
 * key-free node URLs (`<chain>Generic1..3`); Moralis (trace-capable) come first.
 * Runtime — it reflects whatever the current session has unlocked.
 * @param {object} cfg
 * @param {"eth" | "pls"} chainKey
 * @returns {string[]}
 */
function effectiveRpcUrls(cfg, chainKey) {
  const names = [];
  for (let i = 1; i <= 3; i += 1) names.push(`${chainKey}Rpc${i}`);
  for (let i = 1; i <= 3; i += 1) names.push(`${chainKey}Generic${i}`);
  const secrets = names.map((n) => holder.get(n)).filter(Boolean);
  return [...new Set([...secrets, ...rpcUrlsFor(cfg, chainKey)])];
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

/**
 * A one-line human summary of the effective config for the startup log — real
 * facts only (port, and the CONFIGURED RPC count per chain). Vault-unlocked RPC
 * URLs are runtime, so they aren't counted here.
 * @param {object} cfg loadConfig() result
 * @returns {string}
 */
function describeConfig(cfg) {
  return (
    `chains eth+pls, port ${cfg.port}, ` +
    `ETH RPC(s): ${cfg.ethRpcUrls.length}, PLS RPC(s): ${cfg.plsRpcUrls.length}`
  );
}

module.exports = {
  loadConfig,
  describeConfig,
  rpcUrlFor,
  rpcUrlsFor,
  effectiveRpcUrls,
  logChunkFor,
  fallbackUrlFor,
  ankrEthUrlFromKey,
  parseUrlList,
  loadSecrets,
  config: loadConfig(),
};
