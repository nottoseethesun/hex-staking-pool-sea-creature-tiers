/**
 * @file src/rpc/client.js
 * @description Polite JSON-RPC client over ethers with per-chain endpoint
 * failover. Requests run under bounded concurrency; on a transient error
 * (429 / 5xx / timeout / network) the client rotates to the chain's backup
 * endpoint, then back to the primary, and so on — with exponential backoff +
 * jitter and a warning log per failure. Retry count, base delay, and endpoints
 * come from config/tuning.json + config/chains.json. Size errors ("too many
 * results") are NOT retried here — adaptive getLogs chunking handles those.
 * Optional response caching is provided by rpc/cache.js.
 */

"use strict";

const crypto = require("crypto");
const { JsonRpcProvider } = require("ethers");
const { log } = require("../log");
const tuning = require("../../config/tuning.json");

/** ethers error codes that are transient (worth failing over / retrying). */
const RETRY_CODES = new Set([
  "SERVER_ERROR",
  "TIMEOUT",
  "NETWORK_ERROR",
  "UNKNOWN_ERROR",
]);

// Transient errors only. Size errors ("too many results", "more than N results")
// are NOT here — those are handled by adaptive getLogs chunking.
const RETRY_MSG =
  /rate limit|too many requests|timeout|econnreset|etimedout|socket hang up|502|503|504/i;

// Size / range errors — the endpoint says the getLogs window is too large.
// These are handled by shrinking the window (adaptive chunking), never by retry
// or failover. The real message often hides in the nested JSON-RPC error.
const SIZE_MSG =
  /exceeds .*limit|narrow your filter|too many results|more than .* results|response size|result set too large|block range|payload too large/i;

const MAX_BACKOFF_EXP = 6;

/**
 * Combine an error's messages (including the nested JSON-RPC error) into one
 * searchable string.
 * @param {any} err
 * @returns {string}
 */
function errorText(err) {
  if (!err) return "";
  const parts = [err.message, err.shortMessage];
  if (err.error) parts.push(err.error.message);
  if (err.info && err.info.error) parts.push(err.info.error.message);
  return parts.filter(Boolean).join(" | ");
}

/**
 * True if the error means the getLogs window is too large (shrink + retry, not
 * fail over).
 * @param {any} err
 * @returns {boolean}
 */
function isChunkError(err) {
  return SIZE_MSG.test(errorText(err));
}

/**
 * Build a static-network provider (avoids repeated chainId probes).
 * @param {string} url
 * @returns {import('ethers').JsonRpcProvider}
 */
function buildProvider(url) {
  return new JsonRpcProvider(url, undefined, { staticNetwork: true });
}

/**
 * Build the ordered endpoint list (primary first, fallback next).
 * @param {string} url
 * @param {string|null} fallbackUrl
 * @returns {{ name: string, rpc: object }[]}
 */
function buildProviders(url, fallbackUrl) {
  const list = [{ name: url, rpc: buildProvider(url) }];
  if (fallbackUrl) {
    list.push({ name: fallbackUrl, rpc: buildProvider(fallbackUrl) });
  }
  return list;
}

/**
 * Whether an error is a transient failure worth failing over / retrying.
 * @param {any} err
 * @returns {boolean}
 */
function isRetryable(err) {
  if (!err) return false;
  if (isChunkError(err)) return false;
  const raw = err.status ?? err.info?.responseStatus;
  const status =
    typeof raw === "number"
      ? raw
      : Number((String(raw).match(/\d{3}/) || [])[0]);
  if (Number.isFinite(status)) {
    if (status === 429) return true;
    if (status >= 400 && status < 500) return false;
    if (status >= 500) return true;
  }
  if (RETRY_CODES.has(err.code)) return true;
  return RETRY_MSG.test(errorText(err));
}

/**
 * Resolve after `ms` milliseconds.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Short host label for logs.
 * @param {string} u
 * @returns {string}
 */
function shortUrl(u) {
  try {
    return new URL(u).host;
  } catch {
    return u;
  }
}

/**
 * A FIFO concurrency limiter. `schedule(fn)` runs `fn` when a slot is free.
 * @param {number} max
 * @returns {(fn: () => Promise<any>) => Promise<any>}
 */
function createLimiter(max) {
  let active = 0;
  const queue = [];
  const pump = () => {
    while (active < max && queue.length > 0) {
      const task = queue.shift();
      active += 1;
      task();
    }
  };
  return function schedule(fn) {
    return new Promise((resolve, reject) => {
      queue.push(() => {
        fn()
          .then(resolve, reject)
          .finally(() => {
            active -= 1;
            pump();
          });
      });
      pump();
    });
  };
}

/**
 * Run `fn(provider)`, rotating through endpoints on transient errors with
 * exponential backoff + jitter. Non-transient errors rethrow immediately.
 * @param {(rpc: object) => Promise<any>} fn
 * @param {{ name: string, rpc: object }[]} providers
 * @returns {Promise<any>}
 */
async function callWithFailover(fn, providers) {
  const maxAttempts = Math.max(tuning.retryAttempts, providers.length);
  let attempt = 0;
  for (;;) {
    const entry = providers[attempt % providers.length];
    try {
      return await fn(entry.rpc);
    } catch (err) {
      if (isChunkError(err)) throw err; // caller shrinks the getLogs window
      attempt += 1;
      const triedAll = attempt >= providers.length;
      if (attempt >= maxAttempts || (!isRetryable(err) && triedAll)) throw err;
      log.warn(
        "[rpc] %s failed (attempt %d/%d): %s",
        shortUrl(entry.name),
        attempt,
        maxAttempts,
        err.message,
      );
      const exp = Math.min(attempt - 1, MAX_BACKOFF_EXP);
      const backoff = tuning.retryBaseMs * 2 ** exp;
      await sleep(backoff + crypto.randomInt(0, tuning.retryBaseMs));
    }
  }
}

/**
 * Reduce an ethers log to the fields the decoders use (topics, data, block,
 * txHash) — smaller and JSON-safe for the optional RPC cache.
 * @param {any} logEntry
 * @returns {object}
 */
function minimalLog(logEntry) {
  return {
    topics: logEntry.topics,
    data: logEntry.data,
    blockNumber: logEntry.blockNumber,
    transactionHash: logEntry.transactionHash,
  };
}

/**
 * Create a guarded, failover-capable RPC client. When `cache` is provided,
 * getCode / getLogs / send responses are memoized (getBlockNumber never is —
 * the tip must stay fresh). `providers` may be injected for tests.
 * @param {{ url: string, fallbackUrl?: string|null, concurrency?: number, cache?: object|null, providers?: object[]|null }} opts
 * @returns {object}
 */
function createClient(opts) {
  const { url, fallbackUrl = null, concurrency = 4, cache = null } = opts;
  const providers = opts.providers ?? buildProviders(url, fallbackUrl);
  const limit = createLimiter(concurrency);
  const call = (fn) => limit(() => callWithFailover(fn, providers));
  const cached = (key, fn) => {
    if (!cache) return fn();
    if (cache.has(key)) return Promise.resolve(cache.get(key));
    return fn().then((value) => {
      cache.set(key, value);
      return value;
    });
  };
  return {
    providers,
    url,
    getBlockNumber: () => call((rpc) => rpc.getBlockNumber()),
    getCode: (addr, block) =>
      cached(`getCode:${addr}:${block ?? "latest"}`, () =>
        call((rpc) => rpc.getCode(addr, block)),
      ),
    getLogs: (filter) =>
      cached(`getLogs:${JSON.stringify(filter)}`, () =>
        call((rpc) => rpc.getLogs(filter)).then((logs) => logs.map(minimalLog)),
      ),
    send: (method, params) =>
      cached(`send:${method}:${JSON.stringify(params)}`, () =>
        call((rpc) => rpc.send(method, params)),
      ),
  };
}

module.exports = {
  createClient,
  buildProvider,
  buildProviders,
  createLimiter,
  callWithFailover,
  isRetryable,
  isChunkError,
  errorText,
  minimalLog,
  sleep,
};
