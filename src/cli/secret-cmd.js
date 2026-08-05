/**
 * @file src/cli/secret-cmd.js
 * @description `hexleague secret` — the CLI side of the local secrets vault.
 *   secret set-moralis         guided seal of generic + Moralis RPC URLs + key
 *   secret set [--name NAME]   seal a value (prompted, hidden) into the vault
 *   secret unlock              unlock the RUNNING dashboard's vault via its local
 *                              Unix socket (passphrase prompted, hidden)
 *   secret status              which secrets the running server has unlocked
 *   secret clear               delete the on-disk vault (back to first run)
 * Passphrases and values are read with the terminal echo muted and never logged.
 */

"use strict";

const { parseArgs } = require("node:util");
const { config } = require("../config");
const { log } = require("../log");
const { storeSecret, storeSecrets } = require("../secrets/service");
const { vaultPath, clearVault } = require("../secrets/store");
const { sendCommand } = require("../secrets/unlock-socket");
const { promptHidden } = require("../secrets/prompt");
const { collectRpcSecrets } = require("../secrets/moralis-setup");

/**
 * `secret set` — seal a value into the on-disk vault (local, no server needed).
 * @param {string} name
 */
async function doSet(name) {
  if (!name) {
    throw new Error(
      "secret set needs --name NAME (or use 'secret set-moralis').",
    );
  }
  const value = await promptHidden(`Value for '${name}' (hidden): `);
  const passphrase = await promptHidden("Vault passphrase: ");
  if (!value || !passphrase) {
    throw new Error("A value and a passphrase are both required.");
  }
  storeSecret(name, value, passphrase);
  log.info("Sealed '%s' into %s (encrypted).", name, vaultPath());
  log.info(
    "Run 'hexleague secret unlock' (or use the dashboard) to load it into a " +
      "running server.",
  );
}

/**
 * `secret unlock` / `secret status` — talk to the running server's socket.
 * @param {"unlock"|"status"} action
 */
async function talk(action) {
  const passphrase =
    action === "unlock" ? await promptHidden("Vault passphrase: ") : undefined;
  const reply = await sendCommand(config.port, { action, passphrase });
  if (!reply.ok) throw new Error(reply.error || `${action} failed`);
  const names = (reply.unlocked || []).join(", ") || "(none)";
  log.info("Unlocked in the running server: %s", names);
}

/**
 * `secret set-moralis` — guided seal of generic + Moralis RPC URLs (up to 3 per
 * chain each) plus the Moralis General API key.
 */
async function doSetMoralis() {
  const secrets = await collectRpcSecrets();
  if (!Object.keys(secrets).length) throw new Error("Nothing entered.");
  const passphrase = await promptHidden("Vault passphrase: ");
  if (!passphrase) throw new Error("A passphrase is required.");
  storeSecrets(secrets, passphrase);
  log.info(
    "Sealed %d secret(s) into %s.",
    Object.keys(secrets).length,
    vaultPath(),
  );
  log.info("Run 'hexleague secret unlock' (or the dashboard) to load them.");
}

/**
 * `secret clear` — delete the on-disk vault, returning to a first-run state. A
 * running dashboard keeps any already-unlocked secrets in memory, so stop it
 * first (or restart after) to see the first-run setup panel again.
 */
function doClear() {
  const cleared = clearVault();
  log.info(
    cleared ? "Cleared the vault at %s." : "No vault to clear at %s.",
    vaultPath(),
  );
  log.info(
    "To return to the first-run setup panel: npm stop (if running), then npm start.",
  );
}

/**
 * `hexleague secret set-moralis|set|unlock|status|clear`.
 * @param {string[]} argv
 */
async function secret(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { name: { type: "string" } },
  });
  const sub = positionals[0];
  if (sub === "set-moralis") return doSetMoralis();
  if (sub === "set") return doSet(values.name || positionals[1]);
  if (sub === "unlock") return talk("unlock");
  if (sub === "status") return talk("status");
  if (sub === "clear") return doClear();
  throw new Error(
    "Usage: hexleague secret set-moralis|set --name NAME|unlock|status|clear",
  );
}

module.exports = { secret };
