/**
 * @file src/cache/store.js
 * @description Minimal-footprint, no-expiry cache store. Chain-scoped scan data
 * lives under data/<chain>/; derived report outputs under out/. Blockchain data
 * is immutable, so nothing here has a TTL — callers append deltas and advance a
 * checkpoint. Provides JSON read/write (atomic) and append-only NDJSON helpers
 * (streamed on read to keep the footprint small).
 */

"use strict";

const fs = require("fs");
const path = require("path");
const readline = require("readline");

const ROOT = path.resolve(__dirname, "..", "..");
const DATA_DIR = path.join(ROOT, "data");
const OUT_DIR = path.join(ROOT, "out");

/**
 * Directory holding a chain's cache files.
 * @param {string} chainKey
 * @returns {string}
 */
function chainDir(chainKey) {
  return path.join(DATA_DIR, chainKey);
}

/**
 * Create a directory (and parents) if missing.
 * @param {string} dir
 */
function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * Read + parse a JSON file, returning `fallback` if missing/unparseable.
 * @param {string} file
 * @param {any} [fallback]
 * @returns {any}
 */
function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

/**
 * Write JSON atomically (temp file + rename) so a crash can't truncate it.
 * @param {string} file
 * @param {any} obj
 */
function writeJson(file, obj) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

/**
 * Append rows to an NDJSON file (one compact JSON object per line).
 * @param {string} file
 * @param {object[]} rows
 */
function appendNdjson(file, rows) {
  if (rows.length === 0) return;
  ensureDir(path.dirname(file));
  const text = `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;
  fs.appendFileSync(file, text);
}

/**
 * Drop a partial trailing line (one not terminated by a newline) — the only way
 * a hard shutdown mid-append can leave the append-only ledger inconsistent. Safe
 * to run before every scan session: the checkpoint re-scans the dropped window.
 * @param {string} file
 */
function truncatePartialLine(file) {
  let fd;
  try {
    fd = fs.openSync(file, "r+");
  } catch {
    return; // missing/unwritable — nothing to repair
  }
  try {
    const size = fs.fstatSync(fd).size;
    if (size === 0) return;
    const tail = Buffer.alloc(1);
    fs.readSync(fd, tail, 0, 1, size - 1);
    if (tail[0] === 0x0a) return; // ends on a newline — already clean
    const window = Math.min(size, 1 << 16);
    const buf = Buffer.alloc(window);
    fs.readSync(fd, buf, 0, window, size - window);
    const nl = buf.lastIndexOf(0x0a);
    fs.ftruncateSync(fd, nl === -1 ? 0 : size - window + nl + 1);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Stream an NDJSON file line by line, invoking `onRow` per parsed row.
 * @param {string} file
 * @param {(row: any) => void} onRow
 * @returns {Promise<number>} number of rows read
 */
async function readNdjson(file, onRow) {
  if (!fs.existsSync(file)) return 0;
  const rl = readline.createInterface({
    input: fs.createReadStream(file),
    crlfDelay: Infinity,
  });
  let count = 0;
  for await (const line of rl) {
    if (line.length === 0) continue;
    onRow(JSON.parse(line));
    count += 1;
  }
  return count;
}

module.exports = {
  ROOT,
  DATA_DIR,
  OUT_DIR,
  chainDir,
  ensureDir,
  readJson,
  writeJson,
  appendNdjson,
  truncatePartialLine,
  readNdjson,
};
