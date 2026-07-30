/**
 * @file src/chain/deploy-block.js
 * @description Discovers a contract's deployment block by binary-searching
 * eth_getCode — the spec's early-Dec-2019 estimate is explicitly not trusted.
 * O(log tip) getCode calls. The result is cached by the caller under
 * data/<chain>/deploy-block.json (immutable — found once, reused forever).
 */

"use strict";

/**
 * Binary-search the first block at which `address` has contract code.
 * Assumes the contract exists at `hi` (the tip).
 * @param {object} client guarded RPC client (see rpc/client.js)
 * @param {string} address contract address
 * @param {number} hi upper bound (e.g. the current tip)
 * @returns {Promise<number>} the deployment block number
 */
async function findDeployBlock(client, address, hi) {
  let lo = 0;
  let high = hi;
  while (lo < high) {
    const mid = Math.floor((lo + high) / 2);
    const code = await client.getCode(address, mid);
    if (code && code !== "0x") high = mid;
    else lo = mid + 1;
  }
  return lo;
}

module.exports = { findDeployBlock };
