#!/usr/bin/env node

/**
 * @file bin/hexleague.js
 * @description CLI entry point. Dispatches to the verify / scan / oa / report /
 * whereami subcommands and prints a clean one-line error on failure.
 */

"use strict";

const { runCli } = require("../src/cli");
const { log } = require("../src/log");

runCli(process.argv.slice(2)).catch((err) => {
  log.error(err && err.message ? err.message : String(err));
  process.exit(1);
});
