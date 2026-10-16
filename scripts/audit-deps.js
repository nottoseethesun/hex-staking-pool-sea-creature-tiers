/**
 * @file scripts/audit-deps.js
 * @description The dependency-CVE gate (`npm run audit:deps`, and the
 * "Dependency audit" step of `npm run check`). It runs `npm audit --json` and
 * fails on every high or critical advisory — the same bar as
 * `npm audit --audit-level=high` — except the advisories listed in `ALLOWED`:
 * ones with no patched release, each recorded with why it is tolerated. An
 * `ALLOWED` entry that no longer matches a high or critical finding fails the
 * gate too, so an exception comes off as soon as the fix lands instead of
 * outliving it.
 *
 * Fails closed: an `npm audit` that cannot run, prints no JSON report, or
 * reports an error (for example, an unreachable registry) fails the gate.
 */

"use strict";

const { spawnSync } = require("child_process");
const path = require("path");
const { log } = require("../src/log");

const ROOT = path.resolve(__dirname, "..");

/** Advisory severities that fail the gate (npm audit's --audit-level=high). */
const GATING = new Set(["high", "critical"]);

/**
 * High or critical advisories the gate tolerates, keyed by GitHub advisory id.
 * An entry goes here only when no patched release exists, with the reason it
 * is tolerated; it comes off once the fix lands, and the gate fails until then.
 * @type {ReadonlyArray<{ id: string, reason: string }>}
 */
const ALLOWED = Object.freeze([
  {
    id: "GHSA-vfj7-8cjw-p6xm", // braces <=3.0.3, CVE-2026-93687
    reason:
      "No patched braces release. Dev-only: reached via " +
      "stylelint, markdownlint-cli2, knip, secretlint " +
      "expanding this repo's own globs. Runtime tree clean.",
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
 * Run `npm audit --json` from the repo root.
 * @param {typeof spawnSync} [spawn] injectable for tests
 * @returns {{ stdout: string, error?: Error }}
 */
function runNpmAudit(spawn = spawnSync) {
  const res = spawn("npm", ["audit", "--json"], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return { stdout: res.stdout ?? "", error: res.error };
}

/**
 * Run the gate: audit, evaluate, and log one line per advisory plus a verdict.
 * @param {{ audit?: () => { stdout: string, error?: Error },
 *   allowed?: ReadonlyArray<{ id: string, reason: string }>,
 *   out?: { info: Function, error: Function } }} [deps] injectable for tests
 * @returns {number} exit code — 0 pass, 1 fail
 */
function main({ audit = runNpmAudit, allowed = ALLOWED, out = log } = {}) {
  const run = audit();
  if (run.error) {
    out.error(
      "[audit-deps] FAIL: npm audit did not run: %s",
      run.error.message,
    );
    return 1;
  }
  let report;
  try {
    report = parseAudit(run.stdout);
  } catch (err) {
    out.error("[audit-deps] FAIL: %s", err.message);
    return 1;
  }
  const result = evaluate(report, allowed);
  for (const line of render(result)) out.info("[audit-deps] %s", line);
  const counts =
    `${result.blocking.length} blocking, ${result.stale.length} stale, ` +
    `${result.tolerated.length} allowed, ${result.below.length} below the gate`;
  if (result.ok) out.info("[audit-deps] PASS: %s", counts);
  else out.error("[audit-deps] FAIL: %s", counts);
  return result.ok ? 0 : 1;
}

if (require.main === module) process.exitCode = main();

module.exports = {
  ALLOWED,
  evaluate,
  main,
  parseAudit,
  render,
  runNpmAudit,
};
