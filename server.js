/**
 * @file server.js
 * @description The dashboard's UI + HTTP layer (Node built-in http). It serves
 * the static dashboard from public/ and a small JSON API, and delegates every
 * core action to the hexleague facade (src/hexleague.js): start a scan
 * (POST /api/update -> hexleague.update), stop it (POST /api/update/stop ->
 * hexleague.stop), and locate a staker (GET /api/whereami -> hexleague.whereami).
 * No domain logic lives here; the read-only endpoints stream the report the
 * pipeline produced. Localhost bind, no CSRF, no keys.
 */

"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { config } = require("./src/config");
const { log } = require("./src/log");
const { updateStatus } = require("./src/pipeline");
const hexleague = require("./src/hexleague");
const {
  readUpdateStatus,
  writeUpdateStatus,
  etaSeconds,
} = require("./src/update-status");
const { DISCLAIMER } = require("./src/disclaimer");
const { readJson, OUT_DIR } = require("./src/cache/store");
const { pidPath, writePid, clearPid } = require("./src/server-pid");

const PUBLIC_DIR = path.join(__dirname, "public");
const SUMMARY_PATH = path.join(OUT_DIR, "summary.json");
const OPENAPI_PATH = path.join(__dirname, "docs", "openapi.json");

// Shown when no out/summary.json exists yet — an honest statement of fact (the
// chains have not been scanned), not a "please wait" that implies a sync is
// already running when none is.
const NO_REPORT_MSG =
  "No report yet — Ethereum and PulseChain haven't been scanned.";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
};

/**
 * Send a JSON response (never cached).
 * @param {import('http').ServerResponse} res
 * @param {number} code
 * @param {any} obj
 */
function sendJson(res, code, obj) {
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(obj));
}

/**
 * Serve a static file from public/, guarding against path traversal.
 * @param {string} pathname
 * @param {import('http').ServerResponse} res
 */
function serveStatic(pathname, res) {
  const rel = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.resolve(path.join(PUBLIC_DIR, rel));
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
      return;
    }
    const ext = path.extname(filePath);
    const isHtml = ext === ".html";
    // Assets are unversioned (no content hash in the filename), so a long
    // max-age would strand the browser on a stale dashboard-*.js after an edit
    // — the HTML updates but the cached script does not. "no-cache" lets the
    // browser store them but forces revalidation, so an edit always takes hold.
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Cache-Control": isHtml ? "no-store" : "no-cache",
    });
    res.end(data);
  });
}

/** GET /api/summary */
function handleSummary(res) {
  const summary = readJson(SUMMARY_PATH, null);
  if (!summary) {
    sendJson(res, 404, { error: NO_REPORT_MSG });
    return;
  }
  sendJson(res, 200, summary);
}

/**
 * GET /api/whereami?address=…&tshares=…
 * @param {URL} url
 * @param {import('http').ServerResponse} res
 */
function handleWhereami(url, res) {
  const summary = readJson(SUMMARY_PATH, null);
  if (!summary) {
    sendJson(res, 404, { error: NO_REPORT_MSG });
    return;
  }
  const tshares = url.searchParams.get("tshares");
  const addresses = url.searchParams.getAll("address");
  const query =
    tshares !== null ? { tshares } : { addresses: addresses.filter(Boolean) };
  try {
    sendJson(res, 200, hexleague.whereami(summary, query));
  } catch (err) {
    sendJson(res, 400, { error: err.message });
  }
}

/**
 * GET /api/status — data freshness and whether an update is running.
 * @param {import('http').ServerResponse} res
 */
function handleStatus(res) {
  const status = updateStatus(readJson(SUMMARY_PATH, null), Date.now());
  const live = readUpdateStatus();
  const started = live.startedAt ? Date.parse(live.startedAt) : null;
  sendJson(res, 200, {
    ...status,
    updating: live.updating,
    progress: live.progress,
    phase: live.phase,
    etaSeconds: etaSeconds(started, live.samples, Date.now()),
  });
}

/**
 * POST /api/update — run the pipeline in the background if the data is stale.
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 */
function handleUpdate(req, res) {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Use POST to trigger an update." });
    return;
  }
  const status = updateStatus(readJson(SUMMARY_PATH, null), Date.now());
  if (!status.updateEnabled) {
    sendJson(res, 409, { error: status.reason || "Update not available." });
    return;
  }
  if (hexleague.isRunning() || readUpdateStatus().updating) {
    sendJson(res, 409, { error: "An update is already running." });
    return;
  }
  // Seed the shared status so /api/status reflects "updating" immediately;
  // the pipeline then owns the progress writes and clears the file when done.
  writeUpdateStatus(0, "Starting");
  sendJson(res, 202, { started: true });
  hexleague
    .update({ config, log })
    .then(() => log.info("[update] complete"))
    .catch((err) => {
      if (err && err.name === "AbortError") {
        log.info("[update] stopped by request");
      } else {
        log.error("[update] failed: %s", err.message);
      }
    });
}

/**
 * POST /api/update/stop — cooperatively cancel the running update, if any. The
 * pipeline halts at the next checkpoint-safe boundary and the cache stays
 * resumable, so a later start tops up from where it stopped.
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 */
function handleStop(req, res) {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Use POST to stop the scan." });
    return;
  }
  if (!hexleague.stop()) {
    sendJson(res, 409, { error: "No scan is running." });
    return;
  }
  sendJson(res, 202, { stopping: true });
}

/**
 * GET /api/health — liveness + version.
 * @param {import('http').ServerResponse} res
 */
function handleHealth(res) {
  const info = readJson(path.join(__dirname, "src", "build-info.json"), {});
  sendJson(res, 200, { ok: true, version: info.version || "dev" });
}

/**
 * GET /api/disclaimer — the canonical disclaimer text.
 * @param {import('http').ServerResponse} res
 */
function handleDisclaimer(res) {
  sendJson(res, 200, { disclaimer: DISCLAIMER });
}

/**
 * GET /api/openapi.json — the API description (self-describing API).
 * @param {import('http').ServerResponse} res
 */
function handleOpenapi(res) {
  const spec = readJson(OPENAPI_PATH, null);
  if (!spec) {
    sendJson(res, 404, { error: "OpenAPI spec not found." });
    return;
  }
  sendJson(res, 200, spec);
}

/**
 * Top-level request router.
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 */
function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (url.pathname === "/api/health") return handleHealth(res);
  if (url.pathname === "/api/summary") return handleSummary(res);
  if (url.pathname === "/api/whereami") return handleWhereami(url, res);
  if (url.pathname === "/api/status") return handleStatus(res);
  if (url.pathname === "/api/update/stop") return handleStop(req, res);
  if (url.pathname === "/api/update") return handleUpdate(req, res);
  if (url.pathname === "/api/disclaimer") return handleDisclaimer(res);
  if (url.pathname === "/api/openapi.json") return handleOpenapi(res);
  // Browsers auto-request /favicon.ico at the root; map it to the icon set.
  if (url.pathname === "/favicon.ico") {
    return serveStatic("/images/favicons/favicon.ico", res);
  }
  return serveStatic(url.pathname, res);
}

/**
 * Start the dashboard server.
 * @returns {import('http').Server}
 */
function start() {
  const server = http.createServer(handleRequest);
  const pidFile = pidPath(config);
  server.listen(config.port, config.host, () => {
    writePid(pidFile);
    log.info(
      "hexleague dashboard: http://%s:%d (read-only)",
      config.host,
      config.port,
    );
  });
  const shutdown = () => {
    clearPid(pidFile);
    process.exit(0);
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  return server;
}

if (require.main === module) start();

module.exports = { start, handleRequest };
