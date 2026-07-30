/**
 * @file src/decode/stake-events.js
 * @description Decodes HEX stake-lifecycle logs into the minimal ledger row
 * schema. Event topics/selectors are derived from the vendored ABI via ethers
 * (never hardcoded from the spec). StakeStart.data0 is a packed uint256:
 * stakeShares occupy bits 112..183 (uint72) and stakedHearts bits 40..111 —
 * extracted with BigInt masking (verify empirically against stakeLists,
 * spec §8.2). Indexed-argument ordering is handled by ethers per the ABI, so
 * StakeGoodAccounting's index layout is decoded correctly regardless of order.
 */

"use strict";

const { Interface } = require("ethers");
const hexAbi = require("../abi/hex.json");

const iface = new Interface(hexAbi);

/** Compact event codes for the NDJSON ledger. */
const EVENT_CODE = { StakeStart: 0, StakeEnd: 1, StakeGoodAccounting: 2 };

/** topic0 hashes for the three stake-lifecycle events (for eth_getLogs). */
const STAKE_TOPICS = Object.keys(EVENT_CODE).map(
  (name) => iface.getEvent(name).topicHash,
);

/** topic0 for the ERC-20 Transfer event. */
const TRANSFER_TOPIC = iface.getEvent("Transfer").topicHash;

const U72_MASK = (1n << 72n) - 1n;

/**
 * Extract stakeShares (bits 112..183) from a StakeStart data0 word.
 * @param {bigint} data0
 * @returns {bigint}
 */
function extractShares(data0) {
  return (data0 >> 112n) & U72_MASK;
}

/**
 * Extract stakedHearts (bits 40..111) from a StakeStart data0 word.
 * @param {bigint} data0
 * @returns {bigint}
 */
function extractHearts(data0) {
  return (data0 >> 40n) & U72_MASK;
}

/**
 * Decode one stake-lifecycle log to a minimal ledger row, or null if the log
 * is not one of the three stake events. Row shape:
 * { e: code, s: staker (lowercased), i: stakeId, h?: shares, b: block }.
 * @param {{ topics: string[], data: string, blockNumber: number }} log
 * @returns {object | null}
 */
function decodeStakeLog(log) {
  const parsed = iface.parseLog({ topics: log.topics, data: log.data });
  if (!parsed || !(parsed.name in EVENT_CODE)) return null;
  const row = {
    e: EVENT_CODE[parsed.name],
    s: parsed.args.stakerAddr.toLowerCase(),
    i: parsed.args.stakeId.toString(),
    b: log.blockNumber,
  };
  if (parsed.name === "StakeStart") {
    row.h = extractShares(parsed.args.data0).toString();
  }
  return row;
}

module.exports = {
  iface,
  EVENT_CODE,
  STAKE_TOPICS,
  TRANSFER_TOPIC,
  extractShares,
  extractHearts,
  decodeStakeLog,
};
