"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadConfig, parseUrlList, rpcUrlsFor } = require("../src/config");
const {
  runPreflight,
  enforceTracePreflight,
  formatPreflight,
  reasonOf,
} = require("../src/rpc/trace-preflight");

// --- multi-URL config ---

test("parseUrlList splits on commas/whitespace and trims", () => {
  assert.deepEqual(parseUrlList("a, b\nc  d"), ["a", "b", "c", "d"]);
  assert.equal(parseUrlList(""), null);
  assert.equal(parseUrlList(undefined), null);
  assert.equal(parseUrlList("   "), null);
});

test("loadConfig uses ETH_RPC_URLS as the full list when set", () => {
  const cfg = loadConfig({ ETH_RPC_URLS: "https://a, https://b, https://c" });
  assert.deepEqual(rpcUrlsFor(cfg, "eth"), [
    "https://a",
    "https://b",
    "https://c",
  ]);
  assert.equal(cfg.ethRpcUrl, "https://a"); // primary = first of the list
});

test("loadConfig falls back to [primary, fallback] when no list is set", () => {
  const cfg = loadConfig({
    ETH_RPC_URL: "https://p",
    ETH_RPC_URL_FALLBACK: "https://f",
  });
  assert.deepEqual(rpcUrlsFor(cfg, "eth"), ["https://p", "https://f"]);
});

test("loadConfig honors TRACE_PREFLIGHT / TRACE_PREFLIGHT_MIN", () => {
  assert.equal(loadConfig({}).tracePreflight, true); // on by default
  assert.equal(loadConfig({ TRACE_PREFLIGHT: "0" }).tracePreflight, false);
  assert.equal(loadConfig({ TRACE_PREFLIGHT_MIN: "3" }).tracePreflightMin, 3);
});

// --- preflight ---

const cfg = (min, ethUrls, plsUrls) => ({
  tracePreflight: true,
  tracePreflightMin: min,
  ethRpcUrls: ethUrls,
  plsRpcUrls: plsUrls,
});
const okOr = (url) => ({
  url,
  ok: !url.includes("bad"),
  trace: url.includes("bad") ? "missing" : "supported",
  archive: "full archive",
});

test("runPreflight passes when >= min RPCs per chain are trace-capable", async () => {
  const r = await runPreflight(cfg(2, ["e1", "e2", "e-bad"], ["p1", "p2"]), {
    probe: async (u) => okOr(u),
  });
  assert.equal(r.ok, true);
  assert.equal(r.perChain.eth.capableCount, 2);
  assert.equal(r.perChain.pls.capableCount, 2);
});

test("runPreflight fails a chain with too few trace-capable RPCs", async () => {
  const r = await runPreflight(cfg(2, ["e1", "e2"], ["p-bad", "p1"]), {
    probe: async (u) => okOr(u),
  });
  assert.equal(r.ok, false); // pls: only p1 is capable
  assert.equal(r.perChain.pls.capableCount, 1);
});

test("runPreflight retries a transient unreachable probe", async () => {
  const seen = {};
  const probe = async (url) => {
    seen[url] = (seen[url] ?? 0) + 1;
    return seen[url] === 1 && url === "e1"
      ? { url, ok: false, trace: "unreachable: timeout", archive: "-" }
      : { url, ok: true, trace: "supported", archive: "full archive" };
  };
  const r = await runPreflight(cfg(1, ["e1"], ["p1"]), { probe });
  assert.equal(r.ok, true);
  assert.equal(seen.e1, 2); // retried once and recovered
});

test("reasonOf distinguishes no-trace / not-archive / ok", () => {
  assert.match(reasonOf({ ok: true }), /trace_filter/);
  assert.match(reasonOf({ ok: false, trace: "missing" }), /no trace_filter/);
  assert.match(
    reasonOf({ ok: false, trace: "supported", archive: "recent-only" }),
    /not archive/,
  );
});

test("formatPreflight renders per-chain counts and per-url lines", () => {
  const s = formatPreflight({
    min: 2,
    perChain: {
      eth: {
        min: 2,
        capableCount: 1,
        results: [
          { url: "e1", ok: true, reason: "trace_filter + archive" },
          { url: "e2", ok: false, reason: "no trace_filter (missing)" },
        ],
      },
      pls: {
        min: 2,
        capableCount: 2,
        results: [
          { url: "p1", ok: true, reason: "x" },
          { url: "p2", ok: true, reason: "y" },
        ],
      },
    },
  });
  assert.match(s, /ETH: 1\/2/);
  assert.match(s, /PLS: 2\/2/);
  assert.match(s, /ok {2}e1/);
  assert.match(s, /-- {2}e2/);
});

test("enforceTracePreflight exits(1) with a FAILED report when a chain is short", async () => {
  let exited = null;
  let logged = "";
  const log = { info() {}, error: (...a) => (logged = a.join(" ")) };
  const ok = await enforceTracePreflight(cfg(2, ["e1"], ["p1", "p2"]), log, {
    probe: async (u) => ({
      url: u,
      ok: true,
      trace: "supported",
      archive: "full archive",
    }),
    exit: (code) => (exited = code),
  });
  assert.equal(ok, false);
  assert.equal(exited, 1);
  assert.match(logged, /FAILED/);
});

test("enforceTracePreflight passes without exiting when the min is met", async () => {
  let exited = null;
  const ok = await enforceTracePreflight(
    cfg(1, ["e1"], ["p1"]),
    { info() {}, error() {} },
    {
      probe: async (u) => ({
        url: u,
        ok: true,
        trace: "supported",
        archive: "full archive",
      }),
      exit: (c) => (exited = c),
    },
  );
  assert.equal(ok, true);
  assert.equal(exited, null);
});

test("enforceTracePreflight skips when disabled (TRACE_PREFLIGHT=0)", async () => {
  let called = false;
  const ok = await enforceTracePreflight(
    { tracePreflight: false },
    { info() {} },
    {
      probe: async () => {
        called = true;
        return {};
      },
    },
  );
  assert.equal(ok, true);
  assert.equal(called, false);
});
