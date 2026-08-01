/**
 * @file src/chain/constants.js
 * @description On-chain constants and per-chain configuration, sourced from the
 * tracked config/ JSON files (config/contracts.json, config/chains.json).
 * SHARES_PER_TSHARE and HEARTS_PER_HEX are protocol math definitions (not
 * operator-configurable) and stay in code. Addresses are EIP-55 checksummed.
 */

"use strict";

const contracts = require("../../config/contracts.json");
const chains = require("../../config/chains.json");
const entities = require("../../config/entities.json");

/** HEX contract address (identical on Ethereum and PulseChain). */
const HEX_CONTRACT = contracts.hexContract;

/** Origin Address (OA) — root of the exclusion set; same on both chains. */
const ORIGIN_ADDRESS = contracts.originAddress;

/** 1 T-Share = 10^12 raw contract "shares". */
const SHARES_PER_TSHARE = 10n ** 12n;

/** 1 HEX = 10^8 Hearts (HEX has 8 decimals). */
const HEARTS_PER_HEX = 10n ** 8n;

/**
 * Per-chain configuration, keyed by the CLI `--chain` value. `approxDeployBlock`
 * is only a search hint — the real deploy block is found by binary-searching
 * eth_getCode and cached, never trusted from here.
 */
const CHAINS = Object.fromEntries(
  Object.entries(chains).map(([key, c]) => [key, { key, ...c }]),
);

/** Ordered list of valid chain keys. */
const CHAIN_KEYS = Object.keys(CHAINS);

/** HSIM (HEX Stake Instance Manager) address per chain (EIP-55, may be null). */
const HSIM_BY_CHAIN = Object.fromEntries(
  Object.entries(entities).map(([key, e]) => [key, e.hsim ?? null]),
);

/** Look-through wrapper tokens per chain (e.g. $MAXI on eth). */
const WRAPPERS_BY_CHAIN = Object.fromEntries(
  Object.entries(entities).map(([key, e]) => [key, e.wrappers ?? []]),
);

module.exports = {
  HEX_CONTRACT,
  ORIGIN_ADDRESS,
  SHARES_PER_TSHARE,
  HEARTS_PER_HEX,
  CHAINS,
  CHAIN_KEYS,
  HSIM_BY_CHAIN,
  WRAPPERS_BY_CHAIN,
};
