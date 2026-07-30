# Architecture

## Overview

A CLI pipeline produces an immutable, cached scan of the chain and derives report
artifacts from it; a read-only dashboard serves those artifacts. Nothing writes
to chain.

## Data flow

`scan` (stake events into `data/<chain>/stakes.ndjson` + a checkpoint) → `oa`
(forward BFS from the OA into `data/<chain>/oa.json`) → `report` (replay the
ledgers, read the pinned tip once, and write `out/summary.json`, `report.md`, and
the CSVs). `whereami` and the dashboard read `out/summary.json` and never touch
the chain.

## Layers

- **RPC** (`src/rpc/`): a guarded client (bounded concurrency + backoff), adaptive
  `eth_getLogs` chunking, and `trace_filter` streaming (outgoing and incoming).
- **Decode** (`src/decode/`): `data0` BigInt bit extraction; event topics derived
  from the vendored ABI.
- **Scan / cache** (`src/scan/`, `src/cache/`): an append-only NDJSON ledger, a
  resume checkpoint, and an immutable no-TTL cache; the active-shares map is
  replayed on demand rather than stored.
- **OA** (`src/oa/`): funding-graph primitives, the BFS, per-asset attribution,
  and orchestration.
- **Report** (`src/report/`): the league ladder (single source of truth), pure
  BigInt formatting, per-view aggregation, and the Markdown / CSV / display
  renderers.
- **Server** (`server.js`): the static dashboard plus two read-only GET
  endpoints; the whereami logic is shared with the CLI.

## Key decisions

See the "Architecture Decisions" section of `CLAUDE.md`: the immutable cache, the
forward-BFS OA construction, the pure-transform report, the absence of any
CommonJS/ESM mirroring, and BigInt arithmetic throughout.
