/**
 * @file src/chain/reads.js
 * @description Pinned-tip contract read calls (globalInfo, currentDay,
 * totalSupply) plus the block timestamp, routed through the guarded client via
 * eth_call so they respect concurrency + backoff. HEX globalInfo returns
 * uint256[13]: index 1 = nextStakeSharesTotal, 2 = shareRate,
 * 5 = stakeSharesTotal. The result is cached in data/<chain>/tip.json so
 * report / whereami / the dashboard run fully offline.
 */

"use strict";

const { iface } = require("../decode/stake-events");
const { HEX_CONTRACT } = require("./constants");

/** @param {number} n @returns {string} */
function toHex(n) {
  return `0x${n.toString(16)}`;
}

/**
 * Call a HEX view function at a block tag and decode the result.
 * @param {object} client
 * @param {string} name function name
 * @param {any[]} args
 * @param {string} blockTag hex block tag
 * @returns {Promise<any>} decoded Result
 */
async function callFn(client, name, args, blockTag) {
  const data = iface.encodeFunctionData(name, args);
  const raw = await client.send("eth_call", [
    { to: HEX_CONTRACT, data },
    blockTag,
  ]);
  return iface.decodeFunctionResult(name, raw);
}

/**
 * Read the pinned-tip totals for reconciliation + report headers.
 * @param {object} client
 * @param {number} block pinned tip block
 * @returns {Promise<object>} tip read set (all bigints as strings)
 */
async function readTip(client, block) {
  const tag = toHex(block);
  const [globalInfo] = await callFn(client, "globalInfo", [], tag);
  const [day] = await callFn(client, "currentDay", [], tag);
  const [supply] = await callFn(client, "totalSupply", [], tag);
  const blk = await client.send("eth_getBlockByNumber", [tag, false]);
  const seconds = Number(BigInt(blk.timestamp));
  return {
    block,
    timeUtc: new Date(seconds * 1000).toISOString(),
    stakeSharesTotal: globalInfo[5].toString(),
    nextStakeSharesTotal: globalInfo[1].toString(),
    shareRate: globalInfo[2].toString(),
    currentDay: day.toString(),
    totalSupply: supply.toString(),
  };
}

module.exports = { readTip, callFn, toHex };
