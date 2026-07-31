/**
 * @file scripts/show-api-doc.js
 * @description `npm run show-api-doc` — a convenience launcher on top of
 * `npm run api-doc`: it starts the API-reference server (scripts/api-doc.js,
 * http://127.0.0.1:5556) only if it is not already listening, then opens the
 * page in the default browser. The reference renders docs/openapi.json live, so
 * there is no separate build step — it is always current.
 */

"use strict";

const net = require("net");
const path = require("path");
const { spawn } = require("child_process");
const { log } = require("../src/log");

// Mirrors scripts/api-doc.js (kept in lock-step).
const PORT = 5556;
const HOST = "127.0.0.1";
const DOC_URL = `http://${HOST}:${PORT}`;
const API_DOC_SCRIPT = path.join(__dirname, "api-doc.js");

/**
 * Resolve true if something already accepts connections on the doc server.
 * @returns {Promise<boolean>}
 */
function isServerUp() {
  return new Promise((resolve) => {
    const socket = net.connect(PORT, HOST);
    const finish = (up) => {
      socket.destroy();
      resolve(up);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(1000, () => finish(false));
  });
}

/**
 * Poll until the server accepts connections, or give up.
 * @param {number} [tries]
 * @returns {Promise<boolean>}
 */
async function waitForServer(tries = 40) {
  for (let i = 0; i < tries; i += 1) {
    if (await isServerUp()) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

/**
 * The platform's "open a URL in the default browser" command.
 * @param {string} url
 * @returns {[string, string[]]} [command, args]
 */
function browserCommand(url) {
  if (process.platform === "darwin") return ["open", [url]];
  if (process.platform === "win32") return ["cmd", ["/c", "start", "", url]];
  return ["xdg-open", [url]];
}

/**
 * Open a URL in the default browser (best-effort; a no-op when headless).
 * @param {string} url
 */
function openBrowser(url) {
  const [cmd, args] = browserCommand(url);
  const child = spawn(cmd, args, { stdio: "ignore", detached: true });
  // Headless or missing opener: swallow the async 'error' (no listener would
  // otherwise throw). The URL is logged by the caller regardless.
  child.on("error", () => {});
  child.unref();
}

/** Start the server if needed, then open the reference. */
async function main() {
  if (await isServerUp()) {
    log.info("API-doc server already running.");
  } else {
    log.info("Starting API-doc server…");
    const child = spawn("node", [API_DOC_SCRIPT], {
      stdio: "ignore",
      detached: true,
    });
    child.on("error", () => {}); // failure surfaces via waitForServer below
    child.unref();
    if (!(await waitForServer())) {
      log.error("API-doc server did not come up on %s", DOC_URL);
      process.exit(1);
    }
  }
  openBrowser(DOC_URL);
  log.info("API reference: %s", DOC_URL);
}

main().catch((err) => {
  log.error(err.message);
  process.exit(1);
});
