/**
 * @file scripts/audit-deps.js
 * @description The dependency-CVE gate (`npm run audit:deps`, and the
 * "Dependency audit" step of `npm run check`). It makes two checks, each with
 * a list of exceptions that must keep earning their place:
 *
 * - Advisories. It runs `npm audit --json` and fails on every high or critical
 *   advisory — the same bar as `npm audit --audit-level=high` — except those
 *   listed in `ALLOWED`: ones with no patched release, each recorded with why
 *   it is tolerated. An `ALLOWED` entry that no longer matches a high or
 *   critical finding fails the gate.
 * - Overrides. Every `package.json` override needs an `OVERRIDES` entry saying
 *   why it exists. The gate re-resolves the lockfile without each override,
 *   audits that tree, and fails when dropping the override brings back no high
 *   or critical advisory: the override no longer does any work.
 *
 * Either way, an exception comes off as soon as the fix lands instead of
 * outliving it.
 *
 * Fails closed: an `npm audit` or re-resolve that cannot run, prints no JSON
 * report, or reports an error (for example, an unreachable registry) fails the
 * gate.
 */

"use strict";

const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { log } = require("../src/log");

const ROOT = path.resolve(__dirname, "..");

/** Advisory severities that fail the gate (npm audit's --audit-level=high). */
const GATING = new Set(["high", "critical"]);

/** npm arguments that re-resolve a lockfile without installing or scripts. */
const RELOCK = [
  "install",
  "--package-lock-only",
  "--ignore-scripts",
  "--no-audit",
  "--no-fund",
];

/**
 * High or critical advisories the gate tolerates, keyed by GitHub advisory id.
 * An entry goes here only when no patched release exists, with the reason it
 * is tolerated; it comes off once the fix lands, and the gate fails until then.
 * @type {ReadonlyArray<{ id: string, reason: string }>}
 */
const ALLOWED = Object.freeze([]);

/**
 * Why each `package.json` override exists, keyed by package name. Every
 * override needs an entry here, and every entry an override. An override goes
 * in only to keep a vulnerable version out of the tree; once dropping it
 * brings back no high or critical advisory, the gate fails until it comes off.
 * @type {ReadonlyArray<{ name: string, reason: string }>}
 */
const OVERRIDES = Object.freeze([
  {
    name: "adm-zip",
    reason:
      "github-actionlint asks ^0.5.16, and every 0.5.x release " +
      "carries high advisories that 0.6.1 fixes.",
  },
]);

/**
 * The GitHub advisory id (GHSA-…) at the end of an advisory URL, falling back
 * to npm's numeric advisory source when the URL carries none.
 * @param {{ url?: string, source?: number }} via
 * @returns {string}
 */
function advisoryId(via) {
  const match = /GHSA-[\w-]+$/.exec(String(via.url ?? ""));
  return match ? match[0] : `npm-${via.source}`;
}

/**
 * Every distinct advisory in an `npm audit --json` (v2) report. Advisories are
 * the objects in each vulnerable package's `via` list; a string entry only
 * names the dependency an advisory arrived through, so it adds no finding.
 * @param {{ vulnerabilities: object }} report
 * @returns {{ id: string, name: string, severity: string, title: string,
 *   range: string }[]}
 */
function collectAdvisories(report) {
  const seen = new Map();
  for (const vuln of Object.values(report.vulnerabilities)) {
    for (const via of vuln.via ?? []) {
      if (typeof via !== "object" || via === null) continue;
      const id = advisoryId(via);
      const key = `${id} ${via.name}`;
      if (seen.has(key)) continue;
      const { name, severity, title, range } = via;
      seen.set(key, { id, name, severity, title, range });
    }
  }
  return [...seen.values()];
}

/**
 * Sort a report's advisories against the gate and the allowlist.
 *   blocking  — high or critical, not allowed (fails the gate)
 *   tolerated — high or critical, allowed; carries the entry's reason
 *   below     — under the gate (moderate, low, info)
 *   stale     — allowlist entries that matched no high or critical advisory
 *               (fails the gate)
 * @param {{ vulnerabilities: object }} report parsed `npm audit --json`
 * @param {ReadonlyArray<{ id: string, reason: string }>} [allowed]
 * @returns {{ ok: boolean, blocking: object[], tolerated: object[],
 *   below: object[], stale: { id: string, reason: string }[] }}
 */
function evaluate(report, allowed = ALLOWED) {
  const reasons = new Map(allowed.map((a) => [a.id, a.reason]));
  const blocking = [];
  const tolerated = [];
  const below = [];
  for (const adv of collectAdvisories(report)) {
    if (!GATING.has(adv.severity)) below.push(adv);
    else if (!reasons.has(adv.id)) blocking.push(adv);
    else tolerated.push({ ...adv, reason: reasons.get(adv.id) });
  }
  const used = new Set(tolerated.map((a) => a.id));
  const stale = allowed.filter((a) => !used.has(a.id));
  const ok = blocking.length === 0 && stale.length === 0;
  return { ok, blocking, tolerated, below, stale };
}

/**
 * Judge each `package.json` override against `OVERRIDES` and the gate.
 *   needed   — dropping it brings back the gating advisories in `prevents`
 *   stale    — dropping it brings back none (fails the gate)
 *   unlisted — an override with no `OVERRIDES` entry (fails the gate)
 *   orphaned — an `OVERRIDES` entry with no override (fails the gate)
 * @param {string[]} names top-level keys of `package.json` `overrides`
 * @param {(name: string) => object[]} gainedWithout the gating advisories
 *   that dropping that override adds to the ones already blocking
 * @param {ReadonlyArray<{ name: string, reason: string }>} [entries]
 * @returns {{ ok: boolean, needed: object[], stale: object[],
 *   unlisted: string[], orphaned: { name: string, reason: string }[] }}
 */
function judgeOverrides(names, gainedWithout, entries = OVERRIDES) {
  const reasons = new Map(entries.map((e) => [e.name, e.reason]));
  const needed = [];
  const stale = [];
  for (const name of names.filter((n) => reasons.has(n))) {
    const prevents = gainedWithout(name);
    const judged = { name, reason: reasons.get(name), prevents };
    if (prevents.length > 0) needed.push(judged);
    else stale.push(judged);
  }
  const unlisted = names.filter((n) => !reasons.has(n));
  const orphaned = entries.filter((e) => !names.includes(e.name));
  const ok =
    stale.length === 0 && unlisted.length === 0 && orphaned.length === 0;
  return { ok, needed, stale, unlisted, orphaned };
}

/**
 * Parse `npm audit --json` output, failing closed: unparseable output, an npm
 * error object (for example, an unreachable registry), or a report with no
 * `vulnerabilities` map throws instead of passing as clean. The exit status is
 * no guide — with `--json`, npm exits 0 on an unreachable registry.
 * @param {string} stdout
 * @returns {{ vulnerabilities: object }}
 */
function parseAudit(stdout) {
  let report;
  try {
    report = JSON.parse(stdout);
  } catch {
    throw new Error("npm audit printed no JSON report");
  }
  if (report?.error) {
    const { summary, code } = report.error;
    const why = report.message || summary || code || "unknown error";
    throw new Error(`npm audit failed: ${why}`);
  }
  if (typeof report?.vulnerabilities !== "object" || !report.vulnerabilities) {
    throw new Error("npm audit report has no vulnerabilities map");
  }
  return report;
}

/**
 * Parse an audit run, failing closed when npm could not even start.
 * @param {{ stdout: string, error?: Error }} run
 * @returns {{ vulnerabilities: object }}
 */
function parseRun(run) {
  if (run.error) throw new Error(`npm audit did not run: ${run.error.message}`);
  return parseAudit(run.stdout);
}

/**
 * One advisory as `<severity> <package> <id> (<range>) <title>`.
 * @param {{ id: string, name: string, severity: string, title: string,
 *   range: string }} adv
 * @returns {string}
 */
function describe(adv) {
  return `${adv.severity} ${adv.name} ${adv.id} (${adv.range}) ${adv.title}`;
}

/**
 * Report lines for a gate result: blocking advisories first, then tolerated
 * ones with their reasons, then those under the gate, then stale entries.
 * @param {ReturnType<typeof evaluate>} result
 * @returns {string[]}
 */
function render(result) {
  return [
    ...result.blocking.map((a) => `BLOCKING ${describe(a)}`),
    ...result.tolerated.map((a) => `allowed  ${describe(a)} — ${a.reason}`),
    ...result.below.map((a) => `below    ${describe(a)}`),
    ...result.stale.map(
      (a) =>
        `STALE    ${a.id} matches no high or critical advisory; ` +
        "remove it from ALLOWED in scripts/audit-deps.js",
    ),
  ];
}

/**
 * Report lines for the override check: needed overrides with the advisories
 * they keep out and their reasons, then stale, unlisted, and orphaned ones.
 * @param {ReturnType<typeof judgeOverrides>} judged
 * @returns {string[]}
 */
function renderOverrides(judged) {
  const ids = (o) => [...new Set(o.prevents.map((a) => a.id))].join(", ");
  return [
    ...judged.needed.map(
      (o) => `override ${o.name} keeps out ${ids(o)} — ${o.reason}`,
    ),
    ...judged.stale.map(
      (o) =>
        `STALE    override ${o.name} keeps out no high or critical ` +
        "advisory; remove it from package.json and from OVERRIDES in " +
        "scripts/audit-deps.js",
    ),
    ...judged.unlisted.map(
      (name) =>
        `UNLISTED override ${name} has no reason; add one to OVERRIDES in ` +
        "scripts/audit-deps.js",
    ),
    ...judged.orphaned.map(
      (o) =>
        `STALE    OVERRIDES entry ${o.name} matches no package.json ` +
        "override; remove it from scripts/audit-deps.js",
    ),
  ];
}

/**
 * The one-line tally behind the PASS or FAIL verdict.
 * @param {ReturnType<typeof evaluate>} result
 * @param {ReturnType<typeof judgeOverrides>} judged
 * @returns {string}
 */
function tally(result, judged) {
  const stale =
    result.stale.length + judged.stale.length + judged.orphaned.length;
  const needed = judged.needed.length;
  return (
    `${result.blocking.length} blocking, ${stale} stale, ` +
    `${judged.unlisted.length} unlisted, ${result.tolerated.length} allowed, ` +
    `${result.below.length} below the gate, ` +
    `${needed} override${needed === 1 ? "" : "s"} needed`
  );
}

/**
 * Parse a JSON file.
 * @param {string} file
 * @returns {any}
 */
function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/**
 * The top-level package names in `package.json` `overrides`.
 * @param {string} [root] the directory holding package.json
 * @returns {string[]}
 */
function readOverrides(root = ROOT) {
  return Object.keys(readJson(path.join(root, "package.json")).overrides ?? {});
}

/**
 * The first `npm error` line of a failed npm run (`npm error code
 * ECONNREFUSED`, say), else its last line.
 * @param {string | null | undefined} stderr
 * @returns {string}
 */
function firstNpmError(stderr) {
  const lines = String(stderr ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const npmError = lines.find((line) => line.startsWith("npm error"));
  return npmError ?? lines.at(-1) ?? "no output";
}

/**
 * Run `npm audit --json` in a directory (the repo root by default).
 * @param {typeof spawnSync} [spawn] injectable for tests
 * @param {string} [cwd]
 * @returns {{ stdout: string, error?: Error }}
 */
function runNpmAudit(spawn = spawnSync, cwd = ROOT) {
  const res = spawn("npm", ["audit", "--json"], {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return { stdout: res.stdout ?? "", error: res.error };
}

/**
 * Audit the tree as it would resolve without one override. Copies
 * package.json (minus that override) and the lockfile into a temp dir,
 * re-resolves the lockfile there — no install, no scripts — and runs
 * `npm audit --json` on it. Only the dependencies the override was bending
 * re-resolve; everything else keeps its locked version, so the two audits
 * differ only by what the override changes. The temp dir is always removed.
 * @param {string} name the override to drop
 * @param {{ root?: string, spawn?: typeof spawnSync }} [opts] injectable for
 *   tests
 * @returns {{ stdout: string, error?: Error }} the audit run
 * @throws {Error} when the re-resolve fails
 */
function auditWithout(name, { root = ROOT, spawn = spawnSync } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-deps-"));
  try {
    const pkg = readJson(path.join(root, "package.json"));
    if (pkg.overrides) delete pkg.overrides[name];
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg));
    fs.copyFileSync(
      path.join(root, "package-lock.json"),
      path.join(dir, "package-lock.json"),
    );
    const res = spawn("npm", RELOCK, { cwd: dir, encoding: "utf8" });
    if (res.error || res.status !== 0) {
      const why = res.error ? res.error.message : firstNpmError(res.stderr);
      throw new Error(`re-resolving without override ${name} failed: ${why}`);
    }
    return runNpmAudit(spawn, dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Run the gate: audit the tree, then judge each override by auditing the tree
 * without it; log one line per finding plus a verdict.
 * @param {{ audit?: () => { stdout: string, error?: Error },
 *   auditWithoutOverride?: (name: string) => { stdout: string, error?: Error },
 *   overrideNames?: () => string[],
 *   allowed?: ReadonlyArray<{ id: string, reason: string }>,
 *   overrides?: ReadonlyArray<{ name: string, reason: string }>,
 *   out?: { info: Function, error: Function } }} [deps] injectable for tests
 * @returns {number} exit code — 0 pass, 1 fail
 */
function main({
  audit = runNpmAudit,
  auditWithoutOverride = auditWithout,
  overrideNames = readOverrides,
  allowed = ALLOWED,
  overrides = OVERRIDES,
  out = log,
} = {}) {
  try {
    const result = evaluate(parseRun(audit()), allowed);
    for (const line of render(result)) out.info("[audit-deps] %s", line);
    const blocking = new Set(result.blocking.map((a) => a.id));
    const gainedWithout = (name) =>
      evaluate(parseRun(auditWithoutOverride(name)), allowed).blocking.filter(
        (a) => !blocking.has(a.id),
      );
    const judged = judgeOverrides(overrideNames(), gainedWithout, overrides);
    for (const line of renderOverrides(judged)) {
      out.info("[audit-deps] %s", line);
    }
    const ok = result.ok && judged.ok;
    if (ok) out.info("[audit-deps] PASS: %s", tally(result, judged));
    else out.error("[audit-deps] FAIL: %s", tally(result, judged));
    return ok ? 0 : 1;
  } catch (err) {
    out.error("[audit-deps] FAIL: %s", err.message);
    return 1;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = {
  ALLOWED,
  OVERRIDES,
  auditWithout,
  evaluate,
  judgeOverrides,
  main,
  parseAudit,
  readOverrides,
  render,
  renderOverrides,
  runNpmAudit,
};
