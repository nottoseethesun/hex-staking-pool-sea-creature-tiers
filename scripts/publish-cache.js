/**
 * @file scripts/publish-cache.js
 * @description `npm run publish-cache` — publish the immutable `data/` cache as
 * the GitHub Release asset so a fresh install can `hexleague seed` it instead of
 * scanning from cold. It packages `data/eth` + `data/pls` into a gzipped tarball,
 * checksums it (SHA-256), and uploads it with the `gh` CLI, printing the
 * ready-to-share `hexleague seed` command.
 *
 * If a dashboard sync is running it is stopped first, so the tarball is a
 * consistent (not mid-write) snapshot, and restarted once the asset is pushed.
 * Maintainer tool: needs an authenticated `gh` CLI and a local cache, and it
 * refuses to package while any scan is still writing `data/`.
 */

"use strict";

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { parseArgs } = require("node:util");
const { log } = require("../src/log");
const { config } = require("../src/config");
const { readUpdateStatus } = require("../src/update-status");

const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(ROOT, "out");
const ASSET = "hex-cache.tar.gz";
const TARBALL = path.join(OUT_DIR, ASSET);
const BASE = `http://${config.host}:${config.port}`;

/** @param {number} ms @returns {Promise<void>} */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run a command, capturing output, and throw a clean error on failure.
 * @param {string} cmd
 * @param {string[]} args
 * @returns {string} trimmed stdout
 */
function run(cmd, args) {
  const res = spawnSync(cmd, args, { cwd: ROOT, encoding: "utf8" });
  if (res.error) throw new Error(`${cmd}: ${res.error.message}`);
  if (res.status !== 0) {
    throw new Error(
      `${cmd} ${args.join(" ")} failed:\n${res.stderr || res.stdout}`,
    );
  }
  return (res.stdout || "").trim();
}

/**
 * SHA-256 of a file, hex-encoded.
 * @param {string} file
 * @returns {string}
 */
function sha256(file) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(file))
    .digest("hex");
}

/** Refuse to publish unless both chains' ledgers are present. */
function assertCache() {
  for (const chain of ["eth", "pls"]) {
    if (!fs.existsSync(path.join(ROOT, "data", chain, "stakes.ndjson"))) {
      throw new Error(
        `data/${chain}/stakes.ndjson is missing — run 'hexleague update' first.`,
      );
    }
  }
}

/** The dashboard's status, or null when it is not reachable. */
async function dashboardStatus() {
  try {
    return await (await fetch(`${BASE}/api/status`)).json();
  } catch {
    return null;
  }
}

/**
 * Stop a running dashboard sync so `data/` is quiescent while it is packaged.
 * @returns {Promise<boolean>} whether a sync was stopped (and should restart)
 */
async function stopSyncIfRunning() {
  const st = await dashboardStatus();
  if (!st || !st.updating) return false;
  log.info("[publish-cache] a sync is running; stopping it first…");
  await fetch(`${BASE}/api/update/stop`, { method: "POST" }).catch(() => {});
  for (let i = 0; i < 120; i += 1) {
    const s = await dashboardStatus();
    if (!s || !s.updating) return true;
    await sleep(500);
  }
  throw new Error("the sync did not stop in time; aborting.");
}

/** Restart the dashboard sync (best-effort). */
async function restartSync() {
  log.info("[publish-cache] restarting the sync…");
  const res = await fetch(`${BASE}/api/update`, { method: "POST" }).catch(
    () => null,
  );
  if (!res || !res.ok) {
    log.warn("[publish-cache] could not restart the sync; start it manually.");
  }
}

/**
 * Create the release for `tag`, or upload the asset if the tag already exists.
 * @param {string} tag
 * @param {string} notes
 */
function releaseAsset(tag, notes) {
  const exists =
    spawnSync("gh", ["release", "view", tag], { cwd: ROOT, stdio: "ignore" })
      .status === 0;
  if (exists) {
    log.info("[publish-cache] release %s exists; replacing its asset", tag);
    run("gh", ["release", "upload", tag, TARBALL, "--clobber"]);
  } else {
    log.info("[publish-cache] creating release %s", tag);
    run("gh", [
      "release",
      "create",
      tag,
      TARBALL,
      "--title",
      `HEX cache snapshot ${tag}`,
      "--notes",
      notes,
    ]);
  }
}

/** Package the cache into a checksummed tarball and print the seed command. */
function packageAndPublish(tag) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  log.info("[publish-cache] packaging data/eth + data/pls -> %s", TARBALL);
  run("tar", ["-czf", TARBALL, "-C", "data", "eth", "pls"]);
  const digest = sha256(TARBALL);
  const mb = (fs.statSync(TARBALL).size / 1024 / 1024).toFixed(1);
  const repo = run("gh", [
    "repo",
    "view",
    "--json",
    "nameWithOwner",
    "-q",
    ".nameWithOwner",
  ]);
  const url = `https://github.com/${repo}/releases/download/${tag}/${ASSET}`;
  const seedCmd = `hexleague seed --url ${url} --sha256 ${digest}`;
  const notes = [
    `Immutable HEX stake/OA cache snapshot (${mb} MB). Seed a fresh install:`,
    "",
    "```",
    seedCmd,
    "```",
  ].join("\n");
  log.info("[publish-cache] %s MB, sha256=%s", mb, digest);
  releaseAsset(tag, notes);
  log.info("[publish-cache] published %s. Seed with:\n  %s", tag, seedCmd);
}

/** Stop the sync, publish the cache, then restart the sync if it was running. */
async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: { tag: { type: "string" } },
  });
  const tag = values.tag || `cache-${new Date().toISOString().slice(0, 10)}`;

  assertCache();
  const wasRunning = await stopSyncIfRunning();
  if (readUpdateStatus().updating) {
    throw new Error(
      "A scan is still writing data/ and could not be stopped; retry once idle.",
    );
  }

  try {
    packageAndPublish(tag);
  } catch (err) {
    if (wasRunning)
      log.warn("[publish-cache] publish failed; the sync is stopped.");
    throw err;
  }

  if (wasRunning) await restartSync();
}

main().catch((err) => {
  log.error(err.message);
  process.exit(1);
});
