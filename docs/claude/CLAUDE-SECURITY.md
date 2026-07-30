# Security

This tool is **read-only**: it holds no private keys, custodies no funds, and
signs no transactions. The wallet and fund-safety attack surface of a trading bot
does not exist here — there is nothing to steal and no transaction to forge.

## Automated audit (three layers)

Run in CI (`security-audit.yml`) and inside `npm run check`:

- **Dependency CVEs** — `npm run audit:deps` (`npm audit --audit-level=high`).
- **Security lint** — `npm run audit:security` (eslint-plugin-security +
  eslint-plugin-no-secrets + the custom `hexleague` rules).
- **Secret scan** — `npm run audit:secrets` (secretlint, recommend preset).

## Conventions

- `--max-warnings 0`: a security-lint finding must be fixed or suppressed with a
  documented per-line `-- Safe: <reason>` directive; never exclude a whole file.
- Two eslint-plugin-security rules are disabled with rationale:
  `detect-non-literal-fs-filename` (every path is a `__dirname`/constant such as
  `data/<chain>/...`) and `detect-object-injection` (bracket access uses
  program-owned keys — chain names, league ids — never untrusted input).
- Even though no keys are handled, `no-secret-logging` is kept as defence in
  depth so a future change can never start logging a secret.
- Triage: high/critical CVEs are fixed immediately (update, replace, or document
  and monitor if there is no fix); lower severities are assessed for reachability.
