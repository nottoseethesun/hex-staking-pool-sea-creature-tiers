"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  tshares,
  groupThousands,
  tsharesGrouped,
  formatPercent,
} = require("../src/report/format");

const T = 10n ** 12n;

test("tshares formats raw shares to 3 decimals", () => {
  assert.equal(tshares(T), "1.000");
  assert.equal(tshares(5n * T), "5.000");
  assert.equal(tshares(T / 2n), "0.500");
});

test("tshares rounds half up", () => {
  assert.equal(tshares((12345n * T) / 10000n), "1.235");
  assert.equal(tshares((12344n * T) / 10000n), "1.234");
});

test("tshares honors a custom decimal count", () => {
  assert.equal(tshares(T, 0), "1");
  assert.equal(tshares((3n * T) / 2n, 1), "1.5");
});

test("groupThousands inserts separators", () => {
  assert.equal(groupThousands("1234567"), "1,234,567");
  assert.equal(groupThousands("100"), "100");
  assert.equal(groupThousands("1000"), "1,000");
});

test("tsharesGrouped groups the integer part only", () => {
  assert.equal(tsharesGrouped(1234567n * T), "1,234,567.000");
});

test("formatPercent computes num/den*100, half up", () => {
  assert.equal(formatPercent(1n, 10n, 2), "10.00");
  assert.equal(formatPercent(1n, 100n, 2), "1.00");
  assert.equal(formatPercent(1n, 3n, 4), "33.3333");
});

test("formatPercent guards divide-by-zero", () => {
  assert.equal(formatPercent(0n, 0n, 2), "0.00");
  assert.equal(formatPercent(5n, 0n, 0), "0");
});
