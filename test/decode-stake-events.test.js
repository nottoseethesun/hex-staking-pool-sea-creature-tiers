"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  extractShares,
  extractHearts,
  decodeStakeLog,
  STAKE_TOPICS,
  EVENT_CODE,
} = require("../src/decode/stake-events");

/** Pack a StakeStart data0 from shares (bits 112..183) + hearts (bits 40..111). */
function packData0(shares, hearts) {
  return (shares << 112n) | (hearts << 40n) | 1700000000n; // + a timestamp
}

/** Left-pad a hex value to a 32-byte topic. */
function topic(hexNo0x) {
  return `0x${hexNo0x.padStart(64, "0")}`;
}

test("extractShares/extractHearts read the documented bit layout", () => {
  const data0 = packData0(123456789n, 987654321n);
  assert.equal(extractShares(data0), 123456789n);
  assert.equal(extractHearts(data0), 987654321n);
});

test("extractShares masks to 72 bits (ignores higher fields)", () => {
  const big = packData0((1n << 72n) - 1n, 0n);
  assert.equal(extractShares(big), (1n << 72n) - 1n);
});

test("STAKE_TOPICS are three 32-byte topic hashes", () => {
  assert.equal(STAKE_TOPICS.length, 3);
  for (const t of STAKE_TOPICS) assert.match(t, /^0x[0-9a-f]{64}$/i);
});

test("decodeStakeLog decodes a StakeStart log to a minimal row", () => {
  const staker = "0x4e448b2dd8fbb22e7e91b7d7eb9c5db5fa11161a";
  const data0 = packData0(55555n, 0n);
  const log = {
    topics: [STAKE_TOPICS[0], topic(staker.slice(2)), topic((42).toString(16))],
    data: `0x${data0.toString(16).padStart(64, "0")}`,
    blockNumber: 9500000,
  };
  const row = decodeStakeLog(log);
  assert.equal(row.e, EVENT_CODE.StakeStart);
  assert.equal(row.s, staker);
  assert.equal(row.i, "42");
  assert.equal(row.h, "55555");
  assert.equal(row.b, 9500000);
});

test("decodeStakeLog omits shares for StakeEnd", () => {
  const staker = "0x000000000000000000000000000000000000dead";
  const log = {
    topics: [STAKE_TOPICS[1], topic(staker.slice(2)), topic((7).toString(16))],
    data: `0x${"0".repeat(128)}`,
    blockNumber: 9600000,
  };
  const row = decodeStakeLog(log);
  assert.equal(row.e, EVENT_CODE.StakeEnd);
  assert.equal(row.h, undefined);
  assert.equal(row.i, "7");
});
