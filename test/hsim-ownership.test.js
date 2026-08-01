/**
 * @file test/hsim-ownership.test.js
 * @description Unit tests for the pure HSIM ownership replay state machine
 * (src/resolve/ownership.js): untokenized transfers, tokenize + NFT moves,
 * detokenize, inert mint/burn, and ended-HSI dropping.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  newState,
  applyEvent,
  finalizeOwners,
} = require("../src/resolve/ownership");
const { ZERO } = require("../src/resolve/wrapped");

/** Replay a list of decoded events into the final owner map. */
function replay(events) {
  const s = newState();
  for (const e of events) applyEvent(s, e);
  return finalizeOwners(s);
}

test("HSIStart sets the initial (untokenized) owner", () => {
  const o = replay([{ name: "HSIStart", hsi: "0xh1", staker: "0xalice" }]);
  assert.equal(o.get("0xh1"), "0xalice");
});

test("HSITransfer moves an untokenized HSI's owner", () => {
  const o = replay([
    { name: "HSIStart", hsi: "0xh1", staker: "0xalice" },
    { name: "HSITransfer", hsi: "0xh1", to: "0xbob" },
  ]);
  assert.equal(o.get("0xh1"), "0xbob");
});

test("tokenize maps the NFT; a later Transfer moves ownership", () => {
  const o = replay([
    { name: "HSIStart", hsi: "0xh1", staker: "0xalice" },
    { name: "HSITokenize", tokenId: "7", hsi: "0xh1", staker: "0xalice" },
    { name: "Transfer", tokenId: "7", from: "0xalice", to: "0xcarol" },
  ]);
  assert.equal(o.get("0xh1"), "0xcarol");
});

test("a mint Transfer (from zero) alongside tokenize keeps the staker", () => {
  const o = replay([
    { name: "HSIStart", hsi: "0xh1", staker: "0xalice" },
    { name: "HSITokenize", tokenId: "7", hsi: "0xh1", staker: "0xalice" },
    { name: "Transfer", tokenId: "7", from: ZERO, to: "0xalice" },
  ]);
  assert.equal(o.get("0xh1"), "0xalice");
});

test("detokenize returns to staker; stale tokenId moves are ignored", () => {
  const o = replay([
    { name: "HSIStart", hsi: "0xh1", staker: "0xalice" },
    { name: "HSITokenize", tokenId: "7", hsi: "0xh1", staker: "0xalice" },
    { name: "Transfer", tokenId: "7", from: "0xalice", to: "0xcarol" },
    { name: "HSIDetokenize", tokenId: "7", hsi: "0xh1", staker: "0xcarol" },
    { name: "Transfer", tokenId: "7", from: "0xcarol", to: "0xmallory" },
  ]);
  assert.equal(o.get("0xh1"), "0xcarol");
});

test("ended HSIs are dropped from the owner map", () => {
  const o = replay([
    { name: "HSIStart", hsi: "0xh1", staker: "0xalice" },
    { name: "HSIStart", hsi: "0xh2", staker: "0xbob" },
    { name: "HSIEnd", hsi: "0xh1", staker: "0xalice" },
  ]);
  assert.equal(o.has("0xh1"), false);
  assert.equal(o.get("0xh2"), "0xbob");
});
