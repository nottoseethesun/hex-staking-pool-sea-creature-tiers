# Testing

## Runner

Node built-in `node:test` + `node:assert/strict`. `npm test` runs the suite;
`npm run check` adds coverage with an **80% line floor** (keep local at or above
81% to avoid CI rounding flakes).

## No mirroring

Never copy a source function into a test, and never duplicate logic across
runtime modules. When a private helper needs testing, extract it as an exported
pure decision and drive the export. The CommonJS-server / ESM-browser split is
handled by pre-formatting display strings server-side into `summary.json` — not
by duplicating formatters in the browser.

## Hermetic tests

- Tests never touch the project `data/` or `out/`. Use `os.tmpdir()` +
  `fs.mkdtempSync()` for on-disk fixtures, or pass an explicit path (for example
  `buildActiveShares(chainKey, tempFile)`).
- `scripts/check.js` additionally moves `data/` and `out/` aside for the duration
  of the test run and restores them in a `finally`, so a stray test can never
  corrupt the immutable scan cache. **Never run `npm run check` inside a
  sub-agent** — a killed sub-agent could bypass the restore.

## What to cover

The `data0` decoder against fixture logs; league threshold and bucketing math;
funding-graph propagation (contract-terminal, hop cap); the ledger-replay state
machine; the format helpers; whereami math; reconciliation; adaptive `eth_getLogs`
chunking; and the custom ESLint rules (via `RuleTester`).
