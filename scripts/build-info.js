/**
 * @file scripts/build-info.js
 * @description Generates build metadata (package version + git commit) into
 * src/build-info.json — a small sidecar the server reads to show a version in
 * the dashboard footer. A release tarball without a .git directory still gets
 * a valid file (git fields fall back to "unknown"). Run by `npm run build`,
 * `prestart`, `prelint`, and the check pipeline.
 */

"use strict";

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { log } = require("../src/log");

/**
 * Run a git command, returning trimmed stdout or null on failure.
 * @param {string} cmd git command line
 * @returns {string | null}
 */
function git(cmd) {
  try {
    const out = execSync(cmd, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return out.trim();
  } catch {
    return null;
  }
}

const commit = git("git rev-parse --short HEAD") || "unknown";
const commitDate = git("git log -1 --format=%cI") || "unknown";
const tag = git("git describe --exact-match --tags HEAD") || null;

const pkgPath = path.join(__dirname, "..", "package.json");
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
const version = pkg.version || "unknown";

const outPath = path.join(__dirname, "..", "src", "build-info.json");
const info = { version, commit, commitDate, tag };
fs.writeFileSync(outPath, JSON.stringify(info, null, 2) + "\n");

log.info(
  "[build-info] version=%s commit=%s date=%s tag=%s",
  version,
  commit,
  commitDate,
  tag || "(none)",
);
