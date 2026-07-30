/**
 * @file src/seed.js
 * @description Seed the immutable cache from a pre-built snapshot so a fresh
 * install can skip the multi-hour cold scan. Downloads a .tar.gz over HTTPS,
 * verifies its SHA-256 against an expected digest (refusing to extract on any
 * mismatch), and unpacks it into data/. `update` then tops up incrementally
 * from the snapshot's block. The snapshot is regenerable chain data, so this is
 * a convenience, never a trust root — the checksum is the gate.
 */

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { Readable } = require("stream");
const { pipeline } = require("stream/promises");
const { DATA_DIR } = require("./cache/store");

/**
 * Stream an HTTPS URL to a local file.
 * @param {string} url
 * @param {string} destPath
 * @returns {Promise<void>}
 */
async function downloadFile(url, destPath) {
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`Download failed (HTTP ${res.status}) for ${url}`);
  }
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(destPath));
}

/**
 * Streaming SHA-256 of a file, hex-encoded (large files stay off-heap).
 * @param {string} filePath
 * @returns {Promise<string>}
 */
async function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

/**
 * Throw unless `actual` matches `expected` (case-insensitive, optional 0x).
 * @param {string} actual
 * @param {string} expected
 */
function assertChecksum(actual, expected) {
  const norm = (s) =>
    String(s || "")
      .trim()
      .toLowerCase()
      .replace(/^0x/, "");
  if (!norm(expected) || norm(actual) !== norm(expected)) {
    throw new Error(
      `SHA-256 mismatch — refusing to extract.\n  expected: ${expected}\n  actual:   ${actual}`,
    );
  }
}

/**
 * Extract a gzipped tarball into a directory via system tar (streams; low
 * memory). tar rejects absolute / `..` members, and we only reach here once the
 * checksum has matched a trusted digest.
 * @param {string} tarPath
 * @param {string} destDir
 * @returns {Promise<void>}
 */
function extractTarGz(tarPath, destDir) {
  return new Promise((resolve, reject) => {
    const child = spawn("tar", ["-xzf", tarPath, "-C", destDir], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`tar exited ${code}: ${stderr.trim()}`));
    });
  });
}

/**
 * Whether a data directory already holds a scan (any chain subdirectory).
 * @param {string} [dir]
 * @returns {boolean}
 */
function dataDirPopulated(dir = DATA_DIR) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .some((entry) => entry.isDirectory());
  } catch {
    return false;
  }
}

/**
 * Seed the cache from a checksum-verified snapshot.
 * @param {object} ctx { url, sha256, force?, log }
 * @returns {Promise<void>}
 */
async function seed(ctx) {
  const { url, sha256, force = false, log } = ctx;
  if (!url || !sha256) {
    throw new Error("seed requires --url <tarball> and --sha256 <hex>.");
  }
  if (!force && dataDirPopulated()) {
    throw new Error(
      "data/ already holds a cache — move it aside or pass --force to overwrite.",
    );
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = path.join(os.tmpdir(), `hexleague-seed-${process.pid}.tar.gz`);
  try {
    log.info("[seed] downloading %s", url);
    await downloadFile(url, tmp);
    log.info("[seed] verifying SHA-256…");
    assertChecksum(await sha256File(tmp), sha256);
    log.info("[seed] checksum ok; extracting into %s", DATA_DIR);
    await extractTarGz(tmp, DATA_DIR);
    log.info("[seed] done — run 'hexleague update' to top up to the tip.");
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

module.exports = {
  seed,
  downloadFile,
  sha256File,
  assertChecksum,
  extractTarGz,
  dataDirPopulated,
};
