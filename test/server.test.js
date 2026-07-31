"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { handleRequest } = require("../server");

/**
 * Drive one request through the router with mock req/res, resolving once the
 * response ends. Works for both the synchronous JSON handlers and the async
 * static-file path (both call res.end).
 * @param {string} pathname
 * @param {string} [method]
 * @returns {Promise<object>} the resolved mock response
 */
function invoke(pathname, method = "GET") {
  return new Promise((resolve) => {
    const req = { url: pathname, method, headers: { host: "localhost" } };
    const res = {
      statusCode: 0,
      headers: {},
      body: "",
      writeHead(code, headers) {
        this.statusCode = code;
        if (headers) this.headers = headers;
      },
      end(data) {
        if (data) this.body += String(data);
        resolve(this);
      },
    };
    handleRequest(req, res);
  });
}

test("index.html is served no-store (entry point never goes stale)", async () => {
  const res = await invoke("/");
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["Cache-Control"], "no-store");
  assert.match(res.headers["Content-Type"], /text\/html/);
});

test("dashboard JS is no-cache, not long max-age (regression)", async () => {
  const res = await invoke("/dashboard-help.js");
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["Cache-Control"], "no-cache");
  assert.match(res.headers["Content-Type"], /javascript/);
});

test("CSS is served no-cache", async () => {
  const res = await invoke("/style.css");
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["Cache-Control"], "no-cache");
});

test("root /favicon.ico maps to the icon set", async () => {
  const res = await invoke("/favicon.ico");
  assert.equal(res.statusCode, 200);
});

test("an unknown static file returns 404", async () => {
  const res = await invoke("/nope-not-here.js");
  assert.equal(res.statusCode, 404);
});

test("GET /api/health reports liveness", async () => {
  const res = await invoke("/api/health");
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["Cache-Control"], "no-store");
  assert.equal(JSON.parse(res.body).ok, true);
});

test("GET /api/disclaimer returns the canonical text", async () => {
  const res = await invoke("/api/disclaimer");
  assert.equal(res.statusCode, 200);
  assert.ok(JSON.parse(res.body).disclaimer.length > 0);
});

test("GET /api/status always answers with an updating flag", async () => {
  const res = await invoke("/api/status");
  assert.equal(res.statusCode, 200);
  assert.equal(typeof JSON.parse(res.body).updating, "boolean");
});

test("summary + whereami answer 200 or a 404 no-report error", async () => {
  for (const p of ["/api/summary", "/api/whereami?tshares=42"]) {
    const res = await invoke(p);
    assert.ok([200, 404].includes(res.statusCode));
    if (res.statusCode === 404) assert.ok(JSON.parse(res.body).error);
  }
});

test("GET /api/openapi.json answers 200 or 404", async () => {
  const res = await invoke("/api/openapi.json");
  assert.ok([200, 404].includes(res.statusCode));
});

test("/api/update requires POST (GET -> 405)", async () => {
  const res = await invoke("/api/update", "GET");
  assert.equal(res.statusCode, 405);
});

test("/api/update/stop requires POST (GET -> 405)", async () => {
  const res = await invoke("/api/update/stop", "GET");
  assert.equal(res.statusCode, 405);
});

test("/api/update/stop with no scan running answers 409", async () => {
  const res = await invoke("/api/update/stop", "POST");
  assert.equal(res.statusCode, 409);
  assert.match(JSON.parse(res.body).error, /No scan is running/);
});
