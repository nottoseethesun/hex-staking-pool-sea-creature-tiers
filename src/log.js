/**
 * @file src/log.js
 * @description Thin, opt-in logging wrapper. It NEVER patches `console` or any
 * other global — every caller `require()`s this module explicitly and uses
 * `log.info` / `log.warn` / `log.error`. Centralizing output here gives a
 * single place to add structure later without touching call sites.
 *
 * Convention: log transaction hashes and addresses with a space after "="
 * (e.g. `log.info("deploy block= %s", n)`) so the value stays a single
 * double-click-copyable token in a terminal.
 */

"use strict";

/**
 * Emit an info-level line.
 * @param {...unknown} args console.info arguments (format string + values)
 */
function info(...args) {
  console.info(...args);
}

/**
 * Emit a warning-level line.
 * @param {...unknown} args console.warn arguments
 */
function warn(...args) {
  console.warn(...args);
}

/**
 * Emit an error-level line.
 * @param {...unknown} args console.error arguments
 */
function error(...args) {
  console.error(...args);
}

module.exports = { log: { info, warn, error } };
