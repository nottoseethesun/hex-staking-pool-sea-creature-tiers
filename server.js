/**
 * @file server.js
 * @description The dashboard's UI + HTTP layer (Node built-in http). It serves
 * the static dashboard from public/ and a small JSON API, and delegates every
 * core action to the hexleague facade (src/hexleague.js): start a scan
 * (POST /api/update -> hexleague.update), stop it (POST /api/update/stop ->
 * hexleague.stop), and locate a staker (GET /api/whereami -> hexleague.whereami).
 * Two named read-only endpoints expose the public sea-creature API over the same
 * cached report: GET /api/what-is-my-hex-staking-sea-creature (ranking for a
 * T-Share count + full pool data) and GET
 * /api/get-hex-staking-pool-sea-creature-data (pool data, no parameter). No
 * domain logic lives here; the read-only endpoints stream the report the
 * pipeline produced without ever triggering a scan. Localhost bind, no CSRF,
 * no keys.
 */

"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { config, describeConfig } = require("./src/config");
const { log } = require("./src/log");
const { updateStatus } = require("./src/pipeline");
const hexleague = require("./src/hexleague");
const { runPreflight, formatPreflight } = require("./src/rpc/trace-preflight");
const { hasVault } = require("./src/secrets/store");
const { storeSecrets, unlockVault } = require("./src/secrets/service");
const { promptHidden } = require("./src/secrets/prompt");
const { collectRpcSecrets } = require("./src/secrets/moralis-setup");
const {
  startUnlockSocket,
  socketPath: unlockSocketPath,
  handleCommand: handleVaultCommand,
} = require("./src/secrets/unlock-socket");
const {
  readUpdateStatus,
  writeUpdateStatus,
  etaSeconds,
} = require("./src/update-status");
const { DISCLAIMER } = require("./src/disclaimer");
const { readJson, OUT_DIR } = require("./src/cache/store");
const {
  whatIsMySeaCreature,
  buildPoolData,
} = require("./src/report/pool-data");
const { pidPath, writePid, clearPid } = require("./src/server-pid");

// Startup trace-capability preflight result; the dashboard masks the UI when it
// fails and scanning is gated on it. Refreshed after a vault unlock.
let preflightState = { ok: true };

// Server-domain ("[hexleague server]") startup banner — azure on very dark gray
// with a rocket each side, echoing the sibling lp-ranger tool's boot banners.
// Passed through log.info, which injects the timestamp after the tag.
const SERVER_STARTED =
  "\x1b[38;2;0;191;255;48;2;25;25;25m[hexleague server] " +
  "🚀 Started. 🚀\x1b[0m";

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
 * GET /api/what-is-my-hex-staking-sea-creature?tshares=<positive number, <=8 dp>
 * The caller's sea-creature ranking for a non-zero positive T-Share count (up to
 * 8 decimal places), plus the whole staking-pool data sub-object (totals, tier
 * breakdown, roster, and per-chain as-of block + UTC time). Reads
 * out/summary.json only — never triggers a scan. Answers 400 on a non-positive
 * or over-precise tshares.
 * @param {URL} url
 * @param {import('http').ServerResponse} res
 */
function handleWhatIsMySeaCreature(url, res) {
  const summary = readJson(SUMMARY_PATH, null);
  if (!summary) {
    sendJson(res, 404, { error: NO_REPORT_MSG });
    return;
  }
  try {
    const tshares = url.searchParams.get("tshares");
    sendJson(res, 200, whatIsMySeaCreature(summary, tshares));
  } catch (err) {
    sendJson(res, 400, { error: err.message });
  }
}

/**
 * GET /api/get-hex-staking-pool-sea-creature-data
 * The whole staking-pool data sub-object (no parameter) — everything
 * what-is-my-hex-staking-sea-creature returns except the per-caller ranking.
 * Reads out/summary.json only — never triggers a scan.
 * @param {import('http').ServerResponse} res
 */
function handlePoolData(res) {
  const summary = readJson(SUMMARY_PATH, null);
  if (!summary) {
    sendJson(res, 404, { error: NO_REPORT_MSG });
    return;
  }
  sendJson(res, 200, {
    disclaimer: summary.disclaimer,
    stakingPool: buildPoolData(summary),
  });
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
  if (!preflightState.ok) {
    log.warn(
      "[update] blocked — trace preflight failing; unlock a trace RPC " +
        "(Help → Secrets) or set ETH_RPC_URLS / PLS_RPC_URLS.",
    );
    sendJson(res, 409, {
      error:
        "Scanning is disabled: the trace-capability preflight failed. Unlock a " +
        "trace RPC (Help → Secrets) or set ETH_RPC_URLS / PLS_RPC_URLS.",
    });
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
  hexleague.update({ config, log }).catch((err) => {
    // The facade logs "[hexleague sync] 🚀 Started."/"✅ Complete."; surface the
    // two non-happy outcomes here (it has the AbortError context).
    if (err && err.name === "AbortError") {
      log.info("[hexleague sync] ⏹ Stopped by request.");
    } else {
      log.error("[hexleague sync] ❌ Failed: %s", err.message);
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
 * Re-run the trace preflight (skipped when disabled) and store the result so the
 * dashboard mask + scan gate reflect the latest RPC set (e.g. after a vault
 * unlock adds a private trace endpoint).
 * @returns {Promise<object>}
 */
async function refreshPreflight() {
  const result = config.tracePreflight
    ? await runPreflight(config)
    : { ok: true, skipped: true };
  // hasVault lets the dashboard tell a first run (no password yet — a friendly
  // setup panel) from a returning misconfiguration (the red problem mask).
  preflightState = { ...result, hasVault: hasVault() };
  return preflightState;
}

/** Log the current preflight verdict (a warning + report when it fails). */
function logPreflight() {
  if (preflightState.ok) {
    log.info(
      "[preflight] %s",
      preflightState.skipped
        ? "skipped (TRACE_PREFLIGHT=0)"
        : `OK — >=${preflightState.min} trace-capable RPC(s) per chain`,
    );
    return;
  }
  log.warn(
    "[preflight] FAILED — scanning is disabled until each chain has >=%d " +
      "trace_filter RPC(s):\n%s\nUnlock a private trace RPC (dashboard Help → " +
      "Secrets, or `hexleague secret unlock`), or set ETH_RPC_URLS / PLS_RPC_URLS.",
    preflightState.min,
    formatPreflight(preflightState),
  );
}

/**
 * Headless startup: prompt on the CLI to (optionally) seal the generic + Moralis
 * RPC URLs and unlock the vault, so a browserless host can supply the private
 * trace endpoints the same way the dashboard's Secrets dialog would.
 * @param {object} lg
 */
async function headlessUnlock(lg) {
  if (!hasVault()) {
    const secrets = await collectRpcSecrets();
    if (Object.keys(secrets).length) {
      storeSecrets(secrets, await promptHidden("Set a vault passphrase: "));
      lg.info("[headless] sealed %d secret(s).", Object.keys(secrets).length);
    }
  }
  const pass = await promptHidden(
    "Vault passphrase to unlock (blank to skip): ",
  );
  if (!pass) return;
  try {
    lg.info(
      "[headless] unlocked: %s",
      unlockVault(pass).join(", ") || "(none)",
    );
  } catch (e) {
    lg.error("[headless] unlock failed: %s", e.message);
  }
}

/**
 * Read a size-capped JSON request body, resolving null on parse/transport error.
 * @param {import('http').IncomingMessage} req
 * @returns {Promise<object|null>}
 */
function readJsonBody(req) {
  return new Promise((resolve) => {
    let buf = "";
    req.on("data", (c) => {
      buf += c;
      if (buf.length > 65536) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(buf || "{}"));
      } catch {
        resolve(null);
      }
    });
    req.on("error", () => resolve(null));
  });
}

/**
 * Log a dashboard vault action for operator visibility — slot NAMES only, never
 * the passphrase or any secret value. `store`/`unlock` are narrated; `status`
 * (polled) is left quiet.
 * @param {object} cmd the request body
 * @param {object} reply the handler's reply
 */
function logVaultAction(cmd, reply) {
  if (cmd.action !== "store" && cmd.action !== "unlock") return;
  if (!reply.ok) {
    log.warn("[vault] %s (dashboard) failed: %s", cmd.action, reply.error);
    return;
  }
  if (cmd.action === "store") {
    const names = Array.isArray(reply.stored) ? reply.stored : [reply.stored];
    log.info(
      "[vault] sealed %d secret(s) (dashboard): %s",
      names.length,
      names.join(", "),
    );
  } else {
    log.info(
      "[vault] unlocked (dashboard): %s",
      (reply.unlocked || []).join(", ") || "(none)",
    );
  }
}

/**
 * POST /api/vault — the dashboard's local secrets channel (same origin as the
 * read-only UI, localhost-only). Seal a secret ({ action:"store", name, value,
 * passphrase }), unlock the vault into memory ({ action:"unlock", passphrase }),
 * or read status ({ action:"status" }). Mirrors the Unix-socket API.
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 */
async function handleVault(req, res) {
  if (req.method !== "POST") {
    return sendJson(res, 405, { error: "Use POST." });
  }
  const cmd = await readJsonBody(req);
  if (!cmd || typeof cmd.action !== "string") {
    return sendJson(res, 400, { error: "Expected a JSON { action, … } body." });
  }
  const reply = handleVaultCommand(cmd);
  logVaultAction(cmd, reply);
  if (reply.ok && cmd.action === "unlock") {
    reply.preflight = await refreshPreflight();
    logPreflight(); // show whether the new endpoints cleared the trace preflight
  }
  return sendJson(res, reply.ok ? 200 : 400, reply);
}

/**
 * GET /api/preflight — the current trace-capability verdict; the dashboard masks
 * the UI and gates scanning when it isn't ok.
 * @param {import('http').ServerResponse} res
 */
function handlePreflight(res) {
  sendJson(res, 200, preflightState);
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
  if (url.pathname === "/api/what-is-my-hex-staking-sea-creature") {
    return handleWhatIsMySeaCreature(url, res);
  }
  if (url.pathname === "/api/get-hex-staking-pool-sea-creature-data") {
    return handlePoolData(res);
  }
  if (url.pathname === "/api/status") return handleStatus(res);
  if (url.pathname === "/api/update/stop") return handleStop(req, res);
  if (url.pathname === "/api/update") return handleUpdate(req, res);
  if (url.pathname === "/api/disclaimer") return handleDisclaimer(res);
  if (url.pathname === "/api/openapi.json") return handleOpenapi(res);
  if (url.pathname === "/api/vault") return handleVault(req, res);
  if (url.pathname === "/api/preflight") return handlePreflight(res);
  // Browsers auto-request /favicon.ico at the root; map it to the icon set.
  if (url.pathname === "/favicon.ico") {
    return serveStatic("/images/favicons/favicon.ico", res);
  }
  return serveStatic(url.pathname, res);
}

/**
 * Log the effective config summary at startup (real facts only — never the
 * secret RPC URLs), noting the `.env` source + size when present, à la the
 * sibling lp-ranger tool's `[config] loadConfig:` line.
 */
function logConfigSummary() {
  const envPath = path.join(process.cwd(), ".env");
  let src = "no .env (defaults + env vars)";
  try {
    src = `.env ${envPath} (${fs.statSync(envPath).size} bytes)`;
  } catch {
    // no .env — running on built-in defaults + environment variables
  }
  log.info("[config] loadConfig: %s — %s", describeConfig(config), src);
}

/**
 * Start the dashboard server (after a trace-capability preflight).
 * @returns {Promise<import('http').Server>}
 */
async function start() {
  log.info(SERVER_STARTED);
  logConfigSummary();
  if (process.argv.includes("--headless") || process.env.HEADLESS === "1") {
    await headlessUnlock(log);
  }
  await refreshPreflight();
  logPreflight();
  const server = http.createServer(handleRequest);
  const pidFile = pidPath(config);
  const unlockSocket = startUnlockSocket(config.port, log);
  server.listen(config.port, config.host, () => {
    writePid(pidFile);
    log.info(
      "[hexleague server] dashboard: http://%s:%d (read-only)",
      config.host,
      config.port,
    );
  });
  const shutdown = () => {
    clearPid(pidFile);
    unlockSocket.close();
    fs.rmSync(unlockSocketPath(config.port), { force: true });
    process.exit(0);
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  return server;
}

if (require.main === module) {
  start().catch((err) => {
    log.error("[server] failed to start: %s", err.message);
    process.exit(1);
  });
}

module.exports = { start, handleRequest };
