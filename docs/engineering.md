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
- [Logging](#logging)

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

Secrets vault (see [Secrets vault](#secrets-vault)):

| Command | Purpose |
| --- | --- |
| `npm run secret:clear` | Delete the on-disk vault — back to the first-run setup panel. |

Other vault actions run through the CLI directly:
`node bin/hexleague.js secret set-moralis` (guided seal), `secret unlock`, and
`secret status`.

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

Use it to vet a candidate RPC before adding it. Its probe is reused by the
**startup trace preflight** (`src/rpc/trace-preflight.js`): on `npm start` the app
probes every configured RPC and, unless `TRACE_PREFLIGHT=0`, checks each chain has
at least `TRACE_PREFLIGHT_MIN` (default 2) endpoints serving `trace_filter` over
historical blocks. The result is exposed at `GET /api/preflight`. On a shortfall
the **dashboard still starts** but masks the UI with a red notice and **disables
scanning** (`POST /api/update` returns 409) until it's resolved — by unlocking a
private trace RPC (Help → Secrets, see [Secrets vault](#secrets-vault)) or setting
`ETH_RPC_URLS` / `PLS_RPC_URLS`. A vault unlock re-runs the preflight, and if it
now passes the mask clears and scanning is enabled. With `npm run start:headless`
(or `HEADLESS=1`) the Moralis key entry + unlock happen on the CLI instead of the
browser. Configure several endpoints per chain with `ETH_RPC_URLS` /
`PLS_RPC_URLS` (comma/space-separated, tried in order and rotated on failure).

`utils/moralis-rpc.js` is a companion diagnostic: send one arbitrary JSON-RPC
method, or run a suite of the methods this tool relies on, and see which an
endpoint actually serves. It exists because Moralis RPC nodes reject an
unsupported method with a NON-JSON-RPC shape — an HTTP 400 body of
`{ code, message }` (e.g. `'trace_filter' is not supported on chain eth`) rather
than a JSON-RPC `{ error }` — which a naive probe reads as an empty result. It
normalizes that, so "not supported" is reported plainly.

```bash
node utils/moralis-rpc.js <rpc-url> [more-urls...]        # method-support suite
node utils/moralis-rpc.js <rpc-url> --method eth_blockNumber
node utils/moralis-rpc.js <rpc-url> --method trace_filter \
  --params '[{"fromBlock":"0x1","toBlock":"0x1","count":1}]'
```

**Finding (2026-08-05):** Moralis RPC nodes serve **no** `trace_*` / `debug_trace*`
methods on Ethereum **or** PulseChain, so they cannot drive the OA stage — use
them as generic, key-free nodes and add a trace-capable archive RPC for tracing.
(A URL embeds an API key, so don't paste this tool's output into a shared log.)

## The check pipeline

`scripts/check.js` runs every gate (ESLint, Stylelint, html-validate,
markdownlint, Prettier JSON/YAML, actionlint, the three security audits, and
`node --test` with coverage), writes `test/report-artifacts/summary.md`, and
exits non-zero on any failure or coverage below 80%. It moves `data/` and `out/`
aside during the test run and restores them in a `finally`.

## The cache (`data/<chain>/`)

Immutable, no TTL. `deploy-block.json`; `stakes.ndjson` (append-only minimal
rows) + `checkpoint.json` (resume cursor with a `schemaVersion`); `cycle.json`
(the sync-cycle marker — see below); `resolution.json` (the active-HSI → owner
map plus each look-through wrapper's holder balances + supply, recomputed when
the pinned tip moves) + `resolution.progress.json` (its resume snapshots);
`oa.json` + `oa-inbound.json` (the inbound sweep's resume checkpoint) +
`oa-state.json` + `resolve-state.json` (the persisted cluster + replay state that
let a Re-Scan extend over only the new range — see below) + `codes.json`;
`tip.json`. Re-running a step tops up only new blocks; a
`--rebuild` flag discards a chain's ledger. Delete `data/` for a clean rescan.
The derived `out/` artefacts are pure functions of the cache plus one
pinned-tip read.

**Sticky tip.** The whole report is computed as of one pinned block (the "tip",
`head − tipLagBlocks`). On a live chain a plain restart would re-pin the tip
forward and invalidate every resume checkpoint, so a *sync cycle* — one report's
worth of work at a single tip — holds its tip fixed across restarts until a
report is written (`cycle.json` = `{ tip, complete }`, decided by
`checkpoint.stickyTip`). While a cycle is open the scan, resolve, and OA stages
all resume against the same tip instead of restarting from a freshly-advanced
head; once `report` writes `out/` the cycle is marked complete and the next sync
pins a fresh tip. Because the pool's Origin-Address share is nearly static,
"as of the tip when this sync began" costs nothing in practice.

## Incremental Re-Scan

Once a report exists, a **Re-Scan** brings it to a newer tip by extending the
cached state over only the new block range — no stage re-reads from the deploy
block:

- **Scan** tops up the stake ledger (always incremental).
- **Resolve** seeds the HSIM ownership replay and each wrapper's balance map from
  `resolve-state.json` and applies only the new range's events.
- **OA** loads `oa-state.json` (the reachable set with per-wallet OA-attributed
  totals, the contract list, and every candidate's inbound total) and runs a
  **delta-BFS**: existing cluster wallets are rescanned only over the new range; a
  wallet that *newly* joins the cluster is scanned over its full history (it may
  have funded others at any past block). The per-candidate inbound denominators
  extend the same way (new candidates scan the full range). Numerators and
  denominators are additive, so nothing is double-counted.
- **Exactness.** The one case the delta pass can't relax on its own — a new
  funding shortcut that shortens an already-explored wallet's hop depth — is
  detected (`needsFullRebuild`) and triggers a full OA rebuild for that cycle, so
  an incremental result is *always identical* to a from-scratch scan.

Cost scales with the gap, not the full history — but the wallet **count** is a
floor (every OA descendant is still checked for new activity), so a long-lapsed
Re-Scan is still substantial; multi-endpoint RPC sharding parallelizes that
floor: with several RPCs configured per chain, the OA inbound sweep runs its
independent per-candidate batches across a pool of per-endpoint clients
(`makeClientPool` + `computeInbound`'s worker pool, each shard with its own
adaptive limiter), merging only the contiguous done-prefix into the resume
checkpoint so a restart never double-counts.

## Kind to the disk (batched writes)

Every long stage consolidates its cache writes so the disk isn't hammered with
small, frequent I/O. Instead of writing after every block window, the scan and
resolve stages buffer their state in memory and flush only every few minutes:

- A shared **flush gate** (`src/cache/flush-gate.js`) fires when either
  `flushEveryChunks` (default 60) windows **or** `flushEveryMs` (default 180000 —
  three minutes) have elapsed, whichever comes first; both are tunable in
  `config/tuning.json`.
- The **scan** buffers decoded ledger rows and appends them in batches
  (`createLedgerWriter`); **resolve** buffers the HEX Stake Instance Manager
  (HSIM) ownership replay and each wrapper's balance map and snapshots
  `{ cursor, state }` via `runResumableLogScan` (`src/cache/resumable-scan.js`);
  the **OA** inbound-denominator sweep folds each completed candidate-batch into
  `oa-inbound.json` (`computeInbound`), resuming from the next unfinished batch.
  All three also flush on normal completion and on a clean stop (SIGTERM / Stop
  Sync).
- Net effect: roughly a 60× cut in cache-write frequency (every few minutes, not
  every few seconds) — easier on SSD wear and on machine responsiveness during a
  multi-day scan — while the crash-loss window stays at most one batch (see below).

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
- **Writes are batched and flushed on a clean stop** (see
  [Kind to the disk](#kind-to-the-disk-batched-writes)). The scan appends rows
  *before* advancing `checkpoint.json`, so the checkpoint never points past
  unwritten rows; resolve snapshots `{ cursor, state }` atomically; the OA
  inbound sweep accumulates each batch into a batch-local map and merges it into
  `oa-inbound.json` only on batch completion, so a mid-batch abort never leaves a
  partial, double-countable total. A hard crash (power loss) loses at most one
  unflushed batch — the next run re-fetches it, which is harmless (the scan
  replay is idempotent to duplicate rows; resolve and the OA sweep resume from
  their last snapshot). A halt resumes from the last flushed block rather than
  restarting.

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
**Update** button is a second start trigger. When a complete scan already exists,
both triggers read **Re-Scan** and pop an *Are You Sure?* confirmation first. A
Re-Scan is **incremental**: it advances to the new tip and extends the scan,
resolve, and OA state over only the new block range (never re-reading from the
deploy block), from the per-chain `oa-state.json` / `resolve-state.json`. The OA
delta pass falls back to a full rebuild only if the cluster topology shifted (see
[Incremental Re-Scan](#incremental-re-scan)), so a Re-Scan's cost scales with the
gap since the last scan, not the full history. From a terminal, `hexleague stop`
(also `npm run scan:stop`) POSTs to the same endpoint, so a dashboard scan can be
halted without the browser. That stops the *scan* only; to stop the whole server,
see [Stopping the server](#stopping-the-server).

**Scan Details (Help menu).** Help → **Scan Details** opens a read-only dialog
(it triggers no scan) showing, per chain, the pinned scan tip (block + the
block's UTC time) plus scan statistics — non-OA stakers, OA wallets excluded, the
OA candidate-wallet count, the scanned block span, and the **last measured OA
inbound-sweep duration** (the dominant re-scan cost). Those figures come from
`summary.scan` in `out/summary.json`, which `report` fills from `oa.json`; the
sweep's wall-clock is accumulated across resumes in `oa-inbound.json` and folded
into `oa.json` on completion. Missing figures render honestly ("—" / "not yet
measured") rather than as invented numbers.

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
between iterations. The stake ledger's checkpoint is written after each flushed
batch, so a stop lands on a clean, resumable cursor and a later start resumes
from there. The thrown `AbortError` unwinds through `runUpdate` (whose `finally`
clears the shared status file), so the badge falls back to idle instead of
sticking on "Syncing", and the server logs "stopped by request" rather than a
failure. A stop mid-OA keeps the inbound-denominator sweep's completed batches
(`oa-inbound.json`) — the heaviest part of the run — and resumes them next time;
only the forward-BFS portion, not yet incrementally checkpointed, recomputes.
Either way there is no cache corruption, and because the pinned tip is held
across the restart (sticky tip) the resumed batches still match the checkpoint.
Only one update runs at a time; a second `POST /api/update` while one is active
returns `409`.

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
  recovery](#crash-safety-and-recovery)), so a stopped scan resumes its
  scan / resolve / OA-inbound work from the last flushed checkpoint on the next
  run — against the same pinned tip (sticky tip) — with only the forward BFS
  recomputed.

The PID-file helpers (`pidPath` / `writePid` / `readPid` / `clearPid`) are one
small module shared by the server and the stop script, so the path is defined
once. To cancel only a running **scan** and keep the server up, use `hexleague
stop` / `npm run scan:stop` instead (previous section).

## Secrets vault

A private RPC endpoint (e.g. a paid Moralis Ethereum node whose URL embeds an API
key) is kept in a **password-locked vault** — the plaintext never lives on disk.

- **At rest** (`src/secrets/vault.js`): each secret is sealed with AES-256-GCM
  under a key derived from the passphrase via PBKDF2-HMAC-SHA512 (600k
  iterations). Only the envelope (salt, IV, tag, ciphertext) is written, to the
  git-ignored `config/secrets.vault.json` (mode 0600).
- **In memory** (`src/secrets/holder.js`): after an explicit unlock the decrypted
  values live only in a process-lifetime holder. `config.effectiveRpcUrls`
  prepends unlocked RPC URLs per chain to that chain's list, so they join the pool
  (and the trace preflight) for scans: up to three keyed Moralis nodes
  (`ethRpc1..3` / `plsRpc1..3`, key embedded in the URL) first, then up to three
  generic, key-free nodes (`ethGeneric1..3` / `plsGeneric1..3`). The Moralis
  General API key (`moralisGeneralKey`) is stored too, but this RPC-only app
  doesn't use it.
- **Writes are passphrase-guarded** (`store.assertPassphrase`): before sealing any
  new secret, a store confirms the passphrase already decrypts the existing vault,
  so a mistyped passphrase is rejected outright instead of half-writing an entry
  under a mismatched key. A first-time setup (empty vault) has nothing to guard.
- **Two unlock channels, both local:**
  - **Local socket** (`src/secrets/unlock-socket.js`) — the running server
    listens on an owner-only Unix socket; `hexleague secret set-moralis|unlock`
    (passphrase prompted with echo muted) talks to it. Never over HTTP.
  - **Dashboard GUI** — Help → **Secrets** posts to `POST /api/vault` (localhost,
    same origin) to seal or unlock. First run is a wizard: create a passphrase,
    then add generic (key-free) nodes, then Moralis nodes.
- **First-run vs. misconfigured.** `/api/preflight` reports `hasVault`, so the
  dashboard mask tells a first run (no password yet → a friendly azure "set up
  your RPC endpoints" panel) from a returning misconfiguration (the red "RPC
  Configuration Problem"). Both open the same wizard; unlocking re-runs the
  preflight live, so nothing needs a restart.
- **Clearing.** `npm run secret:clear` (CLI `hexleague secret clear`) deletes the
  vault file, returning to the first-run state. It does NOT lock a running
  server's in-memory holder — stop the dashboard first, or restart after, to see
  the first-run panel again.

Nothing here is ever logged.

## RPC etiquette

Bounded concurrency (`CONCURRENCY`, default 4), exponential backoff with jitter,
adaptive `eth_getLogs` chunking, and `trace_filter` pagination — the public
g4mm4 endpoints are shared infrastructure, so the scanner stays polite.

## Logging

`src/log.js` is an opt-in logger — modules `require` it and call
`log.info` / `log.warn` / `log.error`; it NEVER patches `console`. Its style
follows the sibling lp-ranger tool's logger, adapted to this project's functional
domains.

- **Format — `[tag] [UTC timestamp] message`.** The timestamp
  (`YYYY-MM-DD HH:MM:SS`, UTC) is injected right AFTER the `[tag]` so the domain
  reads first: `[config] [2026-08-05 04:38:26] loadConfig: …`. An untagged first
  argument gets a bare leading timestamp. `printf`-style `%s` / `%d` args and
  non-string first args pass through unchanged.
- **Functional domains + colors.** Each tag gets a terminal color. The two
  boot-level domains are `[hexleague server]` (the dashboard HTTP layer) and
  `[hexleague sync]` (the scan engine); each prints a `🚀 Started. 🚀` banner, and
  a sync ends `✅ Complete.` / `⏹ Stopped by request.` / `❌ Failed`. Pipeline
  stages carry a chain suffix (`[scan eth]`, `[resolve pls]`, `[oa eth]`, …);
  subsystems are `[config]`, `[preflight]`, `[vault]`, `[unlock]`.
- **Color gating.** Colors are emitted only when stdout is a TTY.
  `NO_COLOR` (present, non-empty) forces them off; `FORCE_COLOR` (set, not `0`)
  forces them on (e.g. piping to `less -R`). When color is off, ANSI is
  **stripped** from the line — even the baked-color banners — so a redirected log
  file stays plain.
- **Scan progress.** `makeProgressLogger(tag, label, { log })` emits one line each
  time a fraction crosses a 10% boundary, so a headless operator sees the two long
  scans advance without a per-chunk flood: the block scan
  (`[scan <chain>] block scan N% — block X/Y, R rows`) and the OA wallet sweep
  (`[oa <chain>] OA wallet scan N% — B/T batches`).
- **Never logs secrets.** Passphrases and secret values are never logged; vault
  lines carry slot NAMES only (see [Secrets vault](#secrets-vault)).
- **Tests** inject a fake sink via `_setSinkForTests` (no `console` monkey-patch)
  and pin the color policy with `_setColorForTests`.
