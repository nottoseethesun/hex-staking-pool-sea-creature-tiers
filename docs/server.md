# Running Headless — CLI Pipeline, Configuration & HTTP API

Everything the dashboard does is also available without a browser. The dashboard
is a thin, read-only front end over the same pipeline and data files you can
drive from the command line, and over a small HTTP API that other applications
can call. This guide covers the granular CLI pipeline, all configuration and RPC
failover, and the HTTP API.

For the dashboard-user quick start, see the [README](../README.md).

---

## Command-Line Pipeline

The dashboard's one-shot `update` command is a convenience wrapper around a
granular pipeline you can run one stage at a time:
**verify → scan → oa → report → whereami**. Scans are cached and incremental, so
re-running any step tops up only the new blocks.

```bash
# 1. Sanity-check connectivity, chain ids, and the deploy blocks.
node bin/hexleague.js verify

# 2. Scan the stake ledgers (long the first time; incremental after).
node bin/hexleague.js scan --chain eth
node bin/hexleague.js scan --chain pls

# 3. Build the OA funding clusters.
node bin/hexleague.js oa --chain eth
node bin/hexleague.js oa --chain pls

# 4. Build the report (out/report.md, out/summary.json, out/leagues_*.csv).
node bin/hexleague.js report

# 5a. Locate yourself from the terminal.
node bin/hexleague.js whereami --address 0xYourWallet
node bin/hexleague.js whereami --tshares 42

# 5b. Or open the dashboard.
npm start   # http://127.0.0.1:3693
```

The first full scan takes on the order of tens of minutes per chain (it is a
polite client of the public endpoints). If interrupted, just run the same
command again — it resumes from the last checkpoint.

Expected scale: on the order of 10^5–10^6 stake logs per chain, and active
staker counts near public aggregates.

---

## Configuration

No configuration is required — every value ships with a working default. Shipped
defaults live in the `config/` JSON files; environment variables override the
environment-facing ones.

### Config files (`config/`)

- `chains.json` — per-chain id, name, primary and backup RPC endpoints,
  starting log-chunk size, and approximate deploy block.
- `contracts.json` — the HEX contract address and the Origin Address (OA).
- `tuning.json` — concurrency, retry/backoff, native trace-chunk, batch sizes,
  evidence cap, OA hops/threshold, and the top-contract cap.
- `server.json` — the dashboard port and host.
- `leagues.json` — the sea-creature ladder (tiers, emoji, names, plus Plankton
  and the Wide Ocean guard label).

### Environment overrides (`.env`)

Copy `.env.example` to `.env` and edit only the keys you want to override.

| Key | Default | Purpose |
| --- | --- | --- |
| `ETH_RPC_URL` | g4mm4 Ethereum node | Ethereum JSON-RPC endpoint. |
| `PLS_RPC_URL` | g4mm4 PulseChain node | PulseChain JSON-RPC endpoint. |
| `PORT` | `3693` | Dashboard server port. |
| `HOST` | `127.0.0.1` | Dashboard bind address (localhost only). |
| `CONCURRENCY` | `4` | Max concurrent in-flight RPC requests per chain. |
| `TIP_LAG_BLOCKS` | `64` | Blocks to stay behind chain head when pinning the tip. |
| `ETH_LOG_CHUNK` | `5000` | Starting `eth_getLogs` block window (Ethereum). |
| `PLS_LOG_CHUNK` | `5000` | Starting `eth_getLogs` block window (PulseChain). |
| `OA_MAX_HOPS` | `3` | Max hops back through the funding tree from a staker. |
| `OA_FUNDING_THRESHOLD` | `0.20` | Min OA-funded fraction, per asset, to flag a wallet as OA. |
| `RPC_CACHE` | off | Set to `1` to memoize RPC responses to disk while iterating. |

See `.env.example` for the complete, annotated list.

### RPC failover and backup endpoints

Each chain has a primary and a backup RPC endpoint (`config/chains.json`). On a
transient failure (429 / 5xx / timeout / network) the client rotates
primary → backup → primary → … with exponential backoff and jitter, logging a
warning per failure. Override either endpoint from the environment with
`ETH_RPC_URL_FALLBACK` or `PLS_RPC_URL_FALLBACK`.

For Ethereum, the recommended backup is an [Ankr](https://www.ankr.com) endpoint,
configured with a private API key that is kept out of the repository:

```bash
cp config/secrets.example.json config/secrets.json
# then edit config/secrets.json and set "ankrEthApiKey" to your key
```

`config/secrets.json` is gitignored. The client builds
`https://rpc.ankr.com/eth/<key>` from it and uses it as the Ethereum backup (an
explicit `ETH_RPC_URL_FALLBACK` environment value still takes precedence). The
key never appears in tracked config or in logs.

---

## HTTP API

The app exposes a **full, read-only HTTP API** so other applications can pull it
in as a dependency and obtain a staker's sea-creature level programmatically. It
is served by the same local process (`npm start`, `http://127.0.0.1:3693`):

- `GET /api/health` — liveness and version.
- `GET /api/whereami?tshares=N` (or `?address=0x…`) — the key consumer endpoint:
  the sea-creature level, rank, percentile, and distance to the next tier, per
  view.
- `GET /api/summary` — the full machine-readable report.
- `GET /api/status` — data freshness and update progress.
- `POST /api/update` — trigger an incremental update.
- `GET /api/disclaimer` — the disclaimer text.
- `GET /api/openapi.json` — the OpenAPI 3.1 description (self-describing API).

Browse the interactive API reference (rendered with
[Scalar](https://scalar.com), self-hosted — no CDN):

```bash
npm run api-doc    # then open http://127.0.0.1:5556
```

The contract lives in [`openapi.json`](openapi.json). See
[engineering.md](engineering.md#http-api) for the implementation details.

---

[← Back to the README](../README.md)
