# Engineering Reference

## Commands

`npm run verify | scan | oa | report`, `npm start` (dashboard), `npm run lint`,
`npm test`, `npm run check`. `hexleague` is the bin
(`node bin/hexleague.js <cmd>`).

## The check pipeline

`scripts/check.js` runs every gate (ESLint, Stylelint, html-validate,
markdownlint, Prettier JSON/YAML, actionlint, the three security audits, and
`node --test` with coverage), writes `test/report-artifacts/summary.md`, and
exits non-zero on any failure or coverage below 80%. It moves `data/` and `out/`
aside during the test run and restores them in a `finally`.

## The cache (`data/<chain>/`)

Immutable, no TTL. `deploy-block.json`; `stakes.ndjson` (append-only minimal
rows) + `checkpoint.json` (resume cursor with a `schemaVersion`); `oa.json` +
`codes.json`; `tip.json`. Re-running a step tops up only new blocks; a `--rebuild`
flag discards a chain's ledger. Delete `data/` for a clean rescan. The derived
`out/` artifacts are pure functions of the cache plus one pinned-tip read.

## Seeding the cache (distributing a snapshot)

The `data/<chain>/` cache is regenerable but slow to build from cold — the OA
funding scans are tens of thousands of 5,000-block `getLogs` windows against the
public endpoints (hours per chain). To let a fresh install skip that, the cache
can be distributed as a snapshot and pulled in with `hexleague seed`.

**Size.** A complete cache is ~350–600 MB raw — dominated by `stakes.ndjson` at
~95 B/row (~125 MB for ETH's ~1.3M rows). ndjson gzips ~3.3×, so a snapshot
tarball is roughly **120–180 MB**.

**Where to host it.** A **GitHub Release asset** is the simplest fit: up to
2 GB/asset, no bandwidth cap, free, versioned by tag, beside the code. For larger
or delta-synced snapshots, use object storage with a generous free tier and
cheap/zero egress (Cloudflare R2, Backblaze B2). Do **not** commit the cache:
GitHub blocks files over 100 MB, and it would bloat history with regenerable
data.

**Producing a snapshot** (after a full `hexleague update`):

```bash
tar -czf hex-cache.tar.gz -C data eth pls   # archive both chain caches
sha256sum hex-cache.tar.gz                    # publish this digest alongside it
```

**Seeding from a snapshot** (fresh install, empty `data/`):

```bash
hexleague seed --url https://…/hex-cache.tar.gz --sha256 <digest>
```

`seed` streams the download, verifies the SHA-256 (refusing to extract on any
mismatch), and unpacks into `data/` (declining to clobber a non-empty `data/`
without `--force`). Afterwards, `hexleague update` — or the dashboard's
**Update** button — fetches only the blocks added since the snapshot, bringing
the local cache up to date. The seed is a shortcut past the cold scan, never a
trust root: the checksum is the gate, and every row is verifiable against the
chain.

## Chain views vs. scanning (always both chains)

The app **always scans both Ethereum and PulseChain.** The scan set is never
conditioned on a chain selection — `hexleague update`/`scan`/`oa` process both
chains, and the report bakes all three views (`eth`, `pls`, `combined`) into
`out/summary.json` in a single pass.

The dashboard's **Ethereum / PulseChain / Combined** buttons are a purely
client-side **display filter**: they only choose which pre-computed ranking the
browser renders from the already-loaded summary. Selecting a view issues no RPC,
starts/stops no scan, and never limits which chains are covered. The dashboard
surfaces this with an info tooltip next to the view buttons so users don't read
the selector as a scan scope.

## Adding a module

Keep it at or under 500 non-comment lines and complexity 17, with full JSDoc and
tests. Node code is CommonJS; `public/dashboard-*.js` are browser ES modules
(there is a `public/package.json` marking `type: module`). Run `npm run check`
before committing.

## HTTP API

The dashboard server (`npm start`, port 3693) also serves a complete, read-only
JSON API so the app can be consumed as a dependency by other applications — for
example to obtain a staker's sea-creature level. Endpoints: `GET /api/health`,
`GET /api/whereami` (the key consumer endpoint — `?tshares=N` or `?address=0x…`),
`GET /api/summary`, `GET /api/status`, `POST /api/update`, `GET /api/disclaimer`,
and `GET /api/openapi.json`. The contract is defined in `docs/openapi.json`.

Stand up the interactive API reference (rendered with Scalar — the modern,
maintained OpenAPI reference — self-hosted from `node_modules`, no CDN):

```bash
npm run api-doc
```

Then open `http://127.0.0.1:5556`. The reference reads `docs/openapi.json`; update
that file whenever you add or change an endpoint.

## RPC etiquette

Bounded concurrency (`CONCURRENCY`, default 4), exponential backoff with jitter,
adaptive `eth_getLogs` chunking, and `trace_filter` pagination — the public
g4mm4 endpoints are shared infrastructure, so the scanner stays polite.
