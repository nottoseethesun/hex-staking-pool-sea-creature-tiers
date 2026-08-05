/**
 * @file src/rpc/trace-preflight.js
 * @description Startup preflight: probe every configured RPC URL for each chain
 * and confirm at least `config.tracePreflightMin` support `trace_filter` over a
 * historical (archive) block — the capability the OA stage depends on. If a chain
 * falls short, `enforceTracePreflight` prints an informative report and exits, so
 * the app never starts a scan that would stall on an endpoint that cannot serve
 * it. `TRACE_PREFLIGHT=0` skips the check (offline / view-only use). The probe is
 * reused from utils/check-trace-support and is injectable for tests.
 */

"use strict";

const {
  probe: defaultProbe,
  DEFAULT_ARCHIVE_BLOCK,
} = require("../../utils/check-trace-support");
const tuning = require("../../config/tuning.json");
const { effectiveRpcUrls } = require("../config");

const CHAINS = ["eth", "pls"];

/**
 * A one-line reason string for a probe verdict — distinguishing "no trace_filter"
 * from "not an archive node" from an "unreachable" endpoint.
 * @param {{ ok: boolean, trace: string, archive: string }} r
 * @returns {string}
 */
function reasonOf(r) {
  if (r.ok) return "trace_filter + archive";
  if (r.trace !== "supported") return `no trace_filter (${r.trace})`;
  return `not archive (${r.archive})`;
}

/**
 * Probe one URL, retrying once on a transient "unreachable" result.
 * @param {Function} probe
 * @param {string} url
 * @param {object} opts
 * @returns {Promise<object>} the probe verdict
 */
async function probeWithRetry(probe, url, opts) {
  let last;
  for (let i = 0; i <= 1; i += 1) {
    last = await probe(url, opts);
    if (last.ok || !String(last.trace).startsWith("unreachable")) return last;
  }
  return last;
}

/**
 * Probe every configured RPC per chain and report which are trace-capable.
 * @param {object} config
 * @param {{ probe?: Function }} [deps] injectable probe (tests)
 * @returns {Promise<{ ok: boolean, min: number, perChain: object }>}
 */
async function runPreflight(config, deps = {}) {
  const probe = deps.probe ?? defaultProbe;
  const opts = {
    archiveBlock: DEFAULT_ARCHIVE_BLOCK,
    timeoutMs: tuning.traceProbeTimeoutMs,
  };
  const min = config.tracePreflightMin;
  const perChain = {};
  let ok = true;
  for (const chainKey of CHAINS) {
    const results = [];
    for (const url of effectiveRpcUrls(config, chainKey)) {
      const r = await probeWithRetry(probe, url, opts);
      results.push({ url, ok: r.ok, reason: reasonOf(r) });
    }
    const capableCount = results.filter((r) => r.ok).length;
    perChain[chainKey] = { min, capableCount, results };
    if (capableCount < min) ok = false;
  }
  return { ok, min, perChain };
}

/**
 * Render a preflight result as an indented, human-readable report.
 * @param {object} result runPreflight() output
 * @returns {string}
 */
function formatPreflight(result) {
  const lines = [];
  for (const chainKey of CHAINS) {
    const c = result.perChain[chainKey];
    lines.push(
      `  ${chainKey.toUpperCase()}: ${c.capableCount}/${c.min} trace-capable RPC(s)`,
    );
    for (const r of c.results) {
      lines.push(`    ${r.ok ? "ok  " : "--  "}${r.url}  (${r.reason})`);
    }
  }
  return lines.join("\n");
}

/**
 * Run the preflight (unless disabled) and exit the process with an informative
 * message when a chain has fewer than the required trace-capable RPCs.
 * @param {object} config
 * @param {object} log
 * @param {{ probe?: Function, exit?: Function }} [deps] injectable for tests
 * @returns {Promise<boolean>} true when the preflight passed (or was skipped)
 */
async function enforceTracePreflight(config, log, deps = {}) {
  if (!config.tracePreflight) {
    log.info("[preflight] trace_filter check skipped (TRACE_PREFLIGHT=0)");
    return true;
  }
  const exit = deps.exit ?? process.exit;
  const result = await runPreflight(config, deps);
  if (result.ok) {
    log.info(
      "[preflight] OK — >=%d trace-capable RPC(s) per chain",
      result.min,
    );
    return true;
  }
  log.error(
    "[preflight] FAILED — each chain needs >=%d RPC(s) serving trace_filter " +
      "over historical blocks (the OA scan requires it):\n%s\n" +
      "Fix: add RPC URLs via ETH_RPC_URLS / PLS_RPC_URLS (comma-separated), or " +
      "set TRACE_PREFLIGHT=0 to skip this check (view-only, cannot scan).",
    result.min,
    formatPreflight(result),
  );
  exit(1);
  return false;
}

module.exports = {
  runPreflight,
  enforceTracePreflight,
  formatPreflight,
  reasonOf,
};
