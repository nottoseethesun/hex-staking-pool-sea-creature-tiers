/**
 * @file src/log.js
 * @description Opt-in, timestamped, colorized logger. It NEVER patches `console`
 * or any other global — every caller `require()`s this module explicitly and uses
 * `log.info` / `log.warn` / `log.error`. Centralizing output here gives one place
 * for the cross-cutting concerns: a UTC timestamp injected right after the
 * `[tag]` prefix, and a per-functional-domain terminal color.
 *
 * Format
 * ──────
 * When the first argument is a string that starts with a `[tag]` prefix (possibly
 * preceded by ANSI color escapes), the timestamp is injected immediately AFTER
 * the tag, so the domain reads first:
 *
 *   log.info("[config] loadConfig: chains eth+pls")
 *   → [config] [2026-08-05 04:38:26] loadConfig: chains eth+pls
 *
 * When it doesn't start with `[`, the timestamp is prepended bare. Non-string
 * first args pass through untouched, and `printf`-style extra args are forwarded
 * as-is so `%s` / `%d` substitution still works.
 *
 * The style follows the sibling lp-ranger tool's logger (timestamp-after-tag +
 * tag colors + injectable sink), adapted to this project's functional domains.
 * Convention: log tx hashes and addresses with a space after "=" so the value
 * stays a single double-click-copyable token.
 */

"use strict";

/**
 * Format the current instant as `YYYY-MM-DD HH:MM:SS` in UTC.
 * @returns {string}
 */
function _utcTimestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
  );
}

/**
 * Skip any leading ANSI CSI escape sequences (`\x1b[<params>m`) so a
 * color-wrapped tag like `"\x1b[…m[hexleague server]\x1b[0m hi"` is treated as
 * starting with `[hexleague server]`, not with the escape's own `[`.
 * @param {string} s
 * @param {number} start
 * @returns {number} index of the first non-escape byte
 */
function _skipAnsi(s, start) {
  let i = start;
  while (s.startsWith("\x1b[", i)) {
    const m = s.indexOf("m", i + 2);
    if (m < 0) break;
    i = m + 1;
  }
  return i;
}

/**
 * Inject the timestamp after the first `[...]` prefix when the first arg is a
 * tagged string (possibly ANSI-prefixed); otherwise prepend a bare timestamp.
 * Bails on non-string first args and on a `[` with no `]` within 80 chars.
 * @param {unknown} first
 * @returns {unknown}
 */
function _withTimestamp(first) {
  if (typeof first !== "string") return first;
  const ts = _utcTimestamp();
  const tagStart = _skipAnsi(first, 0);
  if (first.charCodeAt(tagStart) !== 0x5b /* [ */) return `[${ts}] ${first}`;
  const closeIdx = first.indexOf("]", tagStart);
  if (closeIdx < 0 || closeIdx - tagStart > 80) return `[${ts}] ${first}`;
  return `${first.slice(0, closeIdx + 1)} [${ts}]${first.slice(closeIdx + 1)}`;
}

/**
 * ANSI truecolor table, keyed by functional-domain tag. Server/engine domain
 * tags are matched in full; stage tags carry a chain suffix (`[scan eth]`) so
 * they are matched by their open-prefix (`[scan`). Lines that don't begin with a
 * known tag pass through with ANSI untouched. Palette adapted from lp-ranger.
 */
const _COLORS = {
  "[hexleague server]": "\x1b[38;2;0;191;255m", // azure blue — server domain
  "[hexleague sync]": "\x1b[38;2;200;160;255m", // light purple — scan engine
  "[config]": "\x1b[38;2;232;228;201m", // dirty white
  "[preflight]": "\x1b[38;2;255;191;0m", // amber
  "[vault]": "\x1b[38;2;232;228;201m", // dirty white
  "[unlock]": "\x1b[38;2;211;211;211m", // light gray
  "[scan": "\x1b[38;2;124;252;0m", // lawn green — block scan (chain-suffixed)
  "[resolve": "\x1b[38;2;160;120;80m", // light brown
  "[oa": "\x1b[38;2;163;255;43m", // neon green — OA wallet scan
  "[report": "\x1b[38;2;225;217;209m", // dark white
  "[update": "\x1b[36m", // cyan — legacy update lines
};
const _RESET = "\x1b[0m";

/**
 * Apply the tag-prefix color, if the first arg is a string starting with a known
 * tag. Non-string args and unknown tags pass through untouched.
 * @param {unknown} first
 * @returns {unknown}
 */
function _colorize(first) {
  if (typeof first !== "string") return first;
  for (const [tag, color] of Object.entries(_COLORS)) {
    if (first.startsWith(tag)) return color + first + _RESET;
  }
  return first;
}

/**
 * Remove every ANSI CSI color escape (`\x1b[…m`) from a string — used when color
 * is disabled so even baked-in banners (whose color is in the literal) come out
 * clean. Fast-paths the common no-escape line. Uses no regex (avoids
 * `no-control-regex` and a literal control char in a pattern).
 * @param {string} s
 * @returns {string}
 */
function _stripAnsi(s) {
  if (s.indexOf("\x1b[") === -1) return s;
  let out = "";
  for (let i = 0; i < s.length;) {
    if (s.startsWith("\x1b[", i)) {
      const m = s.indexOf("m", i + 2);
      if (m >= 0) {
        i = m + 1;
        continue;
      }
    }
    out += s[i];
    i += 1;
  }
  return out;
}

/**
 * Decide whether to emit terminal colors: `NO_COLOR` (present, non-empty) forces
 * off; `FORCE_COLOR` (set, not "0") forces on — useful for a pager like
 * `less -R`; otherwise color only when stdout is a TTY, so a redirected file or
 * pipe stays plain. Evaluated once at load (a process's stdout doesn't change).
 * @returns {boolean}
 */
function _detectColor() {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== "0") return true;
  return Boolean(process.stdout && process.stdout.isTTY);
}

let _colorOn = _detectColor();

/**
 * Apply the current color policy to an already-timestamped value: colorize known
 * tags when color is on, else strip any ANSI so the output is plain. Non-strings
 * pass through.
 * @param {unknown} s
 * @returns {unknown}
 */
function _paint(s) {
  if (typeof s !== "string") return s;
  return _colorOn ? _colorize(s) : _stripAnsi(s);
}

/**
 * Output sink — the functions every `log.*` method ultimately calls. Defaults to
 * the live `console.*` methods; tests inject a fake sink via `_setSinkForTests`
 * to capture output WITHOUT monkey-patching the global `console`.
 */
let _sink = {
  log: (...a) => console.log(...a),
  warn: (...a) => console.warn(...a),
  error: (...a) => console.error(...a),
};

/**
 * Timestamped + colorized logger — use instead of `console.*` when you want
 * every line to carry a UTC timestamp and a tag-prefix color. Composition is
 * timestamp-then-colorize so the color wraps the timestamped string.
 */
const log = {
  info: (first, ...rest) => _sink.log(_paint(_withTimestamp(first)), ...rest),
  warn: (first, ...rest) => _sink.warn(_paint(_withTimestamp(first)), ...rest),
  error: (first, ...rest) =>
    _sink.error(_paint(_withTimestamp(first)), ...rest),
};

/**
 * Make a progress reporter that logs `<tag> <label> N%` each time the fraction
 * crosses a new `stepPct` boundary (default every 10%), so a headless operator
 * sees a long scan advance without a per-chunk flood. Pass a 0..1 fraction each
 * call; an optional `detail` string is appended for context. Emits at most
 * `100/stepPct` lines (10 by default), from `stepPct`% through 100%.
 * @param {string} tag e.g. "[scan eth]" — colorized like any other tag
 * @param {string} label e.g. "block scan"
 * @param {{ stepPct?: number, log?: object }} [opts] `log` overrides the sink
 *   (callers pass their injected `ctx.log`); `stepPct` the boundary size.
 * @returns {(frac: number, detail?: string) => void}
 */
function makeProgressLogger(tag, label, opts = {}) {
  const stepPct = opts.stepPct ?? 10;
  const out = opts.log ?? log;
  let last = 0; // highest bucket logged so far (0 = none)
  return (frac, detail) => {
    const pct = Math.max(0, Math.min(100, Math.floor(frac * 100)));
    const bucket = Math.floor(pct / stepPct);
    if (bucket <= last) return;
    last = bucket;
    if (detail) out.info(`${tag} ${label} %d%% — %s`, bucket * stepPct, detail);
    else out.info(`${tag} ${label} %d%%`, bucket * stepPct);
  };
}

/**
 * Replace the underlying output sink for tests. Returns a `restore` function that
 * puts the default `console.*`-backed sink back, so the global `console` is never
 * touched.
 * @param {{log?: Function, warn?: Function, error?: Function}} sink
 * @returns {() => void} restore function
 */
function _setSinkForTests(sink) {
  const prev = _sink;
  _sink = {
    log: sink.log || prev.log,
    warn: sink.warn || prev.warn,
    error: sink.error || prev.error,
  };
  return () => {
    _sink = prev;
  };
}

/**
 * Force the color policy on/off for tests (the real policy is TTY/env-derived and
 * would otherwise be non-deterministic under a piped test runner). Returns a
 * `restore` function.
 * @param {boolean} on
 * @returns {() => void} restore function
 */
function _setColorForTests(on) {
  const prev = _colorOn;
  _colorOn = on;
  return () => {
    _colorOn = prev;
  };
}

module.exports = {
  log,
  makeProgressLogger,
  _withTimestamp, // exported for tests
  _utcTimestamp, // exported for tests
  _colorize, // exported for tests
  _stripAnsi, // exported for tests
  _setSinkForTests,
  _setColorForTests,
};
