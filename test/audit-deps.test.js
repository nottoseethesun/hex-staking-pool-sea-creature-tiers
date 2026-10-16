"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { format } = require("node:util");
const {
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

/**
 * A temp project root holding a package.json and a stand-in lockfile.
 * @param {object} pkg
 * @returns {string} the directory; the caller removes it
 */
function fixtureRoot(pkg) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "audit-deps-test-"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify(pkg));
  fs.writeFileSync(path.join(root, "package-lock.json"), "LOCK");
  return root;
}

const HIGH = advisory("braces", "GHSA-test-high-0001", "high");
const CRITICAL = advisory("undici", "GHSA-test-crit-0002", "critical");
const LOW = advisory("katex", "GHSA-test-low0-0004", "low");
const ALLOW_HIGH = [{ id: "GHSA-test-high-0001", reason: "no fix yet" }];
const ZIP_HIGH = advisory("adm-zip", "GHSA-test-zip0-0007", "high");
// ZIP_HIGH as evaluate reports it: the shape judgeOverrides gets back from
// gainedWithout.
const ZIP_KEPT_OUT = evaluate(report([ZIP_HIGH]), []).blocking;
const ZIP = [{ name: "adm-zip", reason: "parent pins a vulnerable line" }];
// For main tests about advisories alone: no overrides to read or re-resolve.
const NO_OVERRIDES = { overrideNames: () => [], overrides: [] };

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
  assert.equal(main({ audit, allowed: ALLOW_HIGH, ...NO_OVERRIDES, out }), 0);
  assert.deepEqual(lines.error, []);
  assert.match(lines.info[0], /^\[audit-deps\] allowed {2}high braces/);
  assert.equal(
    lines.info.at(-1),
    "[audit-deps] PASS: 0 blocking, 0 stale, 0 unlisted, 1 allowed, " +
      "0 below the gate, 0 overrides needed",
  );
});

test("main fails on a blocking advisory", () => {
  const { lines, out } = sink();
  const audit = () => ({ stdout: JSON.stringify(report([HIGH])) });
  assert.equal(main({ audit, allowed: [], ...NO_OVERRIDES, out }), 1);
  assert.match(lines.info[0], /^\[audit-deps\] BLOCKING high braces/);
  assert.equal(
    lines.error[0],
    "[audit-deps] FAIL: 1 blocking, 0 stale, 0 unlisted, 0 allowed, " +
      "0 below the gate, 0 overrides needed",
  );
});

test("main fails closed when npm audit cannot run or prints no report", () => {
  const notRun = sink();
  const spawnError = () => ({ stdout: "", error: new Error("spawn ENOENT") });
  const deps = { allowed: [], ...NO_OVERRIDES };
  assert.equal(main({ audit: spawnError, ...deps, out: notRun.out }), 1);
  assert.match(notRun.lines.error[0], /did not run: spawn ENOENT$/);

  const garbled = sink();
  const empty = () => ({ stdout: "" });
  assert.equal(main({ audit: empty, ...deps, out: garbled.out }), 1);
  assert.match(garbled.lines.error[0], /FAIL: npm audit printed no JSON/);
});

test("runNpmAudit runs `npm audit --json`, from the repo root by default", () => {
  const calls = [];
  const spawn = (cmd, args, opts) => {
    calls.push({ cmd, args, cwd: opts.cwd });
    return { stdout: "{}", error: undefined };
  };
  assert.deepEqual(runNpmAudit(spawn), { stdout: "{}", error: undefined });
  runNpmAudit(spawn, "/elsewhere");
  assert.deepEqual(calls, [
    {
      cmd: "npm",
      args: ["audit", "--json"],
      cwd: path.resolve(__dirname, ".."),
    },
    { cmd: "npm", args: ["audit", "--json"], cwd: "/elsewhere" },
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

test("judgeOverrides keeps an override that keeps a gating advisory out", () => {
  const judged = judgeOverrides(["adm-zip"], () => ZIP_KEPT_OUT, ZIP);
  assert.equal(judged.ok, true);
  assert.deepEqual(judged.needed, [{ ...ZIP[0], prevents: ZIP_KEPT_OUT }]);
  assert.deepEqual(
    [judged.stale, judged.unlisted, judged.orphaned],
    [[], [], []],
  );
});

test("judgeOverrides fails an override that keeps nothing out", () => {
  const judged = judgeOverrides(["adm-zip"], () => [], ZIP);
  assert.equal(judged.ok, false);
  assert.deepEqual(judged.needed, []);
  assert.deepEqual(judged.stale, [{ ...ZIP[0], prevents: [] }]);
});

test("judgeOverrides fails an unreasoned override and a reason with none", () => {
  const asked = [];
  const gainedWithout = (name) => {
    asked.push(name);
    return [];
  };
  const judged = judgeOverrides(["left-pad"], gainedWithout, ZIP);
  assert.equal(judged.ok, false);
  assert.deepEqual(judged.unlisted, ["left-pad"]);
  assert.deepEqual(judged.orphaned, ZIP);
  // An override with no reason is reported, not re-resolved.
  assert.deepEqual(asked, []);
});

test("renderOverrides lists needed, stale, unlisted, then orphaned", () => {
  const judged = judgeOverrides(
    ["adm-zip", "old", "new"],
    // An advisory id that comes back twice is listed once.
    (name) => (name === "adm-zip" ? [...ZIP_KEPT_OUT, ...ZIP_KEPT_OUT] : []),
    [
      ...ZIP,
      { name: "old", reason: "was needed" },
      { name: "gone", reason: "" },
    ],
  );
  assert.deepEqual(renderOverrides(judged), [
    "override adm-zip keeps out GHSA-test-zip0-0007 — parent pins a vulnerable line",
    "STALE    override old keeps out no high or critical advisory; remove it from package.json and from OVERRIDES in scripts/audit-deps.js",
    "UNLISTED override new has no reason; add one to OVERRIDES in scripts/audit-deps.js",
    "STALE    OVERRIDES entry gone matches no package.json override; remove it from scripts/audit-deps.js",
  ]);
});

test("readOverrides lists the top-level overrides in package.json", () => {
  const root = fixtureRoot({ overrides: { a: "^1.0.0", b: { c: "^2.0.0" } } });
  const bare = fixtureRoot({ name: "no-overrides" });
  try {
    assert.deepEqual(readOverrides(root), ["a", "b"]);
    assert.deepEqual(readOverrides(bare), []);
  } finally {
    for (const dir of [root, bare]) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("auditWithout audits a temp copy re-resolved without that override", () => {
  const overrides = { a: "^1.0.0", b: "^2.0.0" };
  const root = fixtureRoot({ name: "fixture", overrides });
  try {
    const calls = [];
    const spawn = (cmd, args, opts) => {
      const read = (file) => fs.readFileSync(path.join(opts.cwd, file), "utf8");
      calls.push({
        argv: [cmd, ...args],
        cwd: opts.cwd,
        overrides: JSON.parse(read("package.json")).overrides,
        lock: read("package-lock.json"),
      });
      return args[0] === "install"
        ? { status: 0, stderr: "" }
        : { stdout: '{"vulnerabilities":{}}' };
    };
    assert.deepEqual(auditWithout("a", { root, spawn }), {
      stdout: '{"vulnerabilities":{}}',
      error: undefined,
    });
    assert.deepEqual(
      calls.map((c) => c.argv),
      [
        [
          "npm",
          "install",
          "--package-lock-only",
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
        ],
        ["npm", "audit", "--json"],
      ],
    );
    for (const call of calls) {
      assert.notEqual(call.cwd, root); // a temp copy, never the project
      assert.deepEqual(call.overrides, { b: "^2.0.0" });
      assert.equal(call.lock, "LOCK");
    }
    assert.equal(fs.existsSync(calls[0].cwd), false); // the copy is removed
    const kept = JSON.parse(
      fs.readFileSync(path.join(root, "package.json"), "utf8"),
    );
    assert.deepEqual(kept.overrides, overrides); // the original is untouched
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("auditWithout fails closed when the re-resolve fails, and cleans up", () => {
  const root = fixtureRoot({ name: "fixture", overrides: { a: "^1.0.0" } });
  try {
    let dir;
    const refused = (cmd, args, opts) => {
      dir = opts.cwd;
      return {
        status: 1,
        stderr: "npm error code ECONNREFUSED\nnpm error syscall connect\n",
      };
    };
    assert.throws(
      () => auditWithout("a", { root, spawn: refused }),
      /^Error: re-resolving without override a failed: npm error code ECONNREFUSED$/,
    );
    assert.equal(fs.existsSync(dir), false);
    const cases = [
      [
        () => ({ status: null, error: new Error("spawn npm ENOENT") }),
        /failed: spawn npm ENOENT$/,
      ],
      [() => ({ status: 1, stderr: "odd\nlast words\n" }), /: last words$/],
      [() => ({ status: 1, stderr: null }), /: no output$/],
    ];
    for (const [spawn, why] of cases) {
      assert.throws(() => auditWithout("a", { root, spawn }), why);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("main passes while an override still keeps an advisory out", () => {
  const { lines, out } = sink();
  const asked = [];
  const code = main({
    audit: () => ({ stdout: JSON.stringify(report([])) }),
    auditWithoutOverride: (name) => {
      asked.push(name);
      return { stdout: JSON.stringify(report([ZIP_HIGH])) };
    },
    overrideNames: () => ["adm-zip"],
    allowed: [],
    overrides: ZIP,
    out,
  });
  assert.equal(code, 0);
  assert.deepEqual(asked, ["adm-zip"]);
  assert.deepEqual(lines.info, [
    "[audit-deps] override adm-zip keeps out GHSA-test-zip0-0007 — parent pins a vulnerable line",
    "[audit-deps] PASS: 0 blocking, 0 stale, 0 unlisted, 0 allowed, 0 below the gate, 1 override needed",
  ]);
});

test("main fails on a stale override; already-blocking advisories don't count", () => {
  // The tree already blocks on HIGH, and dropping the override changes nothing.
  const { lines, out } = sink();
  const blocked = () => ({ stdout: JSON.stringify(report([HIGH])) });
  const code = main({
    audit: blocked,
    auditWithoutOverride: blocked,
    overrideNames: () => ["adm-zip"],
    allowed: [],
    overrides: ZIP,
    out,
  });
  assert.equal(code, 1);
  assert.match(lines.info[1], /^\[audit-deps\] STALE {4}override adm-zip /);
  assert.equal(
    lines.error[0],
    "[audit-deps] FAIL: 1 blocking, 1 stale, 0 unlisted, 0 allowed, " +
      "0 below the gate, 0 overrides needed",
  );
});

test("main fails closed when an override's audit cannot be made", () => {
  const deps = {
    audit: () => ({ stdout: JSON.stringify(report([])) }),
    overrideNames: () => ["adm-zip"],
    allowed: [],
    overrides: ZIP,
  };
  const refused = sink();
  const relockFails = () => {
    throw new Error("re-resolving without override adm-zip failed: E");
  };
  const code = main({
    ...deps,
    auditWithoutOverride: relockFails,
    out: refused.out,
  });
  assert.equal(code, 1);
  assert.deepEqual(refused.lines.error, [
    "[audit-deps] FAIL: re-resolving without override adm-zip failed: E",
  ]);

  const notRun = sink();
  const spawnError = () => ({ stdout: "", error: new Error("spawn ENOENT") });
  assert.equal(
    main({ ...deps, auditWithoutOverride: spawnError, out: notRun.out }),
    1,
  );
  assert.match(notRun.lines.error[0], /did not run: spawn ENOENT$/);
});

test("the shipped OVERRIDES are frozen, named, reasoned, and the default", () => {
  assert.ok(Object.isFrozen(OVERRIDES));
  const names = OVERRIDES.map((o) => o.name);
  assert.equal(new Set(names).size, names.length);
  for (const { name, reason } of OVERRIDES) {
    assert.match(name, /^(@[a-z0-9-]+\/)?[a-z0-9._-]+$/);
    assert.ok(reason.trim().length > 0, `${name} needs a reason`);
  }
  // With no entries argument, judgeOverrides uses OVERRIDES: with no
  // overrides in package.json, every shipped entry is orphaned.
  assert.deepEqual(judgeOverrides([], () => []).orphaned, [...OVERRIDES]);
});
