# Architecture

## Contents

- [Overview](#overview)
- [Data flow](#data-flow)
- [Layers](#layers)
- [Key decisions](#key-decisions)
- [Scan architecture](#scan-architecture)

## Overview

A cached pipeline scans the chain and derives report artefacts from it. The
`hexleague` CLI and a local, read-only dashboard are two thin front ends over one
shared core (`src/hexleague.js`).

The **HTTP API layer (`server.js`) and the workhorse core (`src/hexleague.js`)
are kept deliberately separate**, so each is reusable on its own as a component
of another project: `hexleague.js` is a plain library with no HTTP, UI, or server
dependency (`require` it directly), and `server.js` is a thin adapter that maps
routes onto it (mount its `handleRequest` in another server). Neither reaches into
the other.

Nothing signs or writes to chain; only the local cache is written.

## Data flow

`scan` (stake events into `data/<chain>/stakes.ndjson` + a checkpoint) →
`resolve` (HSI ownership via the HSIM + $MAXI per-holder look-through into
`data/<chain>/resolution.json`, so stakes attribute to their true holders) → `oa`
(forward BFS from the OA into `data/<chain>/oa.json`) → `report` (replay the
ledgers, apply the resolution, read the pinned tip once, and write
`out/summary.json`, `report.md`, and the CSVs). Both the CLI and the dashboard
drive this pipeline through `hexleague.update()` (cancellable with
`hexleague.stop()`); lookups (`whereami` and the dashboard) read
`out/summary.json` without touching the chain.

A first run builds this end to end from the deploy block; a **Re-Scan** advances
the pinned tip and extends each stage's cached state over only the new block
range (see [Scan architecture](#scan-architecture)).

## Layers

- **RPC** (`src/rpc/`): a guarded client (bounded concurrency + backoff), adaptive
  `eth_getLogs` chunking, and `trace_filter` streaming (outgoing and incoming).
- **Decode** (`src/decode/`): `data0` BigInt bit extraction; event topics derived
  from the vendored ABI.
- **Scan / cache** (`src/scan/`, `src/cache/`): an append-only NDJSON ledger, a
  resume checkpoint, and an immutable no-TTL cache; the active-shares map is
  replayed on demand rather than stored.
- **Resolve** (`src/resolve/`): re-attributes each active stake to its true
  holder — Native stakes pass through, HSI stakes re-key to the HSIM-resolved
  owner, and the $MAXI wrapper is looked through to its token holders pro-rata
  (exact BigInt, rounding dust conserved). A pure resolver over cached scan
  inputs plus per-kind T-Share subtotals.
- **OA** (`src/oa/`): funding-graph primitives, the BFS, per-asset attribution,
  and orchestration.
- **Report** (`src/report/`): the league ladder (single source of truth), pure
  BigInt formatting, per-view aggregation, and the Markdown / CSV / display
  renderers.
- **Core API** (`src/hexleague.js`): the one facade both front ends call
  (`update` / `stop` / `isRunning` / `whereami`), so the scan lifecycle (a single
  in-process `AbortController`) and lookups live in one place.
- **CLI** (`bin/hexleague.js`, `src/cli/`): a `parseArgs` dispatch that calls the
  core API.
- **Server** (`server.js`): the UI + HTTP layer (static dashboard plus the JSON
  API) that maps each core action to a `hexleague` method and holds no domain
  logic.

## Key decisions

See the "Architecture Decisions" section of `CLAUDE.md`: the immutable cache, the
forward-BFS OA construction, the pure-transform report, the absence of any
CommonJS/ESM mirroring, and BigInt arithmetic throughout.

## Scan architecture

The scan pipeline's methodology and data model are documented under
[`scan/`](scan/):

- [Sea-Creature league spec](scan/hex-sea-creature-league-spec.md) — the full
  specification: stake attribution, wrapped-stake ($MAXI / HSI) look-through, the
  Origin-Address exclusion, and the league ladder.
- [OA-wallet estimation](scan/oa-wallet-estimation.md) — the Origin-Address
  funding-cluster methodology (forward BFS, the ≥20%-funded-within-≤3-hops rule),
  and how a Re-Scan extends the cluster incrementally over the new block range.

Operational details — commands, the `data/<chain>/` cache layout, crash-safety,
the incremental Re-Scan mechanics, and the HTTP API — live in
[`../engineering.md`](../engineering.md).
