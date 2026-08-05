"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  hexBlock,
  isMethodMissing,
  isNotArchive,
  checkMethod,
  checkArchive,
  probe,
  run,
} = require("../utils/check-trace-support");

test("hexBlock formats a block number as a 0x hex tag", () => {
  assert.equal(hexBlock(0), "0x0");
  assert.equal(hexBlock(255), "0xff");
  assert.equal(hexBlock(100000), "0x186a0");
});

test("isMethodMissing recognizes -32601 and 'not supported' messages", () => {
  assert.equal(isMethodMissing({ code: -32601 }), true);
  assert.equal(isMethodMissing({ message: "method does not exist" }), true);
  assert.equal(isMethodMissing({ message: "unsupported method" }), true);
  assert.equal(isMethodMissing({ code: -32000, message: "boom" }), false);
  assert.equal(isMethodMissing(undefined), false);
});

test("isNotArchive recognizes pruned/archive messages", () => {
  assert.equal(isNotArchive({ message: "missing trie node / pruned" }), true);
  assert.equal(isNotArchive({ message: "state is not available" }), true);
  assert.equal(isNotArchive({ message: "some other error" }), false);
});

/** Run `fn` with `global.fetch` swapped for `handler`, restoring it after. */
async function withFetch(handler, fn) {
  const orig = global.fetch;
  global.fetch = handler;
  try {
    return await fn();
  } finally {
    global.fetch = orig;
  }
}

/** A fetch stub that maps the JSON-RPC method (per URL) to a response body. */
function stub(pick) {
  return async (url, init) => {
    const body = JSON.parse(init.body);
    return { json: async () => pick(url, body.method) };
  };
}

test("checkMethod returns 'supported' when trace_filter yields a result", async () => {
  await withFetch(
    stub((_u, m) =>
      m === "eth_blockNumber" ? { result: "0x100" } : { result: [] },
    ),
    async () => assert.equal(await checkMethod("http://x", 1000), "supported"),
  );
});

test("checkMethod returns 'missing' on a -32601", async () => {
  await withFetch(
    stub((_u, m) =>
      m === "eth_blockNumber"
        ? { result: "0x100" }
        : { error: { code: -32601, message: "no" } },
    ),
    async () => assert.equal(await checkMethod("http://x", 1000), "missing"),
  );
});

test("checkMethod returns 'unreachable' when eth_blockNumber has no result", async () => {
  await withFetch(
    stub(() => ({})),
    async () =>
      assert.match(await checkMethod("http://x", 1000), /^unreachable/),
  );
});

test("checkMethod returns 'unreachable' when the transport throws", async () => {
  await withFetch(
    async () => {
      throw new Error("ECONNREFUSED");
    },
    async () =>
      assert.match(
        await checkMethod("http://x", 1000),
        /^unreachable:ECONNREFUSED/,
      ),
  );
});

test("checkArchive returns 'full archive' on a result", async () => {
  await withFetch(
    stub(() => ({ result: [] })),
    async () =>
      assert.equal(
        await checkArchive("http://x", 100000, 1000),
        "full archive",
      ),
  );
});

test("checkArchive flags a non-archive node", async () => {
  await withFetch(
    stub(() => ({ error: { message: "missing trie node (pruned)" } })),
    async () =>
      assert.equal(
        await checkArchive("http://x", 100000, 1000),
        "recent-only (NOT archive)",
      ),
  );
});

test("probe reports ok only for a full-archive trace provider", async () => {
  await withFetch(
    stub((_u, m) =>
      m === "eth_blockNumber" ? { result: "0x186a0" } : { result: [] },
    ),
    async () => {
      const v = await probe("http://good", {
        archiveBlock: 100000,
        timeoutMs: 1000,
      });
      assert.equal(v.ok, true);
      assert.equal(v.trace, "supported");
      assert.equal(v.archive, "full archive");
    },
  );
  await withFetch(
    stub((_u, m) =>
      m === "eth_blockNumber"
        ? { result: "0x186a0" }
        : { error: { code: -32601, message: "no" } },
    ),
    async () => {
      const v = await probe("http://notrace", {
        archiveBlock: 100000,
        timeoutMs: 1000,
      });
      assert.equal(v.ok, false);
      assert.equal(v.trace, "missing");
    },
  );
});

test("run aggregates verdicts and allOk across urls", async () => {
  await withFetch(
    stub((url, m) => {
      if (m === "eth_blockNumber") return { result: "0x186a0" };
      return url.includes("bad")
        ? { error: { code: -32601, message: "no" } }
        : { result: [] };
    }),
    async () => {
      const { results, allOk } = await run(["http://good", "http://bad"], {
        archiveBlock: 100000,
        timeoutMs: 1000,
      });
      assert.equal(results.length, 2);
      assert.equal(allOk, false);
      assert.equal(results[0].ok, true);
      assert.equal(results[1].ok, false);
    },
  );
});
