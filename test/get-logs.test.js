"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { getLogsChunked, isChunkError } = require("../src/rpc/get-logs");

test("isChunkError recognizes size / range errors, including nested messages", () => {
  assert.equal(
    isChunkError(new Error("query returned more than 10000 results")),
    true,
  );
  // The real g4mm4 error: the range message is nested in err.error.message.
  assert.equal(
    isChunkError({
      message: "could not coalesce error",
      error: {
        message:
          "query block range exceeds server limit, narrow your filter: 5000",
      },
    }),
    true,
  );
  assert.equal(isChunkError(new Error("execution reverted")), false);
  assert.equal(isChunkError({ code: "SERVER_ERROR" }), false);
  assert.equal(isChunkError(null), false);
});

test("getLogsChunked halves on over-large windows and covers the range", async () => {
  const windows = [];
  const seen = [];
  const client = {
    getLogs: async ({ fromBlock, toBlock }) => {
      if (toBlock - fromBlock + 1 > 100) {
        throw new Error("too many results");
      }
      windows.push([fromBlock, toBlock]);
      return [{ blockNumber: fromBlock }];
    },
  };
  await getLogsChunked(client, {
    address: "0x",
    topics: [],
    fromBlock: 0,
    toBlock: 399,
    startChunk: 400,
    minChunk: 1,
    onLogs: (logs) => seen.push(...logs),
  });
  for (const [f, t] of windows) assert.ok(t - f + 1 <= 100);
  assert.equal(windows[0][0], 0);
  assert.equal(windows[windows.length - 1][1], 399);
  assert.equal(seen.length, windows.length);
});

test("getLogsChunked rethrows a non-chunk error at min chunk", async () => {
  const client = {
    getLogs: async () => {
      throw new Error("execution reverted");
    },
  };
  await assert.rejects(
    getLogsChunked(client, {
      address: "0x",
      topics: [],
      fromBlock: 0,
      toBlock: 10,
      startChunk: 10,
      minChunk: 1,
      onLogs: () => {},
    }),
    /reverted/,
  );
});
