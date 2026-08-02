"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  callWithFailover,
  createClient,
  isUnsupportedMethod,
  isRetryable,
} = require("../src/rpc/client");

/**
 * The exact shape ethers v6 produces for Ankr's trace_filter rejection: a
 * generic UNKNOWN_ERROR wrapper around the nested JSON-RPC -32053 error.
 * @returns {Error}
 */
function ankrTraceError() {
  return Object.assign(new Error("could not coalesce error (…)"), {
    code: "UNKNOWN_ERROR",
    shortMessage: "could not coalesce error",
    error: { code: -32053, message: "API key is not allowed to access method" },
  });
}

/**
 * A transient Cloudflare 520 from the Erigon node (retryable, not permanent).
 * @returns {Error}
 */
function serverError520() {
  return Object.assign(new Error("server response 520 <none>"), {
    code: "SERVER_ERROR",
    info: { responseStatus: "520 <none>" },
  });
}

test("isUnsupportedMethod: permanent method/auth rejections vs transient errors", () => {
  // Ankr: JSON-RPC -32053 "not allowed to access method".
  assert.equal(isUnsupportedMethod(ankrTraceError()), true);
  // Standard -32601 "method not found".
  assert.equal(
    isUnsupportedMethod({
      error: {
        code: -32601,
        message: "the method trace_filter does not exist",
      },
    }),
    true,
  );
  // publicnode gates archive traces behind a token — caught by message, not code
  // (-32602 is normally "invalid params", so the code alone must not match).
  assert.equal(
    isUnsupportedMethod({
      error: {
        code: -32602,
        message: "Archive requests require a personal token",
      },
    }),
    true,
  );
  // Transient / unrelated errors are NOT permanent.
  assert.equal(isUnsupportedMethod(serverError520()), false);
  assert.equal(isUnsupportedMethod(new Error("timeout")), false);
  assert.equal(isUnsupportedMethod(new Error("execution reverted")), false);
  // The whole point: ethers mislabels the Ankr error as retryable, so
  // isUnsupportedMethod must intercept it before the retry logic does.
  assert.equal(isRetryable(ankrTraceError()), true);
});

test("callWithFailover drops an unsupported endpoint and serves from the capable one", async () => {
  const calls = [];
  const providers = [
    {
      name: "http://ankr",
      rpc: {
        go: async () => {
          calls.push("ankr");
          throw ankrTraceError();
        },
      },
    },
    {
      name: "http://erigon",
      rpc: {
        go: async () => {
          calls.push("erigon");
          return "traces";
        },
      },
    },
  ];
  const unsupported = new Set();
  const out = await callWithFailover(
    (rpc) => rpc.go(),
    providers,
    "trace_filter",
    unsupported,
  );
  assert.equal(out, "traces");
  assert.deepEqual(calls, ["ankr", "erigon"]); // ankr once, then dropped
  assert.ok(unsupported.has("http://ankr|trace_filter"));
});

test("callWithFailover keeps the full retry budget on the capable endpoint", async () => {
  // erigon (index 0) blips once with a transient 520; ankr can never serve
  // traces. Dropping ankr must NOT consume erigon's retry budget: erigon is
  // retried and succeeds, and ankr is hit at most once before being dropped.
  const calls = [];
  let erigonTries = 0;
  const providers = [
    {
      name: "http://erigon",
      rpc: {
        go: async () => {
          calls.push("erigon");
          erigonTries += 1;
          if (erigonTries < 2) throw serverError520();
          return "traces";
        },
      },
    },
    {
      name: "http://ankr",
      rpc: {
        go: async () => {
          calls.push("ankr");
          throw ankrTraceError();
        },
      },
    },
  ];
  const out = await callWithFailover(
    (rpc) => rpc.go(),
    providers,
    "trace_filter",
    new Set(),
  );
  assert.equal(out, "traces");
  assert.equal(
    calls.filter((c) => c === "ankr").length,
    1,
    "ankr dropped after a single try",
  );
  assert.ok(erigonTries >= 2, "erigon retried through its transient 520");
});

test("callWithFailover throws when every endpoint is unsupported for the method", async () => {
  const providers = [
    {
      name: "http://ankr",
      rpc: {
        go: async () => {
          throw ankrTraceError();
        },
      },
    },
  ];
  // The real underlying rejection is preserved (not swallowed), so the root
  // cause — the nested JSON-RPC -32053 — surfaces to the caller.
  await assert.rejects(
    callWithFailover((rpc) => rpc.go(), providers, "trace_filter", new Set()),
    (err) => err.error && err.error.code === -32053,
  );
});

test("createClient learns unsupported once, and a new client (new run) clears it", async () => {
  let ankrSends = 0;
  let erigonSends = 0;
  const makeProviders = () => [
    {
      name: "http://ankr",
      rpc: {
        send: async () => {
          ankrSends += 1;
          throw ankrTraceError();
        },
      },
    },
    {
      name: "http://erigon",
      rpc: {
        send: async () => {
          erigonSends += 1;
          return "traces";
        },
      },
    },
  ];

  // Within one client, the marking persists across calls: ankr is probed once,
  // then skipped for the rest of the run.
  const c1 = createClient({ url: "http://ankr", providers: makeProviders() });
  assert.equal(await c1.send("trace_filter", []), "traces");
  assert.equal(await c1.send("trace_filter", []), "traces");
  assert.equal(
    ankrSends,
    1,
    "ankr dropped after learning; not re-probed on c1",
  );
  assert.equal(erigonSends, 2);

  // A brand-new client models a new run: it does NOT inherit the marking and
  // re-probes ankr from scratch.
  const c2 = createClient({ url: "http://ankr", providers: makeProviders() });
  assert.equal(await c2.send("trace_filter", []), "traces");
  assert.equal(ankrSends, 2, "new run re-probes ankr — markings cleared");
});
