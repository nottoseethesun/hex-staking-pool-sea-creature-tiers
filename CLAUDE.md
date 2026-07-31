# hex-staking-pool-sea-creature-tiers — Project Summary

## Purpose

A read-only, self-hosted tool that scans the HEX contract on **Ethereum** and
**PulseChain** via JSON-RPC, attributes every active stake's T-Shares to a
wallet, excludes the Origin-Address (OA) funding cluster, and reports the
**sea-creature league** breakdown of the staking pool for three views:
Ethereum, PulseChain, and Combined. It ships a CLI pipeline and a local
dashboard. It is educational and informational only — see
[docs/claude/CLAUDE-DISCLAIMER.md](docs/claude/CLAUDE-DISCLAIMER.md).

Companion guides:

- Code style: [docs/claude/CLAUDE-CODE-STYLE.md](docs/claude/CLAUDE-CODE-STYLE.md)
- Testing: [docs/claude/CLAUDE-TESTING.md](docs/claude/CLAUDE-TESTING.md)
- Best practices: [docs/claude/CLAUDE-BEST-PRACTICES.md](docs/claude/CLAUDE-BEST-PRACTICES.md)
- Security: [docs/claude/CLAUDE-SECURITY.md](docs/claude/CLAUDE-SECURITY.md)
- CI / merge protocol: [docs/claude/CLAUDE-CI.md](docs/claude/CLAUDE-CI.md)
- Disclaimer editing: [docs/claude/CLAUDE-DISCLAIMER.md](docs/claude/CLAUDE-DISCLAIMER.md)
- OA-wallet methodology: [docs/oa-wallet-estimation.md](docs/oa-wallet-estimation.md)
- Spec: [docs/hex-sea-creature-league-spec.md](docs/hex-sea-creature-league-spec.md)

---

## Stack

- **Runtime:** Node.js >= 22, vanilla **JavaScript (CommonJS)** — no framework,
  no build step for the server. (The spec's TypeScript/Vitest/viem wording is a
  stylistic default; this repo's conventions take precedence and match the
  lp-ranger template it was cloned from.)
- **RPC:** ethers v6 (`JsonRpcProvider`, `client.send()` for `trace_filter`).
- **CLI:** Node built-in `node:util` `parseArgs` (no commander/yargs).
- **Core API:** `src/hexleague.js`, one facade (`update`/`stop`/`whereami`) the
  CLI and server both call, so the scan lifecycle lives in one place.
- **Server:** Node built-in `http` module (`server.js`): the UI + HTTP layer that
  delegates each core action to `hexleague`; holds no domain logic.
- **Dashboard:** native browser ES modules (`public/dashboard-*.js`), no bundler.
- **Tests:** Node built-in `node:test` + `node:assert/strict`.
- **Lint/format:** ESLint v10 flat config, Prettier, Stylelint, html-validate,
  markdownlint, secretlint, and github-actionlint.
- **CI:** GitHub Actions (`ci.yml` Node 22/24 matrix, `security-audit.yml`).

---

## Directory Structure

```text
bin/hexleague.js         CLI entry (parseArgs dispatch)
server.js                UI + HTTP layer; delegates core actions to hexleague
src/
  hexleague.js           core API facade (update/stop/isRunning/whereami)
  config.js log.js       .env config; opt-in log wrapper (no global patching)
  disclaimer.js          single source of the disclaimer text
  abi/hex.json           vendored HEX ABI (topics/selectors derived at runtime)
  chain/                 constants, address helpers, deploy-block search, tip reads
  rpc/                   client (concurrency + backoff), get-logs chunking, trace-filter
  decode/stake-events.js data0 BigInt bit decode + minimal ledger rows
  scan/                  scan.js (stake ledger) + checkpoint.js (resume cursor)
  oa/                    funding-graph, graph (BFS), attribution, oa (orchestration)
  report/               leagues, format, summary, markdown, csv, display, report
  whereami.js            self-lookup over the summary
  validate/reconcile.js  Sigma active shares == globalInfo totals
  cli/                   verify, scan-cmd, oa-cmd, report-cmd, whereami-cmd, context
public/                  index.html, style.css, dashboard-*.js (ESM)
scripts/                 check.js (umbrella gate), build-info.js
eslint-rules/            no-interpolated-innerhtml, no-secret-logging, no-number-from-bigint
data/<chain>/            gitignored, immutable scan cache (no TTL)
out/                     gitignored derived report artefacts
```

---

## npm Scripts

```bash
npm run verify   # chainId, deploy block, ABI sanity (--chain eth|pls)
npm run scan     # stake ledger scan (needs --chain; add --rebuild to reset)
npm run oa       # OA funding cluster (needs --chain; --rebuild to reset)
npm run report   # reads data/, writes out/ (summary.json, report.md, CSVs)
npm start        # local read-only dashboard at http://127.0.0.1:3693
npm run lint     # ESLint + Stylelint + html-validate + markdownlint + prettier + actionlint
npm test         # node --test
npm run check    # the full gate (lint + audits + tests + >=80% coverage)
```

`hexleague` is also a bin: `node bin/hexleague.js whereami --tshares 42`.

---

## Architecture Decisions

- **Immutable, no-TTL cache.** Blockchain data never changes, so
  `data/<chain>/` has no expiry: `scan`/`oa` resume from a checkpoint and top up
  only new blocks. The active-shares map is rebuilt by replaying the append-only
  `stakes.ndjson` — never cached separately (minimal footprint). Minimal ledger
  rows omit tx hashes (not needed to rebuild state or reconcile).
- **OA cluster = >=20% funded within <=3 hops.** Implemented as an efficient
  forward BFS from the OA (provably the same reachable set as reverse-spidering
  from every staker), with a per-candidate inbound denominator and a per-asset
  (HEX or native) threshold. Contracts are terminal. See
  [docs/oa-wallet-estimation.md](docs/oa-wallet-estimation.md).
- **Report is a pure transform.** `report` builds `out/` from cache + one pinned
  tip read; the dashboard and `whereami` run fully offline from `out/summary.json`.
- **No mirroring across the CJS/ESM boundary.** The server pre-formats every
  display string into `summary.json`; the browser renders strings and does no
  BigInt/number formatting. `whereami` in the browser calls the server endpoint.
- **BigInt throughout.** A T-Share is 10^12 raw shares; league thresholds use
  exact cross-multiplication (no floats). Display formatting is integer-only.

---

## Lint Rules

- `complexity <= 17`, `max-lines <= 500` (skip blanks/comments), `eqeqeq`,
  `no-var`, `prefer-const`, `strict` global.
- `no-restricted-syntax` bans `window.*` assignment and `Math.random()`.
- `hexleague/no-interpolated-innerhtml` (dashboard XSS) — error.
- `hexleague/no-secret-logging`, `hexleague/no-number-from-bigint` — enforced by
  the security lint (`npm run audit:security`).
- `--max-warnings 0`; no blanket `eslint-disable`. Security-lint exceptions use a
  per-line `-- Safe: <reason>` directive only.

---

## Constraints to Maintain

- Every `src/`, `bin/`, `scripts/`, and `public/dashboard-*.js` file <= 500
  non-comment lines; no function over cyclomatic complexity 17.
- Full JSDoc on every file and exported function.
- All new logic covered by tests in `test/`; keep line coverage >= 81%.
- `npm run check` must pass clean before any commit.
- EVM addresses displayed in EIP-55 checksummed form.
- Read-only: the tool holds no keys, custodies no funds, and signs nothing.
- No price feeds, no external indexers, no API keys — chain + RPC only.
