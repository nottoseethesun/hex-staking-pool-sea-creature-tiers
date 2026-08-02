/**
 * @file src/rpc/client.js
 * @description Polite JSON-RPC client over ethers with per-chain endpoint
 * failover. Requests run under self-tuning bounded concurrency (rpc/limiter.js:
 * the in-flight limit eases down automatically when the endpoint signals
 * overload — 520/5xx/429/timeout — and recovers on sustained success). On a
 * transient error the client rotates to the chain's backup endpoint, then back
 * to the primary, and so on — with exponential backoff + jitter and a warning
 * log per failure. Retry count, base delay, and endpoints come from
 * config/tuning.json + config/chains.json. Size errors ("too many results") are
 * NOT retried here — adaptive getLogs chunking handles those. Optional response
 * caching is provided by rpc/cache.js.
 */

"use strict";

const crypto = require("crypto");
const { JsonRpcProvider } = require("ethers");
const { log } = require("../log");
const tuning = require("../../config/tuning.json");
const { createLimiter, createAdaptiveLimiter } = require("./limiter");

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

/** JSON-RPC error codes meaning "this endpoint will never serve this method". */
const UNSUPPORTED_CODES = new Set([-32601, -32053]);

// Permanent method / authorization rejections: the endpoint lacks the method,
// or the key/plan is not entitled to it (e.g. Ankr rejects trace_filter with
// -32053 "not allowed to access method"; publicnode gates archive behind a
// token). These are dropped per (endpoint, method) for the run — never retried,
// so the retry budget stays on the endpoint that can actually serve the method.
const UNSUPPORTED_MSG =
  /not allowed to access method|method .*(not found|does not exist|is not available|not supported)|unsupported method|requires? .*(token|api key|paid plan|subscription)/i;

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
 * True when the error is a permanent "this endpoint will never serve this
 * method" rejection — method-not-found, key-not-entitled, or needs-a-paid-plan.
 * ethers mislabels these as `UNKNOWN_ERROR` (which `isRetryable` treats as
 * transient), so they must be caught by JSON-RPC code / message. The endpoint is
 * dropped for that method for the rest of the run rather than retried against
 * forever, which would otherwise burn the whole retry budget on a guaranteed
 * failure (the Ankr fallback and trace_filter).
 * @param {any} err
 * @returns {boolean}
 */
function isUnsupportedMethod(err) {
  const code = err && err.error && err.error.code;
  if (typeof code === "number" && UNSUPPORTED_CODES.has(code)) return true;
  return UNSUPPORTED_MSG.test(errorText(err));
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
 * Whether an error is an endpoint-overload signal (HTTP 520/5xx, 429, or a
 * timeout) — the cue for the adaptive limiter to ease concurrency down. A subset
 * of `isRetryable`: it excludes generic network errors that don't imply the
 * server is overwhelmed.
 * @param {any} err
 * @returns {boolean}
 */
function isOverload(err) {
  if (!err) return false;
  const raw = err.status ?? err.info?.responseStatus;
  const status =
    typeof raw === "number"
      ? raw
      : Number((String(raw).match(/\d{3}/) || [])[0]);
  if (status === 429 || (status >= 500 && status < 600)) return true;
  if (err.code === "SERVER_ERROR" || err.code === "TIMEOUT") return true;
  return /rate limit|too many requests|timeout|socket hang up/i.test(
    errorText(err),
  );
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
 * The most specific human-readable message on an error (nested JSON-RPC first).
 * @param {any} err
 * @returns {string}
 */
function jsonRpcMessage(err) {
  return (err.error && err.error.message) || err.shortMessage || err.message;
}

/** No-op congestion controller for callers that don't pass an adaptive limiter. */
const NOOP_CONTROLLER = { onOverload() {}, onSuccess() {} };

/**
 * Run `fn(provider)`, rotating through endpoints on transient errors with
 * exponential backoff + jitter. Non-transient errors rethrow immediately. A
 * provider that permanently rejects the method (see `isUnsupportedMethod`) is
 * dropped from the rotation for that method — recorded in `unsupported`, shared
 * across a client's calls — instead of being retried against forever. This
 * keeps the full retry budget on the endpoint(s) that can actually serve the
 * method (e.g. only the Erigon node serves `trace_filter`; Ankr never can).
 * `controller` (an adaptive limiter) is signalled on each success and on each
 * overload error, so concurrency self-tunes to the endpoint's health.
 * @param {(rpc: object) => Promise<any>} fn
 * @param {{ name: string, rpc: object }[]} providers
 * @param {string} [methodKey] label the (endpoint, method) capability is keyed by
 * @param {Set<string>} [unsupported] set of `${endpoint}|${methodKey}` to skip
 * @param {{ onOverload: Function, onSuccess: Function }} [controller] limiter hooks
 * @returns {Promise<any>}
 */
async function callWithFailover(
  fn,
  providers,
  methodKey = "",
  unsupported = new Set(),
  controller = NOOP_CONTROLLER,
) {
  const usable = () =>
    providers.filter((p) => !unsupported.has(`${p.name}|${methodKey}`));
  const maxAttempts = Math.max(tuning.retryAttempts, providers.length);
  let attempt = 0;
  let lastErr = null;
  for (;;) {
    const pool = usable();
    if (pool.length === 0) {
      throw lastErr || new Error(`no RPC endpoint supports ${methodKey}`);
    }
    const entry = pool[attempt % pool.length];
    try {
      const result = await fn(entry.rpc);
      controller.onSuccess();
      return result;
    } catch (err) {
      if (isChunkError(err)) throw err; // caller shrinks the getLogs window
      lastErr = err;
      if (isUnsupportedMethod(err)) {
        unsupported.add(`${entry.name}|${methodKey}`);
        log.warn(
          "[rpc] %s cannot serve %s — dropping it for this run (%s)",
          shortUrl(entry.name),
          methodKey || "call",
          jsonRpcMessage(err),
        );
        continue; // no attempt or backoff spent; the pool shrinks by one
      }
      attempt += 1;
      const triedAll = attempt >= usable().length;
      if (attempt >= maxAttempts || (!isRetryable(err) && triedAll)) throw err;
      if (isOverload(err)) controller.onOverload();
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
  // Concurrency self-tunes to the endpoint: it eases down on overload
  // (520/5xx/429/timeout) and recovers on sustained success. The configured
  // value is the ceiling; each change is logged so the adjustment is visible.
  const limiter = createAdaptiveLimiter(concurrency, {
    min: tuning.adaptiveMinConcurrency,
    decreaseCooldownMs: tuning.adaptiveDecreaseCooldownMs,
    increaseAfter: tuning.adaptiveIncreaseAfter,
    onChange: (limit, reason) =>
      log.warn(
        "[rpc] %s %s concurrency to %d (%s)",
        shortUrl(url),
        reason === "overload" ? "easing" : "restoring",
        limit,
        reason === "overload" ? "endpoint overloaded" : "recovered",
      ),
  });
  // Per-client, in-memory, never persisted: `${endpoint}|${method}` pairs learned
  // to be permanently unsupported. A client is built fresh per run (see
  // pipeline.runUpdate / makeClient), so these markings always clear on a new run.
  const unsupported = new Set();
  const call = (methodKey, fn) =>
    limiter.schedule(() =>
      callWithFailover(fn, providers, methodKey, unsupported, limiter),
    );
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
    getBlockNumber: () => call("getBlockNumber", (rpc) => rpc.getBlockNumber()),
    getCode: (addr, block) =>
      cached(`getCode:${addr}:${block ?? "latest"}`, () =>
        call("getCode", (rpc) => rpc.getCode(addr, block)),
      ),
    getLogs: (filter) =>
      cached(`getLogs:${JSON.stringify(filter)}`, () =>
        call("getLogs", (rpc) => rpc.getLogs(filter)).then((logs) =>
          logs.map(minimalLog),
        ),
      ),
    send: (method, params) =>
      cached(`send:${method}:${JSON.stringify(params)}`, () =>
        call(method, (rpc) => rpc.send(method, params)),
      ),
  };
}

module.exports = {
  createClient,
  buildProvider,
  buildProviders,
  createLimiter,
  createAdaptiveLimiter,
  callWithFailover,
  isRetryable,
  isChunkError,
  isUnsupportedMethod,
  isOverload,
  errorText,
  minimalLog,
  sleep,
};
