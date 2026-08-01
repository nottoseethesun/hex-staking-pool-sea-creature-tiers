/**
 * @file test/hsim-events.test.js
 * @description Guards the vendored HSIM ABI: the topic0 hashes derived from it
 * must match the values confirmed on-chain during Stage 0 (real HSIM logs on
 * Ethereum, cross-checked against the verified Hedron source). A mismatch means a
 * signature in src/abi/hsim.json drifted.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { iface, HSIM_EVENT_NAMES } = require("../src/resolve/hsim-events");

/** topic0 values confirmed against real on-chain HSIM logs (Stage 0). */
const EXPECTED = {
  HSIStart:
    "0xd680a9b62662668ffed760ca1d0741736980d08c278efca9e0c6dcc1a4c166ca",
  HSIEnd: "0x14d0fe09f225917f351bd3b122714cfcc1c45015a67232167d4b561e186b26de",
  HSITransfer:
    "0xc24b27b33d05d2d17b1cf97ccbe0c85b21236ad0f06ba8359bf46f8e3b2749b6",
  HSITokenize:
    "0xed10b8f4c54a638850d395c632b529baa72a9c68ee7ed868f15a0468405d5147",
  HSIDetokenize:
    "0x6bce622a5976965d5b72e030c8cab9696faae9e320a35bfd263b1681ae7f2490",
  Transfer:
    "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
};

test("HSIM event topic0s match the on-chain-confirmed hashes", () => {
  for (const name of HSIM_EVENT_NAMES) {
    assert.equal(iface.getEvent(name).topicHash, EXPECTED[name]);
  }
});
