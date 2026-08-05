"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  log,
  makeProgressLogger,
  _withTimestamp,
  _colorize,
  _stripAnsi,
  _utcTimestamp,
  _setSinkForTests,
  _setColorForTests,
} = require("../src/log");

const TS = /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/;

test("_utcTimestamp formats as YYYY-MM-DD HH:MM:SS", () => {
  assert.match(_utcTimestamp(), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
});

test("_withTimestamp injects after the tag, prepends when untagged, skips ANSI", () => {
  assert.match(_withTimestamp("[config] hi"), /^\[config\] \[.+\] hi$/);
  assert.match(_withTimestamp("plain"), /^\[.+\] plain$/);
  assert.equal(_withTimestamp(42), 42); // non-string passes through
  // A color-wrapped tag: the timestamp lands after [unlock], not the escape.
  assert.match(
    _withTimestamp("\x1b[36m[unlock]\x1b[0m ready"),
    /\[unlock\] \[/,
  );
});

test("_colorize wraps a known tag and leaves unknown tags/non-strings alone", () => {
  const c = _colorize("[scan eth] go");
  assert.ok(c.startsWith("\x1b[38;2;124;252;0m") && c.endsWith("\x1b[0m"));
  assert.equal(_colorize("[mystery] x"), "[mystery] x");
  assert.equal(_colorize(99), 99);
});

test("log.* route through the sink with timestamp + color; args forwarded", () => {
  const seen = { log: [], warn: [], error: [] };
  const restore = _setSinkForTests({
    log: (...a) => seen.log.push(a),
    warn: (...a) => seen.warn.push(a),
    error: (...a) => seen.error.push(a),
  });
  const restoreColor = _setColorForTests(true); // deterministic under any runner
  try {
    log.info("[oa eth] scanning %d", 5);
    log.warn("[preflight] low");
    log.error("[vault] boom");
  } finally {
    restoreColor();
    restore();
  }
  const first = seen.log[0][0];
  assert.match(
    first,
    new RegExp(`\\[oa eth\\] \\[${TS.source}\\] scanning %d`),
  );
  assert.ok(first.startsWith("\x1b[38;2;163;255;43m")); // neon green for [oa
  assert.equal(seen.log[0][1], 5); // %d substitution arg forwarded intact
  assert.equal(seen.warn.length, 1);
  assert.equal(seen.error.length, 1);
});

test("_stripAnsi removes escapes; color-off output is plain (banners too)", () => {
  assert.equal(_stripAnsi("plain line"), "plain line"); // fast path, no escapes
  assert.equal(_stripAnsi("\x1b[36m[unlock]\x1b[0m ready"), "[unlock] ready");
  const seen = [];
  const restoreSink = _setSinkForTests({ log: (...a) => seen.push(a) });
  const restoreColor = _setColorForTests(false);
  try {
    log.info("[config] hi");
    // A baked-color banner still comes out clean when color is disabled.
    log.info("\x1b[38;2;0;191;255;48;2;25;25;25m[hexleague server] up\x1b[0m");
  } finally {
    restoreColor();
    restoreSink();
  }
  assert.ok(!seen[0][0].includes("\x1b["), "no ANSI when color off");
  assert.match(seen[0][0], new RegExp(`^\\[config\\] \\[${TS.source}\\] hi$`));
  assert.ok(!seen[1][0].includes("\x1b["), "banner ANSI stripped");
  assert.match(
    seen[1][0],
    new RegExp(`^\\[hexleague server\\] \\[${TS.source}\\] up$`),
  );
});

test("makeProgressLogger logs once per 10% boundary, with optional detail", () => {
  const lines = [];
  const p = makeProgressLogger("[scan eth]", "block scan", {
    log: { info: (...a) => lines.push(a) },
  });
  p(0.05); // 5% — below the first boundary, no line
  p(0.1); // 10%
  p(0.14); // same bucket, no line
  p(0.2, "block 5/10"); // 20% with detail
  p(1.0); // 100% (a big jump logs once, at the new bucket)
  assert.equal(lines.length, 3);
  assert.deepEqual(
    lines.map((l) => l[1]),
    [10, 20, 100],
  );
  assert.match(lines[0][0], /\[scan eth\] block scan %d%%$/); // no detail
  assert.match(lines[1][0], /%d%% — %s$/); // detail variant
  assert.equal(lines[1][2], "block 5/10");
});
