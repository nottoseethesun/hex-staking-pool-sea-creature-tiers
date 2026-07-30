/**
 * @file src/cli/whereami-cmd.js
 * @description `whereami` subcommand — locates a staker in all three views by
 * one or more --address flags (summed) or a raw --tshares figure. Reads
 * out/summary.json; errors clearly if `report` has not been run.
 */

"use strict";

const path = require("path");
const { parseArgs } = require("node:util");
const { log } = require("../log");
const { locate } = require("../whereami");
const { readJson, OUT_DIR } = require("../cache/store");
const { DISCLAIMER_SHORT } = require("../disclaimer");

const VIEW_TITLES = {
  eth: "Ethereum",
  pls: "PulseChain",
  combined: "Combined",
};

/**
 * Print one view's location result.
 * @param {string} name view key
 * @param {object} r result
 */
function printView(name, r) {
  log.info("");
  log.info("== %s ==", VIEW_TITLES[name]);
  if (r.input === "address") {
    if (r.oaHits.length > 0) {
      log.info("  OA cluster: %s (excluded from ranking)", r.oaHits.join(", "));
    }
    if (r.missing.length > 0) {
      log.info("  no active stake found for: %s", r.missing.join(", "));
    }
  }
  log.info("  T-Shares: %s", r.tshares);
  log.info("  Tier: %s %s", r.league.emoji, r.league.name);
  log.info("  Rank: %d of %d non-OA stakers", r.rank, r.nonOaStakerCount);
  log.info("  Percentile: %s%%", r.percentile);
  if (r.nextTier) {
    log.info(
      "  To reach %s %s: +%s T-Shares",
      r.nextTier.emoji,
      r.nextTier.name,
      r.distanceToNextTier,
    );
  } else {
    log.info("  Already in the top tier.");
  }
}

/**
 * `whereami` entry point.
 * @param {string[]} argv
 * @returns {Promise<void>}
 */
async function whereami(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      address: { type: "string", multiple: true },
      tshares: { type: "string" },
    },
  });
  const summary = readJson(path.join(OUT_DIR, "summary.json"), null);
  if (!summary) {
    throw new Error("No out/summary.json — run 'hexleague report' first.");
  }
  const hasAddr = values.address && values.address.length > 0;
  if (values.tshares === undefined && !hasAddr) {
    throw new Error("whereami needs --address 0x… (repeatable) or --tshares N");
  }
  const query =
    values.tshares !== undefined
      ? { tshares: values.tshares }
      : { addresses: values.address };
  const out = locate(summary, query);
  for (const name of ["eth", "pls", "combined"]) {
    printView(name, out.results[name]);
  }
  log.info("");
  log.info(DISCLAIMER_SHORT);
  return Promise.resolve();
}

module.exports = { whereami };
