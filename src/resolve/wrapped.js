/**
 * @file src/resolve/wrapped.js
 * @description Look-through for non-skim wrapper tokens (e.g. Maximus $MAXI). The
 * wrapper contract holds HEX-stake T-Shares; ownership of those T-Shares belongs
 * to the token holders, so we distribute the wrapper's wrapped T-Shares to each
 * holder pro-rata by token balance. `distribute` is the pure share-out (exact
 * BigInt floor, remainder returned as dust); `foldTransfers`/`scanWrapperBalances`
 * reconstruct holder balances and circulating supply from the token's ERC-20
 * Transfer log (same layout as HEX, so the shared Interface decodes it).
 */

"use strict";

const { runResumableLogScan } = require("../cache/resumable-scan");
const { TRANSFER_TOPIC, iface } = require("../decode/stake-events");

/** The zero address — ERC-20 mint source / burn sink. */
const ZERO = "0x0000000000000000000000000000000000000000";

/**
 * Distribute `totalShares` across `balances` pro-rata by balance, using exact
 * BigInt floor division. The unallocated remainder (rounding dust) is returned so
 * the caller can conserve the total exactly.
 * @param {bigint} totalShares wrapped T-Shares to share out (e.g. T_maxi)
 * @param {Map<string, bigint>} balances holder (lowercased) -> token balance
 * @param {bigint} supply total token supply; should equal the sum of balances
 * @returns {{ perHolder: Map<string, bigint>, dust: bigint }}
 */
function distribute(totalShares, balances, supply) {
  const perHolder = new Map();
  if (totalShares <= 0n || supply <= 0n) {
    return { perHolder, dust: totalShares > 0n ? totalShares : 0n };
  }
  let allocated = 0n;
  for (const [holder, bal] of balances) {
    if (bal <= 0n) continue;
    const share = (bal * totalShares) / supply;
    if (share > 0n) {
      perHolder.set(holder, share);
      allocated += share;
    }
  }
  return { perHolder, dust: totalShares - allocated };
}

/**
 * Apply a signed delta to an address balance (BigInt-safe).
 * @param {Map<string, bigint>} balances
 * @param {string} addr lowercased address
 * @param {bigint} delta
 */
function addSigned(balances, addr, delta) {
  balances.set(addr, (balances.get(addr) ?? 0n) + delta);
}

/**
 * Apply one ERC-20 transfer to a running balance map (ZERO = mint / burn).
 * @param {Map<string, bigint>} balances
 * @param {{ from: string, to: string, value: bigint }} t
 */
function applyTransfer(balances, t) {
  if (t.from !== ZERO) addSigned(balances, t.from, -t.value);
  if (t.to !== ZERO) addSigned(balances, t.to, t.value);
}

/**
 * Drop non-positive balances and compute circulating supply (sum of holders).
 * @param {Map<string, bigint>} balances
 * @returns {{ balances: Map<string, bigint>, supply: bigint }}
 */
function finalizeBalances(balances) {
  let supply = 0n;
  for (const [addr, v] of balances) {
    if (v <= 0n) balances.delete(addr);
    else supply += v;
  }
  return { balances, supply };
}

/**
 * Reconstruct holder balances + supply from an iterable of ERC-20 transfers.
 * @param {Iterable<{ from: string, to: string, value: bigint }>} transfers
 * @returns {{ balances: Map<string, bigint>, supply: bigint }}
 */
function foldTransfers(transfers) {
  const balances = new Map();
  for (const t of transfers) applyTransfer(balances, t);
  return finalizeBalances(balances);
}

/**
 * Decode a batch of ERC-20 Transfer logs and apply each to the balance map.
 * @param {Map<string, bigint>} balances
 * @param {object[]} logs
 */
function applyTransferLogs(balances, logs) {
  for (const row of logs) {
    const parsed = iface.parseLog({ topics: row.topics, data: row.data });
    if (!parsed || parsed.name !== "Transfer") continue;
    applyTransfer(balances, {
      from: parsed.args.from.toLowerCase(),
      to: parsed.args.to.toLowerCase(),
      value: parsed.args.value,
    });
  }
}

/**
 * Serialize balance-scan state to a JSON-safe snapshot (BigInt -> string).
 * @param {{ balances: Map<string, bigint> }} st
 * @returns {object}
 */
function serializeBalances(st) {
  return { balances: [...st.balances].map(([a, v]) => [a, v.toString()]) };
}

/**
 * Rehydrate balance-scan state from a snapshot, mutating `st` in place.
 * @param {{ balances: Map<string, bigint> }} st
 * @param {object} snap
 */
function restoreBalances(st, snap) {
  st.balances = new Map(snap.balances.map(([a, v]) => [a, BigInt(v)]));
}

/**
 * Scan a wrapper token's ERC-20 Transfer log and reconstruct holder balances +
 * circulating supply as of `toBlock`, resumably: `opts.load` / `opts.save`
 * (supplied by the resolve stage) checkpoint the balance map + block cursor in
 * batches, so an interrupted scan resumes instead of restarting.
 * @param {object} client guarded RPC client
 * @param {object} opts { token, fromBlock, toBlock, startChunk, signal?,
 *   onProgress?, load?, save? }
 * @returns {Promise<{ balances: Map<string, bigint>, supply: bigint }>}
 */
async function scanWrapperBalances(client, opts) {
  const { token, fromBlock, toBlock, startChunk, signal, onProgress } = opts;
  const state = { balances: new Map() };
  const span = Math.max(1, toBlock - fromBlock);
  await runResumableLogScan(client, {
    address: token,
    topics: [TRANSFER_TOPIC],
    fromBlock,
    toBlock,
    startChunk,
    signal,
    state,
    applyLogs: (st, logs) => applyTransferLogs(st.balances, logs),
    serialize: serializeBalances,
    restore: restoreBalances,
    load: opts.load ?? (() => null),
    save: opts.save ?? (() => {}),
    onProgress: onProgress
      ? (p) => onProgress(Math.min(1, Math.max(0, (p.to - fromBlock) / span)))
      : undefined,
  });
  return finalizeBalances(state.balances);
}

module.exports = {
  distribute,
  foldTransfers,
  scanWrapperBalances,
  serializeBalances,
  restoreBalances,
  ZERO,
};
