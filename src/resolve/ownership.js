/**
 * @file src/resolve/ownership.js
 * @description Reconstruct each HEX Stake Instance (HSI) contract's current owner
 * by replaying the HEX Stake Instance Manager (HSIM) ownership events in
 * chronological order — eth_getLogs streams them in (block, logIndex) order, so a
 * single filtered stream over all the events needs no re-sort. Untokenized HSIs
 * are owned by their staker (HSIStart / HSITransfer / HSIDetokenize); tokenized
 * HSIs follow the ERC-721 NFT holder (HSITokenize maps tokenId->HSI, then Transfer
 * moves it; mint/burn via the zero address are inert). Ended HSIs are dropped. The
 * pure state machine is exported for testing; the scan feeds it a single filtered
 * HSIM log stream.
 */

"use strict";

const { runResumableLogScan } = require("../cache/resumable-scan");
const { HSIM_TOPICS, decodeHsimLog } = require("./hsim-events");
const { ZERO } = require("./wrapped");

/**
 * Fresh ownership-replay state.
 * @returns {{ owner: Map<string,string>, tokenIdToHsi: Map<string,string>,
 *   ended: Set<string> }}
 */
function newState() {
  return {
    owner: new Map(),
    tokenIdToHsi: new Map(),
    ended: new Set(),
  };
}

/**
 * Apply an ERC-721 NFT transfer (an owner move for a tokenized HSI).
 * @param {object} s
 * @param {{ tokenId: string, from: string, to: string }} ev
 */
function applyNftTransfer(s, ev) {
  const hsi = s.tokenIdToHsi.get(ev.tokenId);
  if (hsi && ev.to !== ZERO) s.owner.set(hsi, ev.to);
}

/**
 * Apply one decoded HSIM event to the replay state.
 * @param {object} s state from newState()
 * @param {object|null} ev decoded event (from decodeHsimLog)
 */
function applyEvent(s, ev) {
  if (!ev) return;
  if (ev.name === "HSIStart" || ev.name === "HSITransfer") {
    s.owner.set(ev.hsi, ev.name === "HSIStart" ? ev.staker : ev.to);
  } else if (ev.name === "HSITokenize") {
    s.tokenIdToHsi.set(ev.tokenId, ev.hsi);
    s.owner.set(ev.hsi, ev.staker);
  } else if (ev.name === "HSIDetokenize") {
    s.tokenIdToHsi.delete(ev.tokenId);
    s.owner.set(ev.hsi, ev.staker);
  } else if (ev.name === "Transfer") {
    applyNftTransfer(s, ev);
  } else if (ev.name === "HSIEnd") {
    s.ended.add(ev.hsi);
  }
}

/**
 * Final hsiAddr -> owner map for non-ended HSIs.
 * @param {object} s
 * @returns {Map<string, string>}
 */
function finalizeOwners(s) {
  const out = new Map();
  for (const [hsi, o] of s.owner) {
    if (!s.ended.has(hsi)) out.set(hsi, o);
  }
  return out;
}

/**
 * Serialize the replay state to a JSON-safe snapshot (Maps/Set -> arrays).
 * @param {object} s
 * @returns {object}
 */
function serializeState(s) {
  return {
    owner: [...s.owner],
    tokenIdToHsi: [...s.tokenIdToHsi],
    ended: [...s.ended],
  };
}

/**
 * Rehydrate replay state from a snapshot, mutating `s` in place.
 * @param {object} s
 * @param {object} snap
 */
function restoreState(s, snap) {
  s.owner = new Map(snap.owner);
  s.tokenIdToHsi = new Map(snap.tokenIdToHsi);
  s.ended = new Set(snap.ended);
}

/**
 * Replay the HSIM ownership log into a chain's HSI -> owner map (as of toBlock),
 * resumably: `opts.load` / `opts.save` (supplied by the resolve stage) checkpoint
 * the replay state + block cursor in batches, so an interrupted replay resumes
 * instead of restarting.
 * @param {object} client guarded RPC client
 * @param {object} opts { hsim, fromBlock, toBlock, startChunk, signal?,
 *   onProgress?, load?, save?, prior? } — `prior` (a serializeState snapshot)
 *   seeds the replay so an incremental scan extends it over the new range only.
 * @returns {Promise<{ owners: Map<string, string>, snapshot: object }>}
 */
async function buildHsiOwnership(client, opts) {
  const { hsim, fromBlock, toBlock, startChunk, signal, onProgress } = opts;
  const s = newState();
  if (opts.prior) restoreState(s, opts.prior); // extend a prior cycle's replay
  const span = Math.max(1, toBlock - fromBlock);
  await runResumableLogScan(client, {
    address: hsim,
    topics: [HSIM_TOPICS],
    fromBlock,
    toBlock,
    startChunk,
    signal,
    state: s,
    applyLogs: (st, logs) => {
      for (const log of logs) applyEvent(st, decodeHsimLog(log));
    },
    serialize: serializeState,
    restore: restoreState,
    load: opts.load ?? (() => null),
    save: opts.save ?? (() => {}),
    onProgress: onProgress
      ? (p) => onProgress(Math.min(1, Math.max(0, (p.to - fromBlock) / span)))
      : undefined,
  });
  return { owners: finalizeOwners(s), snapshot: serializeState(s) };
}

module.exports = {
  newState,
  applyEvent,
  finalizeOwners,
  buildHsiOwnership,
  serializeState,
  restoreState,
};
