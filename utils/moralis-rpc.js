#!/usr/bin/env node
/**
 * @file utils/moralis-rpc.js
 * @description Standalone diagnostic for a Moralis (or any EVM) JSON-RPC endpoint:
 * send one method, or run a suite of the methods THIS tool relies on, and report
 * which the endpoint actually serves.
 *
 * It exists because Moralis RPC nodes reject an unsupported method with a
 * NON-JSON-RPC shape — an HTTP 400 whose body is a top-level `{ code, message }`
 * (e.g. `'trace_filter' is not supported on chain eth`) rather than a JSON-RPC
 * `{ error }`. A naive probe that only reads `result`/`error` sees neither and
 * reports an empty result; this utility normalizes that so "not supported" is
 * reported plainly. (Verified: Moralis serves no `trace_*`/`debug_trace*` on eth
 * or pulse, so its nodes can't drive the OA scan — use them as generic, non-trace
 * nodes and add a trace-capable archive RPC for the OA stage.)
 *
 * Portable: Node built-ins only (global `fetch` + `node:util` parseArgs); no repo
 * imports, so it runs against any URL.
 *
 * Usage:
 *   node utils/moralis-rpc.js <rpc-url> [more-urls...] [--timeout MS]
 *   node utils/moralis-rpc.js <rpc-url> --method eth_blockNumber
 *   node utils/moralis-rpc.js <rpc-url> --method trace_filter \
 *     --params '[{"fromBlock":"0x1","toBlock":"0x1","count":1}]'
 *
 * No --method runs the suite and exits `0` iff every URL serves `trace_filter`
 * (what the OA scan needs), else `1`. With --method it exits `0` iff the call
 * succeeded on every URL. `2` on a usage error.
 *
 * SECURITY: a Moralis URL embeds an API key. Don't paste this tool's output (it
 * echoes the URL) into a shared log or issue.
 */

"use strict";

const { parseArgs } = require("node:util");

const DEFAULT_TIMEOUT_MS = 20000;
/** A well-known burn address, used as a harmless `eth_getBalance` target. */
const BURN_ADDRESS = "0x000000000000000000000000000000000000dEaD";

/**
 * @param {number} n
 * @returns {string} 0x-prefixed hex block tag
 */
function hexBlock(n) {
  return `0x${n.toString(16)}`;
}

/**
 * True when an error means the method is absent / not served (vs. a transient or
 * parameter error). Matches both JSON-RPC -32601 and provider phrasings like
 * Moralis's "not supported on chain …".
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
 * Fold an HTTP response + parsed body into `{ result }` or `{ error }`. Handles
 * three shapes: a JSON-RPC `{ error }`, a non-JSON-RPC rejection (HTTP 4xx/5xx, or
 * a top-level `{ code, message }` with no `result` — the Moralis case), and a
 * normal `{ result }` (including a legitimate `result: null`).
 * @param {{ ok: boolean, status: number }} res
 * @param {any} body parsed JSON body (or null on a non-JSON body)
 * @returns {{ status: number, result?: any, error?: {code:any, message:string} }}
 */
function normalize(res, body) {
  if (body && body.error) return { status: res.status, error: body.error };
  if (!res.ok || (body && body.result === undefined && body.message)) {
    return {
      status: res.status,
      error: {
        code: (body && body.code) ?? res.status,
        message: (body && body.message) || `HTTP ${res.status}`,
      },
    };
  }
  return { status: res.status, result: body ? body.result : undefined };
}

/**
 * One JSON-RPC call. Returns a normalized `{ result }` / `{ error }`, or
 * `{ transport }` on a network failure or timeout (never throws).
 * @param {string} url
 * @param {string} method
 * @param {any[]} params
 * @param {{ timeoutMs?: number, fetchImpl?: Function }} [opts] `fetchImpl` is a
 *   seam for tests; production uses global `fetch`.
 * @returns {Promise<object>}
 */
async function rpc(url, method, params, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const doFetch = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await doFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal,
    });
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return normalize(res, body);
  } catch (e) {
    return {
      transport:
        e.name === "AbortError"
          ? `timeout after ${timeoutMs}ms`
          : e.code || e.message,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A short, human description of a JSON-RPC result value (for the report).
 * @param {any} r
 * @returns {string}
 */
function describeResult(r) {
  if (r === undefined) return "(no result)";
  if (r === null) return "null";
  if (Array.isArray(r)) return `array(${r.length})`;
  if (typeof r === "object") return `object{${Object.keys(r).length} keys}`;
  const s = String(r);
  return s.length > 44 ? `${s.slice(0, 44)}…` : s;
}

/**
 * Classify a normalized rpc() response into a verdict for the report.
 * @param {object} resp result of rpc()
 * @returns {{ ok: boolean, label: string, detail: string }}
 */
function classify(resp) {
  if (resp.transport) {
    return { ok: false, label: "unreachable", detail: resp.transport };
  }
  if (resp.error) {
    const label = isMethodMissing(resp.error) ? "not supported" : "error";
    return {
      ok: false,
      label,
      detail: `${resp.error.code ?? "?"}: ${resp.error.message || ""}`.trim(),
    };
  }
  return { ok: true, label: "supported", detail: describeResult(resp.result) };
}

/**
 * The default suite: the methods this tool depends on, with params anchored at a
 * recent block so they exercise real state.
 * @param {number} tip current head block number
 * @returns {{ method: string, params: any[] }[]}
 */
function suiteCalls(tip) {
  const recent = hexBlock(Math.max(0, tip - 1000));
  return [
    { method: "eth_chainId", params: [] },
    { method: "eth_blockNumber", params: [] },
    { method: "eth_getBlockByNumber", params: [recent, false] },
    { method: "eth_getBalance", params: [BURN_ADDRESS, recent] },
    { method: "eth_getLogs", params: [{ fromBlock: recent, toBlock: recent }] },
    {
      method: "trace_filter",
      params: [{ fromBlock: recent, toBlock: recent, count: 1 }],
    },
    { method: "trace_block", params: [recent] },
    {
      method: "debug_traceBlockByNumber",
      params: [recent, { tracer: "callTracer" }],
    },
  ];
}

/**
 * Run the default suite against one URL.
 * @param {string} url
 * @param {{ timeoutMs?: number, fetchImpl?: Function }} [opts]
 * @returns {Promise<{ url:string, reachable:boolean, reason?:string, tip?:number,
 *   calls: object[], traceOk: boolean }>}
 */
async function runSuite(url, opts = {}) {
  const bn = await rpc(url, "eth_blockNumber", [], opts);
  if (bn.result === undefined) {
    return {
      url,
      reachable: false,
      reason: classify(bn).detail,
      calls: [],
      traceOk: false,
    };
  }
  const tip = Number.parseInt(bn.result, 16);
  const calls = [];
  for (const { method, params } of suiteCalls(tip)) {
    calls.push({ method, ...classify(await rpc(url, method, params, opts)) });
  }
  const traceOk = calls.some((c) => c.method === "trace_filter" && c.ok);
  return { url, reachable: true, tip, calls, traceOk };
}

/**
 * Format a runSuite() result as a block of report lines.
 * @param {object} r
 * @returns {string}
 */
function formatSuite(r) {
  if (!r.reachable) return `${r.url}\n  UNREACHABLE — ${r.reason}\n`;
  const lines = [r.url, `  chain tip: ${r.tip}`];
  for (const c of r.calls) {
    lines.push(
      `  ${c.method.padEnd(26)} ${c.ok ? "✓" : "✗"} ${c.label.padEnd(14)} ${c.detail}`,
    );
  }
  lines.push(
    `  → trace_filter (required by the OA scan): ${r.traceOk ? "supported" : "NOT supported"}`,
  );
  return `${lines.join("\n")}\n`;
}

/**
 * `--method` mode: send one arbitrary call to every URL and print the verdict +
 * raw response. Exits 0 iff the call succeeded everywhere.
 * @param {string[]} urls
 * @param {{ method: string, params: any[], timeoutMs: number, fetchImpl?: Function }} cfg
 * @returns {Promise<number>} process exit code
 */
async function runSingle(urls, cfg) {
  const opts = { timeoutMs: cfg.timeoutMs, fetchImpl: cfg.fetchImpl };
  let allOk = true;
  for (const url of urls) {
    const resp = await rpc(url, cfg.method, cfg.params, opts);
    const v = classify(resp);
    if (!v.ok) allOk = false;
    process.stdout.write(
      `${url}\n  ${cfg.method} -> ${v.label}${v.ok ? "" : ` (${v.detail})`}\n` +
        `  raw: ${JSON.stringify(resp)}\n`,
    );
  }
  return allOk ? 0 : 1;
}

/**
 * CLI entry.
 * @returns {Promise<void>}
 */
async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      method: { type: "string" },
      params: { type: "string" },
      timeout: { type: "string" },
    },
  });
  if (positionals.length === 0) {
    process.stderr.write(
      "Usage: node utils/moralis-rpc.js <rpc-url> [more-urls...] " +
        "[--method NAME [--params JSON]] [--timeout MS]\n",
    );
    process.exit(2);
  }
  const timeoutMs =
    Number.parseInt(values.timeout ?? "", 10) || DEFAULT_TIMEOUT_MS;
  if (values.method) {
    let params;
    try {
      params = values.params ? JSON.parse(values.params) : [];
    } catch {
      process.stderr.write("--params must be valid JSON (an array of args).\n");
      process.exit(2);
    }
    process.exit(
      await runSingle(positionals, {
        method: values.method,
        params,
        timeoutMs,
      }),
    );
  }
  let allTrace = true;
  for (const url of positionals) {
    const r = await runSuite(url, { timeoutMs });
    if (!r.traceOk) allTrace = false;
    process.stdout.write(formatSuite(r));
  }
  process.stdout.write(
    "\nNote: the OA scan requires trace_filter. Endpoints that lack it (Moralis " +
      "RPC nodes return HTTP 400 'not supported') still work as generic, " +
      "non-trace nodes for eth_getLogs / eth_call load-spreading.\n",
  );
  process.exit(allTrace ? 0 : 1);
}

module.exports = {
  hexBlock,
  isMethodMissing,
  normalize,
  rpc,
  describeResult,
  classify,
  suiteCalls,
  runSuite,
  formatSuite,
  runSingle,
  DEFAULT_TIMEOUT_MS,
};

if (require.main === module) {
  main().catch((e) => {
    process.stderr.write(`fatal: ${e.message}\n`);
    process.exit(2);
  });
}
