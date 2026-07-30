"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");
const fs = require("fs");
const path = require("path");
const { createRpcCache } = require("../src/rpc/cache");
const {
  createClient,
  minimalLog,
  callWithFailover,
} = require("../src/rpc/client");

test("minimalLog keeps only the decoder fields", () => {
  const m = minimalLog({
    topics: ["0x1"],
    data: "0xabcd",
    blockNumber: 5,
    transactionHash: "0xhash",
    address: "0xignored",
    index: 9,
  });
  assert.deepEqual(m, {
    topics: ["0x1"],
    data: "0xabcd",
    blockNumber: 5,
    transactionHash: "0xhash",
  });
});

test("createRpcCache round-trips through a temp file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rpccache-"));
  const file = path.join(dir, "c.json");
  const c1 = createRpcCache(file);
  assert.equal(c1.has("k"), false);
  c1.set("k", { v: 1 });
  assert.equal(c1.has("k"), true);
  assert.deepEqual(c1.get("k"), { v: 1 });
  c1.flush();
  const c2 = createRpcCache(file);
  assert.deepEqual(c2.get("k"), { v: 1 });
});

test("createClient caches getCode and maps getLogs to minimal fields", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rpccli-"));
  const cache = createRpcCache(path.join(dir, "c.json"));
  let codeCalls = 0;
  const fakeProvider = {
    getCode: async () => {
      codeCalls += 1;
      return "0x60";
    },
    getLogs: async () => [
      {
        topics: ["0x1"],
        data: "0x",
        blockNumber: 3,
        transactionHash: "0xh",
        address: "0xignored",
      },
    ],
    send: async () => ({ ok: true }),
    getBlockNumber: async () => 100,
  };
  const client = createClient({
    url: "http://x",
    cache,
    providers: [{ name: "http://x", rpc: fakeProvider }],
  });
  assert.equal(await client.getCode("0xabc"), "0x60");
  assert.equal(await client.getCode("0xabc"), "0x60");
  assert.equal(codeCalls, 1);
  const logs = await client.getLogs({
    address: "0xh",
    fromBlock: 0,
    toBlock: 9,
  });
  assert.deepEqual(logs[0], {
    topics: ["0x1"],
    data: "0x",
    blockNumber: 3,
    transactionHash: "0xh",
  });
});

test("callWithFailover rotates to the backup endpoint on a transient error", async () => {
  const calls = [];
  const providers = [
    {
      name: "http://primary",
      rpc: {
        go: async () => {
          calls.push("primary");
          throw new Error("timeout");
        },
      },
    },
    {
      name: "http://backup",
      rpc: {
        go: async () => {
          calls.push("backup");
          return "ok";
        },
      },
    },
  ];
  const result = await callWithFailover((rpc) => rpc.go(), providers);
  assert.equal(result, "ok");
  assert.deepEqual(calls, ["primary", "backup"]);
});

test("callWithFailover rethrows a non-transient error immediately", async () => {
  const providers = [
    {
      name: "x",
      rpc: {
        go: async () => {
          throw new Error("execution reverted");
        },
      },
    },
  ];
  await assert.rejects(
    callWithFailover((rpc) => rpc.go(), providers),
    /reverted/,
  );
});
