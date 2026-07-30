/**
 * @file scripts/api-doc.js
 * @description Serves the Scalar API reference for docs/openapi.json at
 * http://127.0.0.1:5556 (npm run api-doc). Scalar is the modern, maintained
 * OpenAPI reference renderer; the bundle is self-hosted from node_modules
 * (no CDN). The full HTTP API is described so the app can be consumed as a
 * dependency by other applications.
 */

"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { log } = require("../src/log");

const PORT = 5556;
const HOST = "127.0.0.1";
const SPEC = path.join(__dirname, "..", "docs", "openapi.json");
const BROWSER_DIR = path.resolve(
  path.join(
    __dirname,
    "..",
    "node_modules",
    "@scalar",
    "api-reference",
    "dist",
    "browser",
  ),
);

const PAGE = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>HEX Sea-Creature League API</title>
  </head>
  <body>
    <script id="api-reference" data-url="/openapi.json"></script>
    <script src="/standalone.js"></script>
  </body>
</html>
`;

const MIME = {
  ".js": "text/javascript",
  ".css": "text/css",
  ".map": "application/json",
};

/**
 * Serve a file from the Scalar browser bundle directory (path-guarded).
 * @param {string} urlPath
 * @param {import('http').ServerResponse} res
 */
function serveBundle(urlPath, res) {
  const file = path.resolve(path.join(BROWSER_DIR, urlPath.replace(/^\//, "")));
  if (file !== BROWSER_DIR && !file.startsWith(BROWSER_DIR + path.sep)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const mime = MIME[path.extname(file)] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": mime });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const { pathname } = new URL(req.url, `http://${HOST}:${PORT}`);
  if (pathname === "/openapi.json") {
    res.writeHead(200, { "Content-Type": "application/json" });
    fs.createReadStream(SPEC).pipe(res);
    return;
  }
  if (pathname === "/" || pathname === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(PAGE);
    return;
  }
  serveBundle(pathname, res);
});

server.listen(PORT, HOST, () => {
  log.info("API reference: http://%s:%d", HOST, PORT);
});
