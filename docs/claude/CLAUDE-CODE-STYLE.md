# Code Style

Companion to `CLAUDE.md` — the formatting and lint rules most easily missed.

## Formatting

- Prettier is enforced via the pre-commit hook (husky + lint-staged). Never add a
  `prettier-ignore` directive; if a line is too long, split the module.
- Every `src/`, `bin/`, `scripts/`, and `public/dashboard-*.js` file stays at or
  under **500 non-comment lines**. When exceeded, split into a new module — never
  compact code to fit.
- No function over **cyclomatic complexity 17** — extract helpers.

## Linting

- Run with `--max-warnings 0`; warnings are errors. No blanket `eslint-disable` or
  `stylelint-disable`, and never exclude a whole file from a lint pass.
- Security-lint exceptions use a per-line
  `// eslint-disable-next-line <rule> -- Safe: <reason>` directive only.

## Naming and display

- EVM addresses are displayed EIP-55 checksummed.
- Log transaction hashes and addresses with a space after `=` (e.g. `tx= %s`) so
  the value stays a single double-click-copyable token.
- CSS lives in external files; no inline `style` blocks and no inline
  `style="..."` beyond dynamic JS-set values.
- CSS class and id names must begin with a letter, never a numeric character —
  numeric-leading selectors require awkward escaping (the mistake lp-ranger made
  with its `9mm-` prefix).
