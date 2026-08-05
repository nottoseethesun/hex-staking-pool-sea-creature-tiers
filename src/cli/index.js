/**
 * @file src/cli/index.js
 * @description CLI dispatch. Maps subcommands to handlers (each parses its own
 * flags with node:util parseArgs) and prints usage.
 */

"use strict";

const { verify } = require("./verify");
const { scan } = require("./scan-cmd");
const { resolve } = require("./resolve-cmd");
const { oa } = require("./oa-cmd");
const { report } = require("./report-cmd");
const { update } = require("./update-cmd");
const { whereami } = require("./whereami-cmd");
const { seed } = require("./seed-cmd");
const { stop } = require("./stop-cmd");
const { secret } = require("./secret-cmd");
const { log } = require("../log");

const COMMANDS = {
  verify,
  scan,
  resolve,
  oa,
  report,
  update,
  stop,
  whereami,
  seed,
  secret,
};

const HELP = `hexleague — HEX sea-creature league analysis (read-only)

Usage:
  hexleague verify   [--chain eth|pls]     chainId, deploy block, ABI sanity
  hexleague scan     --chain eth|pls       stake events -> data/<chain>/
  hexleague resolve  --chain eth|pls       HSI + $MAXI resolution -> data/<chain>/
  hexleague oa       --chain eth|pls       OA funding cluster -> data/<chain>/
  hexleague report   [--offline]           reads data/, writes out/
  hexleague update   [--rebuild]           scan + resolve + oa + report, both chains
  hexleague stop                           stop a running dashboard scan
  hexleague seed     --url U --sha256 H    seed data/ from a verified snapshot
  hexleague secret   set-moralis|unlock    local encrypted vault (Moralis RPC etc.)
  hexleague whereami --address 0x… [--address 0x…] | --tshares N

Flags:
  --chain eth|pls   scan/resolve/oa require it; verify checks both if omitted.
  --rebuild         scan/resolve/oa/update: discard cached results, recompute.
  --offline         report: build from cache only, no RPC tip read.
  --force           seed: overwrite a non-empty data/ directory.

Run 'hexleague update' for the whole pipeline (or scan/resolve/oa/report
individually),
then whereami or the dashboard (npm start). Data is cached under data/; re-runs
top up incrementally.`;

/** Print CLI usage. */
function printHelp() {
  log.info(HELP);
}

/**
 * Run the CLI for a given argv (without node + script).
 * @param {string[]} argv
 * @returns {Promise<void>}
 */
async function runCli(argv) {
  const command = argv[0];
  if (!command || ["--help", "-h", "help"].includes(command)) {
    printHelp();
    return;
  }
  if (!Object.hasOwn(COMMANDS, command)) {
    throw new Error(`Unknown command '${command}'. Run 'hexleague --help'.`);
  }
  await COMMANDS[command](argv.slice(1));
}

module.exports = { runCli, printHelp };
