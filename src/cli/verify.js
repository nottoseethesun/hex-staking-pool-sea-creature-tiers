/**
 * @file src/cli/verify.js
 * @description `verify` subcommand — confirms each chain's chainId, that the
 * vendored ABI yields derivable event topics, and reports the cached (or freshly
 * discovered) deploy block. Full reconciliation (spec §8.1) runs in `report`.
 */

"use strict";

const { parseArgs } = require("node:util");
const { config } = require("../config");
const { log } = require("../log");
const { makeClient, assertChain } = require("./context");
const { CHAINS, HEX_CONTRACT } = require("../chain/constants");
const { STAKE_TOPICS } = require("../decode/stake-events");
const { findDeployBlock } = require("../chain/deploy-block");
const cp = require("../scan/checkpoint");
const { DISCLAIMER_SHORT } = require("../disclaimer");

/**
 * Verify a single chain's chainId, ABI topics, and deploy block.
 * @param {string} chainKey
 * @returns {Promise<void>}
 */
async function verifyChain(chainKey) {
  const client = makeClient(config, chainKey);
  const chainId = Number(BigInt(await client.send("eth_chainId", [])));
  const expected = CHAINS[chainKey].id;
  log.info(
    "[verify %s] chainId=%d (expected %d) %s",
    chainKey,
    chainId,
    expected,
    chainId === expected ? "OK" : "MISMATCH",
  );
  if (chainId !== expected) {
    throw new Error(`chainId mismatch for ${chainKey}`);
  }
  if (
    STAKE_TOPICS.length !== 3 ||
    !STAKE_TOPICS.every((t) => /^0x[0-9a-f]{64}$/i.test(t))
  ) {
    throw new Error("ABI sanity failed: could not derive stake event topics");
  }
  const cached = cp.loadDeployBlock(chainKey);
  if (cached !== null) {
    log.info("[verify %s] deploy block (cached)= %d", chainKey, cached);
  } else {
    const head = await client.getBlockNumber();
    const block = await findDeployBlock(client, HEX_CONTRACT, head);
    cp.saveDeployBlock(chainKey, block);
    log.info("[verify %s] deploy block (found)= %d", chainKey, block);
  }
}

/**
 * `verify` entry point.
 * @param {string[]} argv
 * @returns {Promise<void>}
 */
async function verify(argv) {
  const { values } = parseArgs({
    args: argv,
    options: { chain: { type: "string" } },
  });
  const chains = values.chain ? [assertChain(values.chain)] : ["eth", "pls"];
  for (const chainKey of chains) {
    await verifyChain(chainKey);
  }
  log.info(DISCLAIMER_SHORT);
}

module.exports = { verify, verifyChain };
