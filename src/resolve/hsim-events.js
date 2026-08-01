/**
 * @file src/resolve/hsim-events.js
 * @description HSIM (HEX Stake Instance Manager) event decoding. A dedicated
 * ethers Interface over the vendored HSIM ABI — its ERC-721 Transfer indexes
 * tokenId, unlike HEX's ERC-20 Transfer, so it needs its own Interface. Exposes
 * the topic0 OR-set for a single filtered eth_getLogs and a decoder that
 * normalizes each ownership-relevant log to a compact event row with lowercased
 * addresses. Topics are derived from the ABI at runtime, never hardcoded.
 */

"use strict";

const { Interface } = require("ethers");
const hsimAbi = require("../abi/hsim.json");

const iface = new Interface(hsimAbi);

/** Ownership-relevant HSIM events, resolved into one getLogs topic0 OR-set. */
const HSIM_EVENT_NAMES = [
  "HSIStart",
  "HSIEnd",
  "HSITransfer",
  "HSITokenize",
  "HSIDetokenize",
  "Transfer",
];

/** topic0 hashes for the ownership-relevant HSIM events. */
const HSIM_TOPICS = HSIM_EVENT_NAMES.map((n) => iface.getEvent(n).topicHash);

/** Lowercase an address. */
function low(addr) {
  return addr.toLowerCase();
}

/**
 * Decode one HSIM log to a normalized event row, or null if unrecognized.
 * @param {{ topics: string[], data: string, blockNumber: number }} log
 * @returns {object|null}
 */
function decodeHsimLog(log) {
  const parsed = iface.parseLog({ topics: log.topics, data: log.data });
  if (!parsed) return null;
  const a = parsed.args;
  const name = parsed.name;
  if (name === "HSIStart" || name === "HSIEnd") {
    return { name, hsi: low(a.hsiAddress), staker: low(a.staker) };
  }
  if (name === "HSITransfer") {
    return { name, hsi: low(a.hsiAddress), to: low(a.newStaker) };
  }
  if (name === "HSITokenize" || name === "HSIDetokenize") {
    return {
      name,
      tokenId: a.hsiTokenId.toString(),
      hsi: low(a.hsiAddress),
      staker: low(a.staker),
    };
  }
  if (name === "Transfer") {
    return {
      name,
      tokenId: a.tokenId.toString(),
      from: low(a.from),
      to: low(a.to),
    };
  }
  return null;
}

module.exports = { iface, HSIM_TOPICS, HSIM_EVENT_NAMES, decodeHsimLog };
