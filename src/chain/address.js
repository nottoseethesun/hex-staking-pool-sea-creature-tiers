/**
 * @file src/chain/address.js
 * @description Address helpers built on ethers. `checksum` returns the EIP-55
 * mixed-case form for display; `lower` returns the lowercase form used as the
 * canonical map key when aggregating shares / transfers by address.
 */

"use strict";

const { getAddress, isAddress } = require("ethers");

/**
 * EIP-55 checksummed address (throws on an invalid address).
 * @param {string} addr
 * @returns {string}
 */
function checksum(addr) {
  return getAddress(addr);
}

/**
 * Lowercased address for use as a canonical map key.
 * @param {string} addr
 * @returns {string}
 */
function lower(addr) {
  return addr.toLowerCase();
}

/**
 * True if `addr` is a syntactically valid address.
 * @param {string} addr
 * @returns {boolean}
 */
function isValidAddress(addr) {
  return isAddress(addr);
}

module.exports = { checksum, lower, isValidAddress };
