# Best Practices

## Deal-breakers

- Never mirror code (in tests or runtime). Extract an exported pure decision;
  leave I/O in a thin wrapper.
- Never modify a JS global. For cross-cutting behavior build a thin opt-in wrapper
  (`src/log.js`) that callers `require()` explicitly — never patch `console`.

## Code quality

- Fix root causes, not symptoms; grep for the same pattern elsewhere before
  calling a fix done.
- Consolidate a duplicated code path into one function before adding a
  cross-cutting concern (caching, rate limiting) to it.
- Prefer a functional style for new code (data in, results out; no scattered
  mutable object state).

## Explicit type checks

- `eqeqeq: always`. Use `x !== undefined && x !== null` for presence; `??` (not
  `||`) to coalesce only null/undefined; `typeof x === "string"` for strings.

## On-chain

- Never duplicate an RPC call — fetch shared data once and pass it to consumers;
  keep the data-fetch layer separate from classification.
- All share and heart quantities are BigInt; never `Number()` them (the
  `no-number-from-bigint` rule guards this). Show a dash for a value not yet
  computed rather than a misleading zero.

## Dependencies and tooling

- Never use `npx` — always `npm run`.
- Prefer well-known packages over hand-rolling specialized work.

## Git and CI

- Fix on a feature branch; never commit to or push `main` directly. Get CI green
  before merging via PR; stay on the feature branch until the user says to merge.
