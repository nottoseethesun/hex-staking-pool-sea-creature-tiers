"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { format } = require("node:util");
const {
  ALLOWED,
  evaluate,
  main,
  parseAudit,
  render,
  runNpmAudit,
} = require("../scripts/audit-deps");

/**
 * One advisory object, shaped as it sits in a package's `via` list in
 * `npm audit --json` (v2) output.
 * @param {string} name package the advisory is against
 * @param {string} id GitHub advisory id
 * @param {string} severity
 * @returns {object}
 */
function advisory(name, id, severity) {
  return {
    source: 1000,
    name,
    dependency: name,
    title: `${name} is vulnerable`,
    url: `https://github.com/advisories/${id}`,
    severity,
    range: "<=1.0.0",
  };
}

/**
 * A trimmed `npm audit --json` (v2) report: one vulnerable package per
 * advisory, plus any `extra` package entries as given.
 * @param {object[]} advisories
 * @param {object} [extra]
 * @returns {{ auditReportVersion: number, vulnerabilities: object }}
 */
function report(advisories, extra = {}) {
  const vulnerabilities = { ...extra };
  for (const a of advisories) {
    vulnerabilities[a.name] = { name: a.name, severity: a.severity, via: [a] };
  }
  return { auditReportVersion: 2, vulnerabilities };
}

/**
 * An output sink for `main` that records each formatted line by stream.
 * @returns {{ lines: { info: string[], error: string[] }, out: object }}
 */
function sink() {
  const lines = { info: [], error: [] };
  return {
    lines,
    out: {
      info: (...a) => lines.info.push(format(...a)),
      error: (...a) => lines.error.push(format(...a)),
    },
  };
}

const HIGH = advisory("braces", "GHSA-test-high-0001", "high");
const CRITICAL = advisory("undici", "GHSA-test-crit-0002", "critical");
const LOW = advisory("katex", "GHSA-test-low0-0004", "low");
const ALLOW_HIGH = [{ id: "GHSA-test-high-0001", reason: "no fix yet" }];

test("evaluate passes a report with no advisories", () => {
  const r = evaluate(report([]), []);
  assert.equal(r.ok, true);
  assert.deepEqual(
    [r.blocking, r.tolerated, r.below, r.stale],
    [[], [], [], []],
  );
});

test("evaluate blocks high and critical advisories that are not allowed", () => {
  const r = evaluate(report([HIGH, CRITICAL]), []);
  assert.equal(r.ok, false);
  assert.deepEqual(
    r.blocking.map((a) => a.id),
    ["GHSA-test-high-0001", "GHSA-test-crit-0002"],
  );
});

test("evaluate tolerates an allowed advisory and its by-name dependents", () => {
  // micromatch's `via` only names braces, so it adds no finding of its own.
  const dependent = {
    micromatch: { name: "micromatch", severity: "high", via: ["braces"] },
  };
  const r = evaluate(report([HIGH], dependent), ALLOW_HIGH);
  assert.equal(r.ok, true);
  assert.deepEqual(r.blocking, []);
  assert.equal(r.tolerated.length, 1);
  assert.equal(r.tolerated[0].reason, "no fix yet");
});

test("evaluate never gates on moderate, low, or info advisories", () => {
  const moderate = advisory("smol-toml", "GHSA-test-mod0-0003", "moderate");
  const info = advisory("left-pad", "GHSA-test-info-0005", "info");
  const r = evaluate(report([moderate, LOW, info]), []);
  assert.equal(r.ok, true);
  assert.equal(r.below.length, 3);
});

test("evaluate fails on an allowed entry that matches no gating finding", () => {
  // Fixed upstream: the advisory is gone from the report.
  const gone = evaluate(report([]), ALLOW_HIGH);
  assert.equal(gone.ok, false);
  assert.deepEqual(gone.stale, ALLOW_HIGH);
  // Downgraded below the gate: the entry no longer suppresses anything.
  const downgraded = evaluate(
    report([{ ...HIGH, severity: "moderate" }]),
    ALLOW_HIGH,
  );
  assert.equal(downgraded.ok, false);
  assert.deepEqual(downgraded.stale, ALLOW_HIGH);
});

test("evaluate counts an advisory once; an id-less one keys by npm source", () => {
  const noUrl = { ...HIGH, url: undefined, source: 4242 };
  const r = evaluate(
    report([], { braces: { name: "braces", via: [noUrl, noUrl] } }),
    [],
  );
  assert.deepEqual(
    r.blocking.map((a) => a.id),
    ["npm-4242"],
  );
});

test("parseAudit returns a well-formed report", () => {
  const r = report([HIGH]);
  assert.deepEqual(parseAudit(JSON.stringify(r)), r);
});

test("parseAudit fails closed on anything but a report", () => {
  assert.throws(() => parseAudit(""), /no JSON report/);
  assert.throws(() => parseAudit("npm error boom"), /no JSON report/);
  // npm's --json output for an unreachable registry (it still exits 0).
  const offline = {
    message: "request to /advisories/bulk failed, reason: ECONNREFUSED",
    error: { summary: "", detail: "" },
  };
  assert.throws(
    () => parseAudit(JSON.stringify(offline)),
    /npm audit failed: request to .* ECONNREFUSED$/,
  );
  assert.throws(
    () => parseAudit(JSON.stringify({ error: { code: "E500" } })),
    /npm audit failed: E500$/,
  );
  assert.throws(
    () => parseAudit(JSON.stringify({ error: {} })),
    /unknown error/,
  );
  assert.throws(() => parseAudit("{}"), /no vulnerabilities map/);
  assert.throws(() => parseAudit("null"), /no vulnerabilities map/);
  assert.throws(
    () => parseAudit('{"vulnerabilities":null}'),
    /no vulnerabilities map/,
  );
});

test("render lists blocking, allowed, below, then stale entries", () => {
  const gone = { id: "GHSA-test-gone-0006", reason: "fixed" };
  const lines = render(
    evaluate(report([HIGH, CRITICAL, LOW]), [...ALLOW_HIGH, gone]),
  );
  assert.equal(lines.length, 4);
  assert.match(
    lines[0],
    /^BLOCKING critical undici GHSA-test-crit-0002 \(<=1\.0\.0\) undici is/,
  );
  assert.match(lines[1], /^allowed {2}high braces .* — no fix yet$/);
  assert.match(lines[2], /^below {4}low katex GHSA-test-low0-0004/);
  assert.match(lines[3], /^STALE {4}GHSA-test-gone-0006 .*audit-deps\.js$/);
});

test("main passes, logging each advisory and the verdict", () => {
  const { lines, out } = sink();
  const audit = () => ({ stdout: JSON.stringify(report([HIGH])) });
  assert.equal(main({ audit, allowed: ALLOW_HIGH, out }), 0);
  assert.deepEqual(lines.error, []);
  assert.match(lines.info[0], /^\[audit-deps\] allowed {2}high braces/);
  assert.equal(
    lines.info.at(-1),
    "[audit-deps] PASS: 0 blocking, 0 stale, 1 allowed, 0 below the gate",
  );
});

test("main fails on a blocking advisory", () => {
  const { lines, out } = sink();
  const audit = () => ({ stdout: JSON.stringify(report([HIGH])) });
  assert.equal(main({ audit, allowed: [], out }), 1);
  assert.match(lines.info[0], /^\[audit-deps\] BLOCKING high braces/);
  assert.equal(
    lines.error[0],
    "[audit-deps] FAIL: 1 blocking, 0 stale, 0 allowed, 0 below the gate",
  );
});

test("main fails closed when npm audit cannot run or prints no report", () => {
  const notRun = sink();
  const spawnError = () => ({ stdout: "", error: new Error("spawn ENOENT") });
  assert.equal(main({ audit: spawnError, allowed: [], out: notRun.out }), 1);
  assert.match(notRun.lines.error[0], /did not run: spawn ENOENT$/);

  const garbled = sink();
  const empty = () => ({ stdout: "" });
  assert.equal(main({ audit: empty, allowed: [], out: garbled.out }), 1);
  assert.match(garbled.lines.error[0], /FAIL: npm audit printed no JSON/);
});

test("runNpmAudit runs `npm audit --json` from the repo root", () => {
  const calls = [];
  const spawn = (cmd, args, opts) => {
    calls.push({ cmd, args, cwd: opts.cwd });
    return { stdout: "{}", error: undefined };
  };
  assert.deepEqual(runNpmAudit(spawn), { stdout: "{}", error: undefined });
  assert.deepEqual(calls, [
    {
      cmd: "npm",
      args: ["audit", "--json"],
      cwd: path.resolve(__dirname, ".."),
    },
  ]);
  // A spawn that never started reports no stdout as "", not null.
  const failed = runNpmAudit(() => ({ stdout: null, error: new Error("x") }));
  assert.equal(failed.stdout, "");
  assert.equal(failed.error.message, "x");
});

test("the shipped allowlist is frozen GHSA ids with reasons, and the default", () => {
  assert.ok(Object.isFrozen(ALLOWED));
  const ids = ALLOWED.map((a) => a.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const { id, reason } of ALLOWED) {
    assert.match(id, /^GHSA(-[0-9a-z]{4}){3}$/);
    assert.ok(reason.trim().length > 0, `${id} needs a reason`);
  }
  // With no allowlist argument, evaluate uses ALLOWED: against an empty
  // report, every shipped entry is stale.
  assert.deepEqual(evaluate(report([])).stale, [...ALLOWED]);
});
