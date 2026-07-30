/**
 * @file src/cli/seed-cmd.js
 * @description `seed` subcommand — populate data/ from a checksum-verified
 * snapshot tarball so a fresh install can skip the cold scan. Both --url and
 * --sha256 are required; extraction only happens if the digest matches.
 */

"use strict";

const { parseArgs } = require("node:util");
const { log } = require("../log");
const { seed: runSeed } = require("../seed");

/**
 * `seed` entry point.
 * @param {string[]} argv
 * @returns {Promise<void>}
 */
async function seed(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      url: { type: "string" },
      sha256: { type: "string" },
      force: { type: "boolean", default: false },
    },
  });
  await runSeed({
    url: values.url,
    sha256: values.sha256,
    force: values.force,
    log,
  });
}

module.exports = { seed };
