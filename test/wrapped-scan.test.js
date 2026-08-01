/**
 * @file test/wrapped-scan.test.js
 * @description Drives scanWrapperBalances through real ethers-encoded ERC-20
 * Transfer logs and a mock RPC client, covering the log-decode + balance-fold
 * path end-to-end (encode -> getLogsChunked -> decode -> balances/supply).
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { scanWrapperBalances } = require("../src/resolve/wrapped");
const { iface } = require("../src/decode/stake-events");

const ZERO = "0x0000000000000000000000000000000000000000";
const A = `0x${"a".repeat(40)}`;
const B = `0x${"b".repeat(40)}`;

/** Build a real Transfer log via the shared ERC-20 Transfer ABI. */
function transferLog(from, to, value, block) {
  const enc = iface.encodeEventLog(iface.getEvent("Transfer"), [
    from,
    to,
    value,
  ]);
  return { topics: enc.topics, data: enc.data, blockNumber: block };
}

test("scanWrapperBalances rebuilds balances + supply from Transfer logs", async () => {
  const logs = [
    transferLog(ZERO, A, 100n, 1), // mint 100 -> A
    transferLog(A, B, 40n, 2), // A -> B 40
    transferLog(B, ZERO, 10n, 3), // burn 10 from B
  ];
  let served = false;
  const client = {
    getLogs: async () => {
      if (served) return [];
      served = true;
      return logs;
    },
  };
  const { balances, supply } = await scanWrapperBalances(client, {
    token: "0xtoken",
    fromBlock: 0,
    toBlock: 5,
    startChunk: 100,
  });
  assert.equal(balances.get(A.toLowerCase()), 60n);
  assert.equal(balances.get(B.toLowerCase()), 30n);
  assert.equal(supply, 90n); // 100 minted - 10 burned
});
