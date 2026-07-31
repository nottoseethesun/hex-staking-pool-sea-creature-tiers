# How OA Wallets Are Estimated

This document describes, in full, how the tool decides that a staking wallet
belongs to the **OA cluster** — the set of wallets funded by the Origin Address
(OA) — and is therefore excluded from the sea-creature league pool. It is an
**estimate**, not ground truth; the limitations are spelled out at the end.

## Contents

- [Why exclude the OA cluster at all](#why-exclude-the-oa-cluster-at-all)
- [The rule](#the-rule)
  - [Why 3 hops instead of 1–2](#why-3-hops-instead-of-12)
  - [Why "20% of inbound", per asset](#why-20-of-inbound-per-asset)
- [How it is computed (and why it is efficient)](#how-it-is-computed-and-why-it-is-efficient)
  - [Step 1 — forward funding BFS (numerator)](#step-1--forward-funding-bfs-numerator)
  - [Step 2 — per-candidate inbound (denominator)](#step-2--per-candidate-inbound-denominator)
- [Evidence and auditability](#evidence-and-auditability)
- [Caching](#caching)
- [Tunables](#tunables)
- [Limitations — why this is an estimate](#limitations--why-this-is-an-estimate)

## Why exclude the OA cluster at all

The point of the league report is to describe the *community* staking pool. The
Origin Address and the wallets it seeded or gas-funded can dominate the raw
numbers and distort every tier. Removing them yields a truer picture of
independent stakers. Because "funded by the OA" is fuzzy, the tool uses an
explicit, auditable, tunable rule rather than a hand-curated list.

## The rule

A staking wallet is classified as **OA** when at least **20%** of its inbound
value — for **either** asset, HEX or the native coin (ETH / PLS) — is
attributable to the OA within **at most 3 hops** of the funding tree.

- Hop cap: `OA_MAX_HOPS` (default **3**).
- Threshold: `OA_FUNDING_THRESHOLD` (default **0.20**).
- The Origin Address itself is always in the cluster.

### Why 3 hops instead of 1–2

Large holders have been observed whose *gas* was funded through a single
distributor account — `OA → distributor → wallet`, and sometimes one hop deeper.
A 1- or 2-hop pass misses the tail of that tree. Searching back at least three
hops from each current staker catches the distributor-of-distributor pattern.

### Why "20% of inbound", per asset

Money is fungible, so "funded by the OA" is expressed as a fraction of a wallet's
total inbound value. There is **no price feed** in this tool (by design), so HEX
value and native value cannot be added together. The fraction is therefore
computed **independently per asset**, and a wallet qualifies if **either** the
HEX fraction or the native fraction reaches the threshold. This captures both
"seeded with HEX by the OA" and "gas-funded by the OA".

## How it is computed (and why it is efficient)

Conceptually the question is asked *of each staker*: "walking back through who
funded me, up to 3 hops, does the OA supply at least 20% of my inbound?" Doing
that literally would mean a reverse breadth-first search from every one of
~236,000 stakers — enormous RPC load.

The tool instead runs a single **forward BFS from the OA**. The set of wallets
reachable from the OA within ≤3 hops is *provably identical* to the set you would
find by reverse-spidering ≤3 hops from every staker — but it is rooted at one
address instead of hundreds of thousands. The forward pass yields, per reached
wallet, the **OA-attributed inflow** (the numerator) per asset. Then, only for
the reached wallets that are actually active stakers, the tool fetches each
wallet's **total inbound** (the denominator) — batched — and applies the per-asset
threshold.

### Step 1 — forward funding BFS (numerator)

Starting from the OA, at each hop the tool collects value transfers **out of**
the current frontier:

- **HEX**: `eth_getLogs` for `Transfer` events with the sender in the frontier
  (topic-position filter, batched).
- **Native coin**: Erigon `trace_filter` with `fromAddress` in the frontier —
  this includes *internal* transfers, which is the whole reason to use traces.

For each recipient, the OA-attributed inflow is accumulated per asset, along with
a small amount of **evidence** (up to a few transaction hashes). Recipients that
are contracts are classified with `eth_getCode` and treated as **terminal**:
they are recorded in a review list but never propagated, so an OA → Uniswap-pair
sell cannot taint every downstream buyer. Recipients that are EOAs become the
next hop's frontier, until the hop cap is reached.

### Step 2 — per-candidate inbound (denominator)

For each reached wallet that is an active staker, the tool fetches its **total**
inbound value (HEX via `Transfer` to-position logs; native via `trace_filter`
`toAddress`), batched across candidates. The OA-funded fraction for an asset is
`oaInflow / totalInbound`, guarded against divide-by-zero. If the HEX fraction or
the native fraction is at least the threshold, the wallet is an OA member.

## Evidence and auditability

Every OA member in `out/oa_wallets.csv` carries at least one evidence transaction
hash, plus its hop depth, the wallet that funded it, and its per-asset fractions.
The list is meant to be independently checkable on a block explorer. Contracts
encountered along the way are reported separately (they are legitimately non-OA
but each may represent many underlying holders).

## Caching

The scan is cache-aware and, because chain data is immutable, has **no expiry**.
`eth_getCode` results are cached in `data/<chain>/codes.json` (an address's
contract status does not change once deployed). The OA cluster is written to
`data/<chain>/oa.json` and reused when the pinned tip is unchanged; when the tip
advances, the cluster is rebuilt (the OA-rooted scan is far cheaper than the full
stake-ledger scan).

## Tunables

| Setting | Env var | Default | Effect |
| ------- | ------- | ------- | ------ |
| Max hops | `OA_MAX_HOPS` | 3 | How far back the funding tree is searched. |
| Threshold | `OA_FUNDING_THRESHOLD` | 0.20 | Minimum per-asset OA-funded fraction to classify. |

## Limitations — why this is an estimate

- **Fungibility.** "20% of inbound value from the OA" is a heuristic; funds mix,
  and no attribution model perfectly reflects intent.
- **Per-asset, no pricing.** HEX and native fractions are evaluated separately;
  a wallet whose only OA link is a small gas top-up can still qualify on the
  native axis. That is deliberate (gas-funding is exactly the signal of
  interest), but it can over-classify.
- **Contract terminality.** Value that flows OA → contract → wallet is not
  propagated, so genuinely OA-linked wallets funded *through* a contract are not
  caught. This is a deliberate trade to avoid tainting entire exchange order
  books.
- **Hop cap.** Funding four or more hops removed from the OA is out of scope.
- **Tip sensitivity.** Membership is computed as of a pinned tip; later transfers
  can change it on the next run.

The OA1 headline in the report uses this cluster; the numbers should be read as a
principled, auditable estimate that can be tuned, not as a definitive roster.
