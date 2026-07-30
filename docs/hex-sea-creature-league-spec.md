# HEX Sea-Creature League Analysis — Implementation Spec

**Deliverable:** a linted, tested, vanilla **Node.js (JavaScript, CommonJS)**
project that scans the HEX contract on Ethereum and PulseChain via JSON-RPC,
attributes every active stake's T-Shares to a wallet, identifies and excludes the
OA cluster (OA = Origin Address plus OA-funded wallets), and reports the
sea-creature league breakdown of the staking pool for three views: **Ethereum**,
**PulseChain**, and **Combined (ETH + PLS)**. It ships both a CLI pipeline and a
local, read-only **HTML dashboard**, and is meant to be run locally.

> This spec has been reconciled with the decisions made during implementation.
> Where it previously assumed TypeScript/Vitest/viem or a "no UI" scope, it now
> reflects the vanilla-JavaScript stack and the local dashboard that were built.
> Functional requirements remain non-negotiable; the tech stack follows the
> repository conventions in `CLAUDE.md`.

---

## 1. Definitions

- **T-Share** = 10^12 raw contract "shares". All report figures are in T-Shares
  (3 decimals in reports; exact BigInt raw shares internally — never floats).
- **Heart** = 10^-8 HEX (HEX has 8 decimals).
- **Active stake** = a stake with a `StakeStart` event and no subsequent
  `StakeEnd`, and not good-accounted. `StakeGoodAccounting` removes a stake's
  shares from the global pool even though the row persists until `StakeEnd` —
  treat GA'd stakes as 0 shares from the GA block onward.
- **OA cluster** (the exclusion set): a staking wallet is OA when it is
  **>= 20% funded by the OA within <= 3 hops** of the funding tree, for **either**
  asset (HEX or native coin), plus the Origin Address itself. Contracts are
  terminal (recorded but not propagated). Both the hop cap (`OA_MAX_HOPS`,
  default 3) and the threshold (`OA_FUNDING_THRESHOLD`, default 0.20) are
  env-tunable. The full methodology — including why a forward BFS from the OA is
  the efficient equivalent of reverse-spidering from every staker — is in
  [oa-wallet-estimation.md](oa-wallet-estimation.md).
- **League ladder** — the highest tier whose threshold (share of the non-OA
  staked T-Share pool) a wallet meets or exceeds. Emoji + names come from the
  project's Google-Sheet design; thresholds are authoritative.

  | Rank | League | Threshold (% of pool) |
  | ---- | ------ | --------------------- |
  | 1 | 🔱 Prosperous Poseidon | 10% |
  | 2 | 🐋 Winning Whale | 1% |
  | 3 | 🦈 Super Shark | 0.1% |
  | 4 | 🐬 Dabbing Dolphin | 0.01% |
  | 5 | 🦑 Swifty Squid | 0.001% |
  | 6 | 🐢 Tinkering Turtle | 0.0001% |
  | 7 | 🦀 Cool Crab | 0.00001% |
  | 8 | 🦐 Shy Shrimp | 0.000001% |
  | 9 | 🐚 Silent Shell | 0.0000001% |
  | — | 🦠 Plankton | below Shell |

  A wallet is counted once, in the highest league it qualifies for, using exact
  BigInt cross-multiplication. (`🌊 Wide Ocean`, the source sheet's >= 100% label,
  cannot occur for a single non-OA wallet and is kept only as a legend entry.)

---

## 2. Constants and endpoints

```text
HEX contract (identical address on both chains):
  0x2b591e99afE9f32eAA6214f7B7629768c40Eeb39

Origin Address (OA), same on both chains:
  0x9A6a414D6F3497c05E3b1De90520765fA1E07c03

Ethereum RPC   : https://rpc-ethereum.g4mm4.io   (chainId 1)    — Erigon
PulseChain RPC : https://rpc-pulsechain.g4mm4.io (chainId 369)  — Erigon
```

- RPC URLs come from `.env` (`ETH_RPC_URL`, `PLS_RPC_URL`) with the above as
  documented defaults in `.env.example`.
- The HEX deploy block is **not trusted from any constant**: at startup it is
  found by binary-searching `eth_getCode` per chain and cached. Each chain is
  scanned independently from its discovered deploy block.
- **ABI**: the verified HEX ABI JSON is vendored as `src/abi/hex.json`. All event
  topics and function selectors are derived from it via ethers at runtime — never
  hardcoded. `StakeStart.data0` is a packed uint256 (stakeShares in bits
  112–183, stakedHearts in bits 40–111), extracted with BigInt masking and
  verified empirically against `stakeLists` (see §8).

Read functions used: `globalInfo()`, `currentDay()`, `stakeCount(address)`,
`stakeLists(address,uint256)`, `balanceOf(address)`, `totalSupply()`.

---

## 3. Tech stack and project standards

- Node >= 22, **vanilla JavaScript (CommonJS)**, no build step for the server.
- RPC library: **ethers v6** (`client.send()` for `trace_filter`).
- CLI: Node built-in `node:util` `parseArgs`, single `hexleague` entry with
  subcommands:

  ```text
  hexleague verify   [--chain eth|pls]
  hexleague scan     --chain eth|pls [--rebuild]
  hexleague oa       --chain eth|pls [--rebuild]
  hexleague report
  hexleague whereami --address 0x… [--address 0x…] | --tshares N
  ```

- Lint/format: ESLint v10 flat config + Prettier + Stylelint + html-validate +
  markdownlint + secretlint + github-actionlint. `npm run check` must pass clean.
- Tests: Node built-in `node:test` + `node:assert/strict`, fixture-based, with a
  line-coverage floor of 80%.
- **Caching / resume is mandatory and immutable.** Long scans persist progress
  (`data/<chain>/checkpoint.json` + append-only NDJSON) and resume after
  interruption. Because chain data never changes there is **no TTL**: re-running
  a step performs an incremental top-up from the last scanned block. Footprint is
  minimized — the stake ledger stores only the fields needed to rebuild state
  (event code, staker, stakeId, shares on `StakeStart`, block); it does not store
  tx hashes or raw logs, and the active-shares map is recomputed by replaying the
  ledger rather than cached separately.
- Rate limiting: bounded concurrency (default 4, env-tunable) with exponential
  backoff + jitter on 429/5xx/timeout. Adaptive `eth_getLogs` chunking (start
  50,000 blocks ETH / 100,000 PLS; halve on over-large responses; grow on
  success). Be a polite client of the public endpoints.
- No API keys, no external indexers, no price feeds. Chain + RPC only.

---

## 4. Stage 1 — stake ledger scan (`scan`)

1. One `eth_getLogs` filter (`address = HEX`, topics = the three stake events),
   chunked from the deploy block to a **pinned tip** (~64 blocks behind head;
   the same tip is used for every stage and reported as the as-of point).
2. Decode each log to a minimal row `{ e, s, i, h?, b }` = event code, staker
   (lowercased), stakeId, shares (only on `StakeStart`), block number.
3. Persist rows as append-only NDJSON; build state on load:
   `active[staker:stakeId] = shares`, deleted on `StakeEnd` /
   `StakeGoodAccounting`.
4. Result per chain: `Map<address, bigint totalActiveShares>` (zeros dropped),
   rebuilt by replaying the NDJSON.

Scale: order 10^5–10^6 logs per chain; tens of minutes per chain at polite
concurrency; progress is emitted per window.

---

## 5. Stage 2 — pool totals (read calls)

At the pinned tip block, capture `globalInfo()` (`stakeSharesTotal` index 5,
`nextStakeSharesTotal` index 1, `shareRate` index 2), `currentDay()`, and
`totalSupply()`, plus the tip block timestamp. These are cached in
`data/<chain>/tip.json` (so report/whereami/dashboard run offline) and are used
for reconciliation (§8) and report headers.

---

## 6. Stage 3 — OA cluster construction (`oa`)

Build the OA cluster per the rule in §1 and the methodology in
[oa-wallet-estimation.md](oa-wallet-estimation.md):

1. **Forward BFS from the OA** to `OA_MAX_HOPS`, over HEX `Transfer` (from-topic
   filter) and native `trace_filter` (`fromAddress`, includes internal
   transfers), accumulating per-asset OA-attributed inflow and capped evidence.
   Contracts (`eth_getCode != 0x`) are terminal: recorded in a review list, never
   propagated.
2. For each reached wallet that is an **active staker**, fetch its total inbound
   (HEX + native, batched) and classify it as OA when
   `oaInflow / totalInbound >= OA_FUNDING_THRESHOLD` for either asset.
3. Output `data/<chain>/oa.json` with the Origin Address, the members
   (address, hop depth, funding predecessor, per-asset fractions, evidence tx
   hashes), the contracts-seen review list, and the parameters used. Every member
   carries at least one evidence tx hash so the list is independently auditable.
   `eth_getCode` results are cached in `data/<chain>/codes.json` (immutable).

---

## 7. Stage 4 — classification, aggregation, report (`report`) + dashboard

For each view **V ∈ {eth, pls, combined}** (combined = per-address sum of both
chains' active shares):

1. `poolNonOA(V) = totalActiveShares(V) − shares(OA cluster)`.
2. Thresholds per league = ladder % × `poolNonOA` (exact BigInt).
3. Bucket every non-OA wallet into its highest league; below Shell is Plankton.
4. Emit under `out/`:
   - `report.md` — the centerpiece of each view is the **Sea Creature Table**
     (League, % of pool, Min T-Shares (≥), ~HEX for a new stake today, Wallets in
     tier, Cumulative wallets, Tier aggregate T-Shares, Tier % of non-OA pool),
     plus the top-50 non-OA stakers and headline (as-of block/time per chain,
     pool total, OA excluded shares/count, non-OA staker count). The boundary
     rule is stated in the report. `~HEX for a new stake today` is a footnoted
     orientation figure from the current base share rate (LPB/BPB bonuses reduce
     the actual HEX required); it is omitted for the Combined view (two share
     rates).
   - `leagues_{eth,pls,combined}.csv` — the full non-OA ranking (rank, address,
     tshares, pct_of_nonoa_pool, percentile, league, is_contract, oa_flag).
   - `oa_wallets.csv` — the evidence-backed OA cluster.
   - `summary.json` — machine-readable everything above (thresholds, rankings,
     pre-formatted display strings); powers `whereami` and the dashboard.
5. **Self-lookup — `hexleague whereami`**: input one or more `--address` (summed)
   or a raw `--tshares N`; output per view the T-Share total, tier, rank among
   non-OA stakers, percentile, and T-Share distance to the next tier up. OA
   addresses are called out explicitly instead of ranked. Reads
   `out/summary.json`; errors clearly if `report` has not run.
6. **Dashboard** (`npm start`, `server.js`): a local, read-only HTML dashboard
   (Node `http` module) that renders the three views and an interactive whereami
   over `GET /api/summary` and `GET /api/whereami` (the latter reuses the same
   lookup module as the CLI). No state-changing routes, no keys. The disclaimer
   is shown in the footer.

---

## 8. Validation (must pass before the report is trusted)

1. **Global reconciliation, per chain**: Σ of all active shares from the event
   scan must equal `stakeSharesTotal + nextStakeSharesTotal` from `globalInfo()`
   at the pinned tip, exactly (integer equality). A mismatch indicates a decoding
   or state-machine bug and is surfaced prominently.
2. **Sample cross-check**: for a sample of stakers, read `stakeCount` + iterate
   `stakeLists` at the tip and compare per-staker share sums to the event-derived
   sums; this also empirically validates the `data0` bit layout.
3. **Sanity**: active staker counts should land near public aggregates; OA is
   expected to have `stakeCount(OA) = 0`.
4. `verify` runs chainId, deploy-block, and ABI-topic checks.

---

## 9. Acceptance criteria

- [ ] `npm run lint`, `npm test`, and `npm run check` all pass clean.
- [ ] The pipeline `verify → scan (eth, pls) → oa (eth, pls) → report` completes
      end-to-end with only the two RPC URLs configured.
- [ ] Reconciliation (§8.1) holds exactly on both chains.
- [ ] Interrupting any scan mid-run and re-invoking resumes without data loss.
- [ ] `out/report.md` contains all three views, each with a complete Sea Creature
      Table (min-T-Share thresholds, per-tier and cumulative wallet counts, tier
      aggregates) and the top-50 ranking.
- [ ] `hexleague whereami --tshares 42` and `--address <scanned staker>` return
      T-Share total, tier, rank, percentile, and distance to the next tier for all
      three views.
- [ ] `npm start` serves the dashboard with the three views and whereami.
- [ ] Every OA-cluster member in `out/oa_wallets.csv` has >= 1 evidence tx hash.
- [ ] The README documents setup, runtime expectations, and incremental re-runs.

---

## 10. Non-goals

- No USD pricing, no historical time series.
- No 4+ hop funding propagation, no clustering heuristics beyond the funding rule
  in §1.
- No writes to chain; read-only RPC throughout — the tool holds no keys.
