# Engineering Reference

## Contents

- [Commands](#commands)
  - [npm scripts](#npm-scripts)
  - [The `hexleague` CLI](#the-hexleague-cli)
- [The check pipeline](#the-check-pipeline)
- [The cache (`data/<chain>/`)](#the-cache-datachain)
- [Crash safety and recovery](#crash-safety-and-recovery)
- [Seeding the cache (distributing a snapshot)](#seeding-the-cache-distributing-a-snapshot)
- [Chain views vs. scanning (always both chains)](#chain-views-vs-scanning-always-both-chains)
- [Adding a module](#adding-a-module)
- [HTTP API](#http-api)
  - [Starting and stopping a scan](#starting-and-stopping-a-scan)
  - [Stopping the server](#stopping-the-server)
- [RPC etiquette](#rpc-etiquette)

## Commands

### npm scripts

Invoke with `npm run <name>` (except `npm start` and `npm test`). The chain-data
scripts are thin wrappers over [the `hexleague` CLI](#the-hexleague-cli) below.

Run & dashboard:

| Command | Purpose |
| --- | --- |
| `npm start` | Start the read-only dashboard at `http://127.0.0.1:3693`. |
| `npm stop` | Stop the dashboard server (SIGTERM via its PID file). |
| `npm run dev` | Dashboard with `node --watch` (auto-restart on server edits). |
| `npm run build` | Write `src/build-info.json` (version + commit stamp). |

Chain-data pipeline (thin wrappers over `hexleague`):

| Command | Purpose |
| --- | --- |
| `npm run verify` | Check chainId, deploy block, and ABI sanity. |
| `npm run scan` | Scan / top up the stake ledger into `data/<chain>/`. |
| `npm run resolve` | Resolve HSI ownership + $MAXI look-through into `data/<chain>/`. |
| `npm run oa` | Build the OA funding cluster into `data/<chain>/`. |
| `npm run report` | Build `out/` (summary.json, report.md, CSVs) from the cache. |
| `npm run update` | The whole pipeline: scan → resolve → oa → report, both chains. |
| `npm run seed` | Import a verified cache snapshot. |
| `npm run whereami` | Locate a T-Share total or address in the leagues. |

Lint & format:

| Command | Purpose |
| --- | --- |
| `npm run lint` | Every linter (ESLint, Stylelint, html-validate, markdownlint, Prettier, actionlint). |
| `npm run lint:html` | Just html-validate on `public/*.html`. |
| `npm run lint:fix` | Auto-fix what the linters can, in place. |
| `npm run format` | Prettier `--write` the JS sources. |
| `npm run format:check` | Prettier `--check` the JS sources. |

Test & gate:

| Command | Purpose |
| --- | --- |
| `npm test` | Run the unit tests (`node --test`). |
| `npm run test:coverage` | Tests with line coverage. |
| `npm run test:watch` | Tests in watch mode. |
| `npm run check` | The full gate: lint + audits + tests + >=80% coverage (CI runs this). |

Security audits:

| Command | Purpose |
| --- | --- |
| `npm run audit:deps` | `npm audit --audit-level=high`. |
| `npm run audit:security` | Security-focused ESLint (`eslint-security.config.js`). |
| `npm run audit:secrets` | secretlint scan for committed secrets. |
| `npm run knip` | Report unused files, dependencies, and exports. |

API docs & meta:

| Command | Purpose |
| --- | --- |
| `npm run api-doc` | Serve the Scalar API reference at `http://127.0.0.1:5556`. |
| `npm run show-api-doc` | Serve the API reference if needed, then open a browser. |
| `npm run publish-cache` | Publish the cache as the GitHub Release asset (maintainer; stops/restarts the sync; needs `gh`). |
| `npm run nuke` | Remove `node_modules` + `package-lock.json`, then reinstall. |

Lifecycle hooks run automatically: `prestart` / `prelint` (regenerate
build-info) and `prepare` (install husky's git hooks).

### The `hexleague` CLI

`node bin/hexleague.js <command>` (or `hexleague <command>` when the bin is on
`PATH`). Each subcommand parses its own flags; `hexleague --help` prints a
summary.

| Command | Flags | Purpose |
| --- | --- | --- |
| `verify` | `[--chain eth\|pls]` | chainId, deploy block, ABI sanity (both chains if `--chain` omitted). |
| `scan` | `--chain eth\|pls` `[--rebuild]` | Scan / top up the stake ledger into `data/<chain>/`. |
| `resolve` | `--chain eth\|pls` `[--rebuild]` | Resolve HSI ownership (via the HSIM) + $MAXI look-through into `data/<chain>/`. |
| `oa` | `--chain eth\|pls` `[--rebuild]` | Build the OA funding cluster into `data/<chain>/`. |
| `report` | `[--offline]` | Build `out/` from the cache (`--offline` = cached tip reads only, no RPC). |
| `update` | `[--rebuild]` | The whole pipeline: scan → resolve → oa → report, both chains. |
| `stop` | | Stop a scan running in the dashboard (POST /api/update/stop); a foreground `hexleague update` is stopped with Ctrl-C. |
| `seed` | `--url U --sha256 H` `[--force]` | Seed `data/` from a verified snapshot (`--force` overwrites a non-empty `data/`). |
| `whereami` | `--address 0x… …` \| `--tshares N` | Locate wallet(s) (summed) or a raw T-Share total. |

`--rebuild` discards a chain's cache and rescans from the deploy block.

### Utilities (`utils/`)

`utils/check-trace-support.js` probes whether an EVM JSON-RPC endpoint serves
`trace_filter` — the trace API the OA stage depends on — **and** whether it is a
full archive node (traces available back to old blocks, not only recent ones).
Both matter: the OA inbound scan needs `trace_filter` over the entire
deploy→tip range, so a trace-capable but non-archive endpoint is useless. It is
standalone (Node built-ins only, no repo imports), so it runs against any URL.

```bash
node utils/check-trace-support.js <rpc-url> [more-urls...] \
  [--archive-block N] [--timeout MS]
```

It prints a per-URL verdict and exits `0` only if **every** URL supports
`trace_filter` and is full archive (so it composes in shell / CI); `1`
otherwise. Example:

```text
✓ https://rpc-pulsechain.g4mm4.io
    trace_filter: supported  |  archive: full archive
✗ https://rpc.pulsechain.com
    trace_filter: missing  |  archive: -
```

Use it to vet a candidate RPC before adding it — e.g. as a parallel trace
endpoint for the OA stage.

## The check pipeline

`scripts/check.js` runs every gate (ESLint, Stylelint, html-validate,
markdownlint, Prettier JSON/YAML, actionlint, the three security audits, and
`node --test` with coverage), writes `test/report-artifacts/summary.md`, and
exits non-zero on any failure or coverage below 80%. It moves `data/` and `out/`
aside during the test run and restores them in a `finally`.

## The cache (`data/<chain>/`)

Immutable, no TTL. `deploy-block.json`; `stakes.ndjson` (append-only minimal
rows) + `checkpoint.json` (resume cursor with a `schemaVersion`);
`resolution.json` (the active-HSI → owner map plus each look-through wrapper's
holder balances + supply, recomputed when the pinned tip moves); `oa.json` +
`codes.json`; `tip.json`. Re-running a step tops up only new blocks; a `--rebuild`
flag discards a chain's ledger. Delete `data/` for a clean rescan. The derived
`out/` artefacts are pure functions of the cache plus one pinned-tip read.

## Crash safety and recovery

The cache is written to survive an abrupt halt — SIGTERM, `kill`, a crash, or the
scan's own **Stop Sync** — without corruption:

- **JSON is written atomically.** `writeJson` writes a temp file and `rename`s it
  into place, so `checkpoint.json`, `oa.json`, `codes.json`, `tip.json`, and the
  `out/summary.json` artefact are always either the previous complete file or the
  next one — never a half-written document.
- **The ledger heals a torn tail.** `stakes.ndjson` is the only append-only file,
  so its sole failure mode is a partial final line if the process dies
  mid-append. The next scan calls `truncatePartialLine` to drop an unterminated
  trailing line; the checkpoint re-scans that dropped block window, and
  `buildActiveShares` dedups by `staker:stakeId`, so no row is lost or doubled.
- **Progress is checkpointed per block window**, so a halt resumes from the last
  completed window instead of restarting.

**Limitation — power loss.** `rename` is atomic with respect to other processes,
but the tool does not `fsync`, so a sudden **power outage** (unlike a clean kill)
can still lose or truncate an in-flight write at the filesystem level and leave a
`data/<chain>/` file corrupt. There is no automatic repair for that case: delete
the affected file — or the whole `data/<chain>/` directory — and re-run
`hexleague scan` / `oa` (the cache is fully regenerable), or restore it from a
snapshot (see the next section). Because the cache is immutable and every row is
verifiable against the chain, a rebuild always reproduces the same state.

## Seeding the cache (distributing a snapshot)

The `data/<chain>/` cache is regenerable but slow to build from cold: the OA
funding scans are tens of thousands of 5,000-block `getLogs` windows against the
public endpoints (hours per chain). So the cache is published as a **GitHub
Release asset**, and a fresh install pulls it with `hexleague seed`, then tops up
with `hexleague update`. That is the normal way to stand the tool up, not a
fallback.

**Size.** A complete cache is ~350–600 MB raw — dominated by `stakes.ndjson` at
~95 B/row (~125 MB for ETH's ~1.3M rows). ndjson gzips ~3.3×, so a snapshot
tarball is roughly **120–180 MB**.

**Where it lives.** The snapshot is a **GitHub Release asset** (up to 2 GB/asset,
no bandwidth cap, free, versioned by tag, beside the code). It is **not**
committed to the repo: GitHub blocks files over 100 MB, and a regenerable cache
would bloat history.

**Producing and publishing a snapshot** (maintainer, after a full `hexleague
update`). `npm run publish-cache` packages `data/eth` + `data/pls`, checksums the
tarball (SHA-256), and uploads it as the GitHub Release asset with `gh`, then
prints the `hexleague seed` command to share. If a dashboard sync is running it is
stopped first (so the tarball is a consistent snapshot) and restarted once the
asset is pushed. It needs an authenticated `gh` CLI, and tags the release
`cache-<UTC-date>` unless `--tag` is given:

```bash
npm run publish-cache                  # tag cache-YYYY-MM-DD
npm run publish-cache -- --tag v1.2    # or choose the tag
```

**Seeding from a snapshot** (fresh install, empty `data/`):

```bash
hexleague seed --url https://…/hex-cache.tar.gz --sha256 <digest>
```

`seed` streams the download, verifies the SHA-256 (refusing to extract on any
mismatch) and unpacks into `data/` (declining to clobber a non-empty `data/`
without `--force`). Afterwards, `hexleague update` (or the dashboard's **Update**
button) fetches only the blocks added since the snapshot, bringing the local
cache up to date. The seed is a shortcut past the cold scan, never a trust root:
the checksum is the gate, and every row is verifiable against the chain.

## Chain views vs. scanning (always both chains)

The app **always scans both Ethereum and PulseChain.** The scan set is never
conditioned on a chain selection — `hexleague update`/`scan`/`resolve`/`oa`
process both chains, and the report bakes all three views (`eth`, `pls`,
`combined`) into `out/summary.json` in a single pass.

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

The core (`src/hexleague.js`) and the HTTP layer (`server.js`) are kept
deliberately separate, so each is reusable on its own in another project:
`hexleague.js` is a plain library with no HTTP or UI dependency: `require` it and
call `update(ctx)` (run the scan/oa/report pipeline), `stop()` (cancel a run),
`isRunning()` (is one in flight), or `whereami(summary, query)` (locate a staker).
`update`, `stop`, and `whereami` are also `hexleague` CLI subcommands; `isRunning`
is a library-only state query. `server.js` is a thin adapter that maps routes onto
those methods (its `handleRequest` can be mounted in another server). The dashboard server (`npm start`, port 3693)
serves a complete JSON API so the app can also be consumed as a dependency by
other applications, for example to obtain a staker's sea-creature level.
Endpoints: `GET /api/health`,
`GET /api/whereami` (the key consumer endpoint — `?tshares=N` or `?address=0x…`),
`GET /api/what-is-my-hex-staking-sea-creature` (`?tshares=N`, ≤8 decimals —
ranking + the full staking-pool sub-object),
`GET /api/get-hex-staking-pool-sea-creature-data` (that pool sub-object, no
parameter), `GET /api/summary`, `GET /api/status`, `POST /api/update`,
`POST /api/update/stop`, `GET /api/disclaimer`, and `GET /api/openapi.json`. The
contract is defined in `docs/openapi.json`.

Stand up the interactive API reference (rendered with Scalar — the modern,
maintained OpenAPI reference — self-hosted from `node_modules`, no CDN):

```bash
npm run show-api-doc   # serve it (if not already) and open a browser
```

`npm run api-doc` serves the reference at `http://127.0.0.1:5556`, reading
`docs/openapi.json` live so it is always current (no separate build);
`npm run show-api-doc` starts that server only if it is not already up and opens
the page. Update `docs/openapi.json` whenever you add or change an endpoint.

### Starting and stopping a scan

`POST /api/update` starts the pipeline (the initial full scan, or an incremental
top-up when the cached data is from a prior UTC day); `POST /api/update/stop`
cancels a run. The dashboard's header **Sync** button starts a scan and, while
one runs, toggles to **Stop Sync** (calling the stop endpoint); the finder's
**Update** button is a second start trigger. From a terminal, `hexleague stop`
(also `npm run scan:stop`) POSTs to the same endpoint, so a dashboard scan can be
halted without the browser. That stops the *scan* only; to stop the whole server,
see [Stopping the server](#stopping-the-server).

Cancellation is cooperative and checkpoint-safe, and it lives in the `hexleague`
facade (`src/hexleague.js`), not in server.js: `hexleague.update()` runs the
pipeline under one `AbortController`, `hexleague.stop()` aborts it, and server.js
just maps the HTTP routes to those methods. The signal threads down the
pipeline. The
two RPC loops that gate every scan phase — `getLogsChunked` (`eth_getLogs`, used
by the stake scan, the resolve HSIM + wrapper-token scans, the OA forward-BFS,
and the inbound-denominator scan) and `traceStream` (`trace_filter` native
transfers) — call `signal.throwIfAborted()`
at the top of each block window, and the BFS-hop and inbound-batch loops check
between iterations. The stake ledger's checkpoint is written after each window,
so a stop lands on a clean, resumable cursor and a later start tops up from
there. The thrown `AbortError` unwinds through `runUpdate` (whose `finally`
clears the shared status file), so the badge falls back to idle instead of
sticking on "Syncing", and the server logs "stopped by request" rather than a
failure. A stop mid-OA discards only that chain's in-progress OA computation —
the OA cluster is not incrementally checkpointed — so there is no cache
corruption, just recomputation on the next run. Only one update runs at a time;
a second `POST /api/update` while one is active returns `409`.

### Stopping the server

There is deliberately **no shutdown HTTP route** — the server exposes only
read-only reads plus scan start/stop, so a "kill the process" endpoint would widen
the surface for no benefit. `npm start` starts the server; **`npm stop`**
(`scripts/stop.js`) stops it by signalling the process directly:

- On `listen`, the server writes its PID to a file under the OS temp directory,
  keyed by port (`src/server-pid.js`, e.g. `/tmp/hexleague-server-3693.pid`), and
  removes it on `SIGINT` / `SIGTERM` / exit — so Ctrl+C cleans up too.
- `npm stop` reads that PID file and sends `SIGTERM` (the same clean shutdown as
  Ctrl+C), waits briefly, confirms the process exited, and clears the file. If no
  live PID file is found it reports the server is not running.
- It is **cache-safe even mid-scan**: the cache is written to survive a hard stop
  (atomic JSON writes + the self-healing ledger; see [Crash safety and
  recovery](#crash-safety-and-recovery)), so a stopped scan simply recomputes its
  in-progress OA / resolve work on the next run.

The PID-file helpers (`pidPath` / `writePid` / `readPid` / `clearPid`) are one
small module shared by the server and the stop script, so the path is defined
once. To cancel only a running **scan** and keep the server up, use `hexleague
stop` / `npm run scan:stop` instead (previous section).

## RPC etiquette

Bounded concurrency (`CONCURRENCY`, default 4), exponential backoff with jitter,
adaptive `eth_getLogs` chunking, and `trace_filter` pagination — the public
g4mm4 endpoints are shared infrastructure, so the scanner stays polite.
