#!/usr/bin/env node
/**
 * @file utils/check-trace-support.js
 * @description Standalone probe: does an EVM JSON-RPC endpoint serve
 * `trace_filter` (the Erigon/Nethermind trace API the OA stage depends on), and
 * is it a full archive node (traces available back to old blocks, not only
 * recent ones)? Both matter: the OA inbound scan needs trace_filter over the
 * entire deploy->tip range, so a trace-capable but non-archive node is useless.
 *
 * Portable: uses only Node built-ins (global `fetch` + `node:util` parseArgs),
 * with no dependency on the rest of this repo, so it works against any URL.
 *
 * Usage:
 *   node utils/check-trace-support.js <rpc-url> [more-urls...] \
 *     [--archive-block N] [--timeout MS]
 *
 * Exit code: 0 iff every URL supports trace_filter AND is full archive; 1
 * otherwise (so it composes in shell / CI). 2 on a usage error.
 */

"use strict";

const { parseArgs } = require("node:util");

/** Old block probed for archive depth (exists on both Ethereum and PulseChain). */
const DEFAULT_ARCHIVE_BLOCK = 100000;
/** Blocks behind the tip to probe for method support (clear of the reorg edge). */
const RECENT_LAG = 20;
const DEFAULT_TIMEOUT_MS = 20000;

/**
 * One JSON-RPC call over HTTP(S), returning the parsed `{ result }` or
 * `{ error }`. Rejects on a transport failure, non-JSON body, or timeout.
 * @param {string} url
 * @param {string} method
 * @param {any[]} params
 * @param {number} timeoutMs
 * @returns {Promise<{result?: any, error?: {code:number, message:string}}>}
 */
async function rpc(url, method, params, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal,
    });
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {number} n
 * @returns {string} 0x-prefixed hex block tag
 */
function hexBlock(n) {
  return `0x${n.toString(16)}`;
}

/**
 * True when a JSON-RPC error means the method is absent / not served (as opposed
 * to a transient or parameter error).
 * @param {{code?: number, message?: string}} [err]
 * @returns {boolean}
 */
function isMethodMissing(err) {
  if (!err) return false;
  if (err.code === -32601) return true;
  return /not found|does not exist|not available|not supported|not allowed|unsupported method/i.test(
    err.message || "",
  );
}

/**
 * True when an error means the node lacks the historical state (a full node, not
 * an archive node) rather than lacking the method.
 * @param {{message?: string}} [err]
 * @returns {boolean}
 */
function isNotArchive(err) {
  return /archiv|pruned|historical|missing trie|no state|state (is )?(unavailable|not)/i.test(
    (err && err.message) || "",
  );
}

/**
 * trace_filter over exactly one block (cheapest probe that still exercises the
 * method + the state at that height).
 * @param {string} url
 * @param {number} block
 * @param {number} timeoutMs
 * @returns {Promise<{result?: any, error?: object}>}
 */
function traceAtBlock(url, block, timeoutMs) {
  const tag = hexBlock(block);
  return rpc(
    url,
    "trace_filter",
    [{ fromBlock: tag, toBlock: tag, count: 1 }],
    timeoutMs,
  );
}

/**
 * Determine trace_filter support at a recent block. Returns one of:
 * "supported" | "missing" | "unreachable:<detail>" | "unclear:<detail>".
 * @param {string} url
 * @param {number} timeoutMs
 * @returns {Promise<string>}
 */
async function checkMethod(url, timeoutMs) {
  let tip;
  try {
    const bn = await rpc(url, "eth_blockNumber", [], timeoutMs);
    if (!bn.result) return "unreachable:no eth_blockNumber";
    tip = Number.parseInt(bn.result, 16);
  } catch (e) {
    return `unreachable:${e.code || e.message}`;
  }
  try {
    const r = await traceAtBlock(url, Math.max(0, tip - RECENT_LAG), timeoutMs);
    if (r.result) return "supported";
    if (isMethodMissing(r.error)) return "missing";
    return `unclear:${r.error ? r.error.message : "no result"}`;
  } catch (e) {
    return `unreachable:${e.code || e.message}`;
  }
}

/**
 * Determine archive depth once the method is known to work. Returns:
 * "full archive" | "recent-only (NOT archive)" | "error:<detail>".
 * @param {string} url
 * @param {number} block
 * @param {number} timeoutMs
 * @returns {Promise<string>}
 */
async function checkArchive(url, block, timeoutMs) {
  try {
    const a = await traceAtBlock(url, block, timeoutMs);
    if (a.result) return "full archive";
    if (isNotArchive(a.error)) return "recent-only (NOT archive)";
    return `error:${a.error ? a.error.message : "no result"}`;
  } catch (e) {
    return `error:${e.code || e.message}`;
  }
}

/**
 * Probe one endpoint end to end.
 * @param {string} url
 * @param {{archiveBlock:number, timeoutMs:number}} opts
 * @returns {Promise<{url:string, trace:string, archive:string, ok:boolean}>}
 */
async function probe(url, opts) {
  const method = await checkMethod(url, opts.timeoutMs);
  if (method !== "supported") {
    return { url, trace: method, archive: "-", ok: false };
  }
  const archive = await checkArchive(url, opts.archiveBlock, opts.timeoutMs);
  return { url, trace: "supported", archive, ok: archive === "full archive" };
}

/**
 * Probe every URL, returning the verdicts and whether all passed. Free of
 * process side effects (no printing / exit) so it is unit-testable and reusable
 * (the startup trace preflight calls `probe` directly).
 * @param {string[]} urls
 * @param {{archiveBlock:number, timeoutMs:number}} opts
 * @returns {Promise<{ results: object[], allOk: boolean }>}
 */
async function run(urls, opts) {
  const results = [];
  let allOk = true;
  for (const url of urls) {
    const v = await probe(url, opts);
    if (!v.ok) allOk = false;
    results.push(v);
  }
  return { results, allOk };
}

/**
 * CLI entry: probe each URL, print a verdict per line, exit non-zero if any URL
 * is not a full-archive trace_filter provider.
 * @returns {Promise<void>}
 */
async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      "archive-block": { type: "string" },
      timeout: { type: "string" },
    },
  });
  if (positionals.length === 0) {
    process.stderr.write(
      "Usage: node utils/check-trace-support.js <rpc-url> [more-urls...] " +
        "[--archive-block N] [--timeout MS]\n",
    );
    process.exit(2);
  }
  const opts = {
    archiveBlock:
      Number.parseInt(values["archive-block"] ?? "", 10) ||
      DEFAULT_ARCHIVE_BLOCK,
    timeoutMs: Number.parseInt(values.timeout ?? "", 10) || DEFAULT_TIMEOUT_MS,
  };
  const { results, allOk } = await run(positionals, opts);
  for (const v of results) {
    process.stdout.write(
      `${v.ok ? "✓" : "✗"} ${v.url}\n` +
        `    trace_filter: ${v.trace}  |  archive: ${v.archive}\n`,
    );
  }
  process.exit(allOk ? 0 : 1);
}

module.exports = {
  hexBlock,
  isMethodMissing,
  isNotArchive,
  checkMethod,
  checkArchive,
  probe,
  run,
  DEFAULT_ARCHIVE_BLOCK,
  DEFAULT_TIMEOUT_MS,
};

if (require.main === module) {
  main().catch((e) => {
    process.stderr.write(`fatal: ${e.message}\n`);
    process.exit(2);
  });
}
