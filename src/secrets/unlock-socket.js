/**
 * @file src/secrets/unlock-socket.js
 * @description The "local, non-HTTP" unlock API: a Unix-domain-socket server the
 * dashboard process listens on (owner-only, mode 0600), so a local CLI can seal a
 * secret or unlock the vault into the RUNNING server's in-memory holder without
 * going over HTTP. One newline-terminated JSON command per connection:
 *   { action: "unlock", passphrase }              -> decrypt the vault into memory
 *   { action: "store", name, value, passphrase }  -> seal a secret at rest
 *   { action: "status" }                          -> { unlocked: string[] }
 * It replies with a single JSON line and closes. The passphrase never leaves the
 * machine and is never logged.
 */

"use strict";

const net = require("net");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { unlockVault, storeSecret, storeSecrets } = require("./service");
const { hasVault } = require("./store");
const holder = require("./holder");

/**
 * The unlock socket path for a port (keyed like the server PID file).
 * @param {number} port
 * @returns {string}
 */
function socketPath(port) {
  return path.join(os.tmpdir(), `hexleague-unlock-${port}.sock`);
}

/**
 * Execute one decoded command, returning a JSON-safe reply. `opts` (the vault
 * file) is injectable for tests; production uses the default vault.
 * @param {object} cmd
 * @param {{ file?: string, iterations?: number }} [opts]
 * @returns {object}
 */
function handleCommand(cmd, opts) {
  try {
    if (cmd.action === "unlock") {
      return { ok: true, unlocked: unlockVault(cmd.passphrase, opts) };
    }
    if (cmd.action === "store") {
      if (cmd.secrets) {
        return {
          ok: true,
          stored: storeSecrets(cmd.secrets, cmd.passphrase, opts),
        };
      }
      storeSecret(cmd.name, cmd.value, cmd.passphrase, opts);
      return { ok: true, stored: cmd.name };
    }
    if (cmd.action === "status") {
      return {
        ok: true,
        hasVault: hasVault(opts && opts.file),
        unlocked: holder.names(),
      };
    }
    return { ok: false, error: `unknown action '${cmd.action}'` };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Narrate a handled socket command for operator visibility — the action + the
 * affected slot NAMES only (never the passphrase or any secret value). `status`
 * (polled) is left quiet.
 * @param {object} log
 * @param {string} action
 * @param {object} reply
 */
function logSocketAction(log, action, reply) {
  if (action !== "unlock" && action !== "store") return;
  if (!reply.ok)
    return log.warn("[unlock] socket %s failed: %s", action, reply.error);
  const names =
    action === "unlock" ? reply.unlocked || [] : [].concat(reply.stored || []);
  return log.info(
    "[unlock] socket %s: %s",
    action,
    names.join(", ") || "(none)",
  );
}

/**
 * Start the unlock socket server. Best-effort: on any socket error it logs and
 * returns, so the dashboard still serves read-only if the socket can't be made.
 * @param {number} port
 * @param {object} log
 * @param {{ handle?: Function }} [deps] injectable handler for tests
 * @returns {import('net').Server}
 */
function startUnlockSocket(port, log, deps = {}) {
  const handle = deps.handle ?? handleCommand;
  const file = socketPath(port);
  fs.rmSync(file, { force: true });
  const server = net.createServer((conn) => {
    let buf = "";
    conn.on("data", (d) => {
      buf += d.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      let reply;
      let action = "?";
      try {
        const cmd = JSON.parse(buf.slice(0, nl));
        action = cmd.action;
        reply = handle(cmd);
      } catch {
        reply = { ok: false, error: "bad request" };
      }
      logSocketAction(log, action, reply);
      conn.end(`${JSON.stringify(reply)}\n`);
    });
    conn.on("error", () => {});
  });
  server.on("error", (e) =>
    log.warn("[unlock] socket unavailable: %s", e.message),
  );
  server.listen(file, () => {
    fs.chmodSync(file, 0o600);
    log.info("[unlock] local unlock socket ready: %s", file);
  });
  return server;
}

/**
 * Send one command to the unlock socket and resolve its JSON reply (CLI side).
 * @param {number} port
 * @param {object} cmd
 * @returns {Promise<object>}
 */
function sendCommand(port, cmd) {
  return new Promise((resolve, reject) => {
    const conn = net.connect(socketPath(port));
    let buf = "";
    conn.on("connect", () => conn.write(`${JSON.stringify(cmd)}\n`));
    conn.on("data", (d) => (buf += d.toString("utf8")));
    conn.on("end", () => {
      try {
        resolve(JSON.parse(buf));
      } catch {
        reject(new Error("no reply from the unlock socket"));
      }
    });
    conn.on("error", (e) =>
      reject(new Error(`unlock socket unreachable (${e.code || e.message})`)),
    );
  });
}

module.exports = { socketPath, handleCommand, startUnlockSocket, sendCommand };
