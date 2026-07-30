"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  loadConfig,
  rpcUrlFor,
  logChunkFor,
  ankrEthUrlFromKey,
} = require("../src/config");

test("loadConfig applies documented defaults", () => {
  const c = loadConfig({});
  assert.equal(c.port, 3693);
  assert.equal(c.host, "127.0.0.1");
  assert.equal(c.concurrency, 4);
  assert.equal(c.oaMaxHops, 3);
  assert.equal(c.oaFundingThreshold, 0.2);
  assert.equal(c.ethRpcUrl, "https://rpc-ethereum.g4mm4.io");
  assert.equal(c.plsRpcUrl, "https://rpc-pulsechain.g4mm4.io");
  assert.equal(c.rpcCache, false);
});

test("loadConfig enables the RPC cache when RPC_CACHE=1", () => {
  assert.equal(loadConfig({ RPC_CACHE: "1" }).rpcCache, true);
  assert.equal(loadConfig({ RPC_CACHE: "true" }).rpcCache, true);
  assert.equal(loadConfig({ RPC_CACHE: "0" }).rpcCache, false);
});

test("loadConfig honors env overrides", () => {
  const c = loadConfig({
    PORT: "8080",
    CONCURRENCY: "8",
    OA_MAX_HOPS: "2",
    OA_FUNDING_THRESHOLD: "0.5",
    ETH_RPC_URL: "http://x",
  });
  assert.equal(c.port, 8080);
  assert.equal(c.concurrency, 8);
  assert.equal(c.oaMaxHops, 2);
  assert.equal(c.oaFundingThreshold, 0.5);
  assert.equal(c.ethRpcUrl, "http://x");
});

test("loadConfig rejects invalid values and falls back", () => {
  const c = loadConfig({ PORT: "-1", OA_FUNDING_THRESHOLD: "2" });
  assert.equal(c.port, 3693);
  assert.equal(c.oaFundingThreshold, 0.2);
});

test("rpcUrlFor / logChunkFor select per chain", () => {
  const c = loadConfig({});
  assert.equal(rpcUrlFor(c, "eth"), c.ethRpcUrl);
  assert.equal(rpcUrlFor(c, "pls"), c.plsRpcUrl);
  assert.equal(logChunkFor(c, "eth"), 5000);
  assert.equal(logChunkFor(c, "pls"), 5000);
});

test("ankrEthUrlFromKey builds the endpoint and ignores the placeholder", () => {
  assert.equal(ankrEthUrlFromKey("abc123"), "https://rpc.ankr.com/eth/abc123");
  assert.equal(ankrEthUrlFromKey("YOUR_ANKR_ETH_API_KEY"), null);
  assert.equal(ankrEthUrlFromKey(""), null);
  assert.equal(ankrEthUrlFromKey(undefined), null);
});
