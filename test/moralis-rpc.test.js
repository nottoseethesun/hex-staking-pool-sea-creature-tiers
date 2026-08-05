"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
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
} = require("../utils/moralis-rpc");

/**
 * A fake `fetch` that dispatches on the JSON-RPC method in the request body.
 * @param {Record<string, {ok?:boolean,status?:number,body:any}>} byMethod
 */
function fakeFetch(byMethod) {
  return async (_url, init) => {
    const { method } = JSON.parse(init.body);
    const spec = byMethod[method] ?? byMethod.default;
    if (spec.throw)
      throw Object.assign(new Error(spec.throw), { code: spec.throw });
    const status = spec.status ?? 200;
    return { ok: spec.ok ?? status < 400, status, json: async () => spec.body };
  };
}

/** A Moralis-like endpoint: eth_ methods work; trace_ and debug_ return HTTP 400. */
function moralisFetch() {
  return async (_url, init) => {
    const { method } = JSON.parse(init.body);
    if (/^trace_|^debug_/.test(method)) {
      return {
        ok: false,
        status: 400,
        json: async () => ({
          code: 400,
          message: `'${method}' is not supported on chain eth`,
        }),
      };
    }
    const results = {
      eth_blockNumber: "0x7d0",
      eth_chainId: "0x1",
      eth_getBalance: "0x0",
      eth_getBlockByNumber: { number: "0x3e8" },
      eth_getLogs: [],
    };
    return {
      ok: true,
      status: 200,
      json: async () => ({ result: results[method] ?? "0x0" }),
    };
  };
}

test("hexBlock + describeResult format values", () => {
  assert.equal(hexBlock(1000), "0x3e8");
  assert.equal(describeResult(undefined), "(no result)");
  assert.equal(describeResult(null), "null");
  assert.equal(describeResult([1, 2, 3]), "array(3)");
  assert.equal(describeResult({ a: 1, b: 2 }), "object{2 keys}");
  assert.equal(describeResult("0x1"), "0x1");
  assert.equal(describeResult("x".repeat(60)).endsWith("…"), true);
});

test("isMethodMissing matches -32601 and 'not supported' phrasings", () => {
  assert.equal(isMethodMissing({ code: -32601, message: "x" }), true);
  assert.equal(
    isMethodMissing({ code: 400, message: "'trace_filter' is not supported" }),
    true,
  );
  assert.equal(
    isMethodMissing({ code: -32000, message: "execution reverted" }),
    false,
  );
  assert.equal(isMethodMissing(undefined), false);
});

test("normalize folds JSON-RPC, Moralis-400, and normal shapes", () => {
  // JSON-RPC { error }
  assert.deepEqual(
    normalize(
      { ok: true, status: 200 },
      { error: { code: -32601, message: "no" } },
    ),
    {
      status: 200,
      error: { code: -32601, message: "no" },
    },
  );
  // Moralis: HTTP 400 + top-level { code, message } (no result, no error)
  const m = normalize(
    { ok: false, status: 400 },
    { code: 400, message: "not supported" },
  );
  assert.deepEqual(m, {
    status: 400,
    error: { code: 400, message: "not supported" },
  });
  // Normal result — including a legitimate result:null (NOT an error)
  assert.deepEqual(normalize({ ok: true, status: 200 }, { result: "0x1" }), {
    status: 200,
    result: "0x1",
  });
  assert.deepEqual(normalize({ ok: true, status: 200 }, { result: null }), {
    status: 200,
    result: null,
  });
});

test("classify labels transport, not-supported, error, and supported", () => {
  assert.equal(classify({ transport: "ECONNREFUSED" }).label, "unreachable");
  assert.equal(
    classify({ error: { code: 400, message: "not supported" } }).label,
    "not supported",
  );
  assert.equal(
    classify({ error: { code: -32000, message: "reverted" } }).label,
    "error",
  );
  const ok = classify({ result: [] });
  assert.equal(ok.ok, true);
  assert.equal(ok.detail, "array(0)");
});

test("rpc normalizes a Moralis 400 into a not-supported verdict", async () => {
  const resp = await rpc("http://x", "trace_filter", [{}], {
    fetchImpl: moralisFetch(),
  });
  assert.equal(classify(resp).label, "not supported");
  assert.match(resp.error.message, /not supported on chain eth/);
});

test("rpc returns a result on success and a transport verdict on failure", async () => {
  const good = await rpc("http://x", "eth_blockNumber", [], {
    fetchImpl: fakeFetch({ eth_blockNumber: { body: { result: "0x64" } } }),
  });
  assert.equal(good.result, "0x64");
  const bad = await rpc("http://x", "eth_blockNumber", [], {
    fetchImpl: fakeFetch({ eth_blockNumber: { throw: "ECONNREFUSED" } }),
  });
  assert.equal(classify(bad).label, "unreachable");
});

test("suiteCalls covers the tool's methods anchored at a recent block", () => {
  const methods = suiteCalls(2000).map((c) => c.method);
  assert.ok(methods.includes("trace_filter"));
  assert.ok(methods.includes("eth_getLogs"));
  const tf = suiteCalls(2000).find((c) => c.method === "trace_filter");
  assert.equal(tf.params[0].fromBlock, hexBlock(1000)); // tip - 1000
});

test("runSuite reports a Moralis-like endpoint: eth_* ok, trace_* not supported", async () => {
  const r = await runSuite("http://moralis", { fetchImpl: moralisFetch() });
  assert.equal(r.reachable, true);
  assert.equal(r.tip, 2000);
  assert.equal(r.traceOk, false);
  const tf = r.calls.find((c) => c.method === "trace_filter");
  assert.equal(tf.label, "not supported");
  const logs = r.calls.find((c) => c.method === "eth_getLogs");
  assert.equal(logs.ok, true);
  // The report renders both the tip and the trace verdict.
  const text = formatSuite(r);
  assert.match(text, /trace_filter .*NOT supported|NOT supported/);
});

test("runSuite flags an unreachable endpoint (no eth_blockNumber)", async () => {
  const r = await runSuite("http://dead", {
    fetchImpl: fakeFetch({
      eth_blockNumber: {
        status: 500,
        ok: false,
        body: { code: 500, message: "boom" },
      },
    }),
  });
  assert.equal(r.reachable, false);
  assert.match(formatSuite(r), /UNREACHABLE/);
});

test("runSingle exits 0 on success and 1 on a not-supported method", async () => {
  const okCode = await runSingle(["http://x"], {
    method: "eth_chainId",
    params: [],
    timeoutMs: 100,
    fetchImpl: moralisFetch(),
  });
  assert.equal(okCode, 0); // eth_chainId is served
  const badCode = await runSingle(["http://x"], {
    method: "trace_filter",
    params: [{}],
    timeoutMs: 100,
    fetchImpl: moralisFetch(),
  });
  assert.equal(badCode, 1); // trace_filter is not
});
