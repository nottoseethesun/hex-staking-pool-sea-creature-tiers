/**
 * @file scripts/check.js
 * @description The umbrella quality gate (run by `npm run check` and CI). It
 * runs every gate — ESLint, Stylelint, html-validate, markdownlint, Prettier
 * (JSON + YAML), actionlint, the three security audits (deps / security-lint /
 * secrets), and the test suite with coverage — capturing each tool's output
 * under test/report-artifacts/, writing a Markdown summary (surfaced in the CI
 * job summary), and exiting non-zero if any gate fails or line coverage falls
 * below the minimum.
 *
 * The immutable stake/OA cache (data/) and report outputs (out/) are moved
 * aside for the duration of the test run and restored afterwards (try/finally),
 * so a stray test can never corrupt the expensive scan cache.
 */

"use strict";

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { log } = require("../src/log");

const ROOT = path.resolve(__dirname, "..");
process.chdir(ROOT);

const REPORT_DIR = path.join("test", "report-artifacts");
const COVERAGE_MIN = 80;

/**
 * Absolute path to a locally-installed tool binary.
 * @param {string} name
 * @returns {string}
 */
function binPath(name) {
  return path.join(ROOT, "node_modules", ".bin", name);
}

/**
 * Run a command synchronously, capturing combined stdout + stderr.
 * @param {string} cmd
 * @param {string[]} args
 * @returns {{ status: number, output: string }}
 */
function run(cmd, args) {
  const res = spawnSync(cmd, args, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const status = res.status === null ? 1 : res.status;
  const output = (res.stdout || "") + (res.stderr || "");
  return { status, output };
}

/**
 * List files in `dir` (non-recursive) whose name ends with `ext`.
 * @param {string} dir
 * @param {string} ext
 * @returns {string[]}
 */
function listFiles(dir, ext) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(ext))
    .map((f) => path.join(dir, f));
}

/** Recreate a clean report directory. */
function resetReportDir() {
  fs.rmSync(REPORT_DIR, { recursive: true, force: true });
  fs.mkdirSync(REPORT_DIR, { recursive: true });
}

/**
 * Persist a step's captured output as a text artifact.
 * @param {string} id
 * @param {string} output
 */
function writeArtifact(id, output) {
  fs.writeFileSync(path.join(REPORT_DIR, `${id}.txt`), output);
}

/**
 * Move data/ and out/ aside; return a restore function.
 * @returns {() => void}
 */
function protectCaches() {
  const aside = path.join(REPORT_DIR, ".protected");
  fs.mkdirSync(aside, { recursive: true });
  const moved = [];
  for (const name of ["data", "out"]) {
    if (fs.existsSync(name)) {
      const dest = path.join(aside, name);
      fs.rmSync(dest, { recursive: true, force: true });
      fs.renameSync(name, dest);
      moved.push(name);
    }
  }
  return function restore() {
    for (const name of moved) {
      fs.rmSync(name, { recursive: true, force: true });
      fs.renameSync(path.join(aside, name), name);
    }
  };
}

/**
 * Parse the "all files" line-coverage percent from test output.
 * @param {string} output
 * @returns {number | null}
 */
function parseCoverage(output) {
  const match = output.match(/all files[^\n|]*\|\s*([\d.]+)/i);
  return match ? Number(match[1]) : null;
}

/**
 * The non-test gates, run in order; each continues past failure so every
 * failure surfaces in one run.
 * @returns {{ id: string, label: string, cmd: string, args: string[] }[]}
 */
function lintSteps() {
  const workflows = listFiles(path.join(".github", "workflows"), ".yml");
  return [
    {
      id: "eslint",
      label: "ESLint",
      cmd: binPath("eslint"),
      args: [
        "bin/",
        "src/",
        "test/",
        "scripts/",
        "utils/",
        "server.js",
        "public/dashboard-*.js",
        "eslint-rules/",
        "--max-warnings",
        "0",
      ],
    },
    {
      id: "stylelint",
      label: "Stylelint",
      cmd: binPath("stylelint"),
      args: ["public/*.css"],
    },
    {
      id: "htmlvalidate",
      label: "html-validate",
      cmd: binPath("html-validate"),
      args: ["public/*.html"],
    },
    {
      id: "markdownlint",
      label: "markdownlint",
      cmd: binPath("markdownlint-cli2"),
      args: ["README.md", "CLAUDE.md", "docs/**/*.md"],
    },
    {
      id: "prettier-json",
      label: "Prettier (JSON)",
      cmd: binPath("prettier"),
      args: ["--check", "**/*.json"],
    },
    {
      id: "prettier-yaml",
      label: "Prettier (YAML)",
      cmd: binPath("prettier"),
      args: ["--check", "**/*.{yml,yaml}"],
    },
    {
      id: "actionlint",
      label: "actionlint",
      cmd: binPath("github-actionlint"),
      args: workflows,
    },
    {
      id: "audit-deps",
      label: "Dependency audit",
      cmd: "npm",
      args: ["audit", "--audit-level=high"],
    },
    {
      id: "audit-security",
      label: "Security lint",
      cmd: binPath("eslint"),
      args: [
        "-c",
        "eslint-security.config.js",
        "bin/",
        "src/",
        "scripts/",
        "utils/",
        "server.js",
        "--max-warnings",
        "0",
      ],
    },
    {
      id: "audit-secrets",
      label: "Secret scan",
      cmd: binPath("secretlint"),
      args: [
        "src/**/*.js",
        "bin/**/*.js",
        "scripts/**/*.js",
        "server.js",
        ".env*",
        "*.json",
      ],
    },
  ];
}

/**
 * Run the test suite with coverage while the caches are protected.
 * @returns {{ status: number, output: string }}
 */
function runTests() {
  const testFiles = [
    ...listFiles("test", ".test.js"),
    ...listFiles(path.join("test", "eslint-rules"), ".test.js"),
  ];
  const args = [
    "--test",
    "--test-concurrency=8",
    "--experimental-test-coverage",
    ...testFiles,
  ];
  const restore = protectCaches();
  try {
    return run("node", args);
  } finally {
    restore();
  }
}

/**
 * Build the Markdown + terminal summary and return overall pass/fail.
 * @param {{ label: string, status: number }[]} results
 * @param {number | null} coverage
 * @returns {boolean}
 */
function summarize(results, coverage) {
  const lines = ["# Check summary", "", "| Gate | Result |", "| --- | --- |"];
  let ok = true;
  for (const r of results) {
    const pass = r.status === 0;
    ok = ok && pass;
    lines.push(`| ${r.label} | ${pass ? "pass" : "FAIL"} |`);
  }
  const covOk = coverage === null || coverage >= COVERAGE_MIN;
  ok = ok && covOk;
  const covText =
    coverage === null ? "n/a (unparsed)" : `${coverage.toFixed(2)}%`;
  lines.push(
    `| Coverage (>= ${COVERAGE_MIN}%) | ${covOk ? "ok" : "FAIL"} ${covText} |`,
  );
  lines.push("");
  fs.writeFileSync(path.join(REPORT_DIR, "summary.md"), lines.join("\n"));
  return ok;
}

/** Orchestrate every gate, write the summary, and set the exit code. */
function main() {
  resetReportDir();
  const results = [];
  for (const step of lintSteps()) {
    const r = run(step.cmd, step.args);
    writeArtifact(step.id, r.output);
    results.push({ label: step.label, status: r.status });
    log.info("%s %s", r.status === 0 ? "PASS" : "FAIL", step.label);
  }
  const test = runTests();
  writeArtifact("tests", test.output);
  results.push({ label: "Tests", status: test.status });
  const coverage = parseCoverage(test.output);
  log.info("%s Tests", test.status === 0 ? "PASS" : "FAIL");

  const ok = summarize(results, coverage);
  log.info(
    "\n%s",
    fs.readFileSync(path.join(REPORT_DIR, "summary.md"), "utf8"),
  );
  process.exit(ok ? 0 : 1);
}

main();
