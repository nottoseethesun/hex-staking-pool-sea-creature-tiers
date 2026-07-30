# CI and Merge Protocol

Keep the GitHub remote always green.

## The gate

`npm run check` (and CI `ci.yml`, Node 22/24 matrix) must pass: ESLint,
Stylelint, html-validate, markdownlint, Prettier (JSON + YAML), actionlint, the
three security audits, and the tests with an 80% line-coverage floor.
`security-audit.yml` runs the three audits as separate jobs; a scheduled workflow
re-runs the dependency audit daily.

## The flow

1. Fix on a feature branch — never commit to `main`.
2. `npm run check` on the branch.
3. Optionally verify a local merge: `git checkout main && git merge <branch> &&
   npm run check`, then `git reset --hard origin/main` to undo it.
4. `git push -u origin <branch>`.
5. Open a PR; wait for CI green (`gh pr checks <n> --watch`); merge via PR — never
   push `main` directly, never squash away history, never delete the branch.
6. `git pull origin main` and confirm main is green before starting new work.

## Prettier before commit

Run `npm run lint:fix` on changed files and re-run `npm run check` before
committing. Prettier can expand compact lines, and the pre-commit hook formats
only after `check` already ran on the pre-Prettier version.
