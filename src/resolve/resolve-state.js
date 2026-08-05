/**
 * @file src/resolve/resolve-state.js
 * @description Persist the resolve stage's raw replay state across sync cycles —
 * the full HEX Stake Instance Manager (HSIM) ownership state (all owners, the
 * tokenized-HSI map, the ended set) and each wrapper token's holder-balance map —
 * so a Re-Scan extends them over only the new block range instead of replaying
 * from each contract's deploy block. Keyed to the tip it was built at; a changed
 * tip that is newer means "extend", anything else means "rebuild".
 */

"use strict";

const path = require("path");
const { readJson, writeJsonCompact, chainDir } = require("../cache/store");

/** @param {string} chainKey @returns {string} */
function resolveStatePath(chainKey) {
  return path.join(chainDir(chainKey), "resolve-state.json");
}

/**
 * Persist the resolve replay state.
 * @param {string} chainKey
 * @param {{ tip: number, ownership: object|null, wrappers: Record<string, object> }} state
 */
function saveResolveState(chainKey, state) {
  writeJsonCompact(resolveStatePath(chainKey), state);
}

/**
 * Load the cached resolve replay state, or null when absent.
 * @param {string} chainKey
 * @returns {{ tip: number, ownership: object|null, wrappers: Record<string, object> } | null}
 */
function loadResolveState(chainKey) {
  return readJson(resolveStatePath(chainKey), null);
}

module.exports = { resolveStatePath, saveResolveState, loadResolveState };
