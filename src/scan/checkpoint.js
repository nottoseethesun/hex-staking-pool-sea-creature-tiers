/**
 * @file src/scan/checkpoint.js
 * @description Cache-file paths and checkpoint state for the stake-ledger scan.
 * The checkpoint is the resume cursor for incremental top-up; `schemaVersion`
 * guards against reusing a ledger written by an incompatible decoder (fail
 * cleanly and require --rebuild rather than silently trusting stale rows).
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { chainDir, readJson, writeJson } = require("../cache/store");

/** Bump when the NDJSON row schema or decoder semantics change. */
const SCHEMA_VERSION = 1;

/** @param {string} chainKey @returns {string} */
function checkpointPath(chainKey) {
  return path.join(chainDir(chainKey), "checkpoint.json");
}

/** @param {string} chainKey @returns {string} */
function stakesPath(chainKey) {
  return path.join(chainDir(chainKey), "stakes.ndjson");
}

/** @param {string} chainKey @returns {string} */
function deployBlockPath(chainKey) {
  return path.join(chainDir(chainKey), "deploy-block.json");
}

/** @param {string} chainKey @returns {string} */
function tipPath(chainKey) {
  return path.join(chainDir(chainKey), "tip.json");
}

/** @param {string} chainKey @returns {object | null} */
function loadCheckpoint(chainKey) {
  return readJson(checkpointPath(chainKey), null);
}

/** @param {string} chainKey @param {object} cp */
function saveCheckpoint(chainKey, cp) {
  writeJson(checkpointPath(chainKey), { schemaVersion: SCHEMA_VERSION, ...cp });
}

/** @param {object | null} cp @returns {boolean} */
function isCompatible(cp) {
  return Boolean(cp) && cp.schemaVersion === SCHEMA_VERSION;
}

/** @param {string} chainKey @returns {number | null} */
function loadDeployBlock(chainKey) {
  const d = readJson(deployBlockPath(chainKey), null);
  return d && typeof d.block === "number" ? d.block : null;
}

/** @param {string} chainKey @param {number} block */
function saveDeployBlock(chainKey, block) {
  writeJson(deployBlockPath(chainKey), { block });
}

/** @param {string} chainKey @returns {object | null} */
function loadTip(chainKey) {
  return readJson(tipPath(chainKey), null);
}

/** @param {string} chainKey @param {object} tip */
function saveTip(chainKey, tip) {
  writeJson(tipPath(chainKey), tip);
}

/** @param {string} chainKey @returns {string} */
function cyclePath(chainKey) {
  return path.join(chainDir(chainKey), "cycle.json");
}

/**
 * Load a chain's sync-cycle marker: `{ tip, complete }`, or null before the
 * first scan. A "cycle" is one report's worth of work at a single fixed tip.
 * While a cycle is in progress (`complete === false`) the pinned tip is held
 * fixed across restarts (the "sticky tip"), so the resumable resolve/OA
 * checkpoints keep matching and resume instead of restarting against a
 * freshly-advanced chain head. A written report completes the cycle, and the
 * next sync then pins a fresh tip.
 * @param {string} chainKey
 * @returns {{ tip: number, complete: boolean } | null}
 */
function loadCycle(chainKey) {
  return readJson(cyclePath(chainKey), null);
}

/**
 * Persist a chain's sync-cycle marker.
 * @param {string} chainKey
 * @param {{ tip: number, complete: boolean }} cycle
 */
function saveCycle(chainKey, cycle) {
  writeJson(cyclePath(chainKey), cycle);
}

/**
 * The tip a scan should target under the sticky-tip rule: a still-open cycle's
 * pinned tip, or null meaning "no open cycle — pin a fresh tip from the head".
 * A forced (--rebuild) run always returns null so it re-pins from the head.
 * @param {string} chainKey
 * @param {boolean} [force]
 * @returns {number | null}
 */
function stickyTip(chainKey, force = false) {
  if (force) return null;
  const cycle = loadCycle(chainKey);
  return cycle && cycle.complete === false && Number.isInteger(cycle.tip)
    ? cycle.tip
    : null;
}

/**
 * Remove the ledger + checkpoint for a chain (a --rebuild reset).
 * @param {string} chainKey
 */
function resetChain(chainKey) {
  for (const p of [checkpointPath(chainKey), stakesPath(chainKey)]) {
    fs.rmSync(p, { force: true });
  }
}

module.exports = {
  SCHEMA_VERSION,
  checkpointPath,
  stakesPath,
  deployBlockPath,
  tipPath,
  loadCheckpoint,
  saveCheckpoint,
  isCompatible,
  loadDeployBlock,
  saveDeployBlock,
  loadTip,
  saveTip,
  cyclePath,
  loadCycle,
  saveCycle,
  stickyTip,
  resetChain,
};
