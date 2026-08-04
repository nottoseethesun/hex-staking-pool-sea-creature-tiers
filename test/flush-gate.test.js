"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createFlushGate } = require("../src/cache/flush-gate");

test("flush gate fires once the item threshold is reached", () => {
  const g = createFlushGate({ everyItems: 3, everyMs: 999999, now: () => 0 });
  g.add();
  assert.equal(g.due(), false);
  g.add();
  assert.equal(g.due(), false);
  g.add();
  assert.equal(g.due(), true); // 3 items buffered
  assert.equal(g.pending(), 3);
  g.reset();
  assert.equal(g.due(), false);
  assert.equal(g.pending(), 0);
});

test("flush gate fires once the time threshold elapses", () => {
  let t = 0;
  const g = createFlushGate({ everyItems: 999, everyMs: 100, now: () => t });
  g.add();
  assert.equal(g.due(), false);
  t = 99;
  assert.equal(g.due(), false);
  t = 100;
  assert.equal(g.due(), true); // 100ms elapsed with something buffered
});

test("flush gate never fires when nothing is buffered", () => {
  let t = 0;
  const g = createFlushGate({ everyItems: 1, everyMs: 1, now: () => t });
  t = 100000;
  assert.equal(g.due(), false); // time passed but no units buffered
  g.add();
  assert.equal(g.due(), true);
});
