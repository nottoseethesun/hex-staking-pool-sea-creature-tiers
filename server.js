/**
 * @file server.js
 * @description Local, read-only dashboard server (Node built-in http). Serves
 * the static dashboard from public/ and two read-only JSON endpoints:
 * GET /api/summary (streams out/summary.json) and GET /api/whereami
 * (?address=…&address=… | ?tshares=N), reusing src/whereami.js so no lookup
 * logic is duplicated in the browser. No state-changing routes, no CSRF, no
 * keys — it only reads the report the CLI produced.
 */

"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { config } = require("./src/config");
const { log } = require("./src/log");
const { locate } = require("./src/whereami");
const { updateStatus, runUpdate } = require("./src/pipeline");
const {
  readUpdateStatus,
  writeUpdateStatus,
  etaSeconds,
} = require("./src/update-status");
const { DISCLAIMER } = require("./src/disclaimer");
const { readJson, OUT_DIR } = require("./src/cache/store");

const PUBLIC_DIR = path.join(__dirname, "public");
const SUMMARY_PATH = path.join(OUT_DIR, "summary.json");
const OPENAPI_PATH = path.join(__dirname, "docs", "openapi.json");

// Shown when no out/summary.json exists yet — an honest statement of fact (the
// chains have not been scanned), not a "please wait" that implies a sync is
// already running when none is.
const NO_REPORT_MSG =
  "No report yet — Ethereum and PulseChain haven't been scanned.";

// The AbortController for the in-process update, or null when idle. Set when a
// scan starts (POST /api/update), aborted by POST /api/update/stop, and cleared
// when the run settles.
let activeUpdate = null;

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
    sendJson(res, 200, locate(summary, query));
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
    etaSeconds: etaSeconds(live.progress, started, Date.now()),
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
  if (activeUpdate || readUpdateStatus().updating) {
    sendJson(res, 409, { error: "An update is already running." });
    return;
  }
  // Seed the shared status so /api/status reflects "updating" immediately;
  // runUpdate then owns the progress writes and clears the file when done.
  writeUpdateStatus(0, "Starting");
  const controller = new AbortController();
  activeUpdate = controller;
  sendJson(res, 202, { started: true });
  runUpdate({ config, log, signal: controller.signal })
    .then(() => log.info("[update] complete"))
    .catch((err) => {
      if (err && err.name === "AbortError") {
        log.info("[update] stopped by request");
      } else {
        log.error("[update] failed: %s", err.message);
      }
    })
    .finally(() => {
      if (activeUpdate === controller) activeUpdate = null;
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
  if (!activeUpdate) {
    sendJson(res, 409, { error: "No scan is running." });
    return;
  }
  activeUpdate.abort();
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
  server.listen(config.port, config.host, () => {
    log.info(
      "hexleague dashboard: http://%s:%d (read-only)",
      config.host,
      config.port,
    );
  });
  return server;
}

if (require.main === module) start();

module.exports = { start, handleRequest };
