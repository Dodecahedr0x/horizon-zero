import "../scripts/load-root-env.mjs";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { handleChain, REQUIRED_ENV } from "./chain/http.mjs";

// The /chain backend falls back to the local stack, which a deployment never wants.
const main = import.meta.url === pathToFileURL(process.argv[1] || "").href;
const missing = REQUIRED_ENV.filter((name) => !process.env[name]);
if (main && missing.length && (process.env.RENDER || process.env.NODE_ENV === "production")) {
  console.error(`horizon-zero: set ${missing.join(", ")} before starting the game server`);
  process.exit(1);
}

const root = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(root, "dist");
const assets = path.resolve(root, "../assets");
const indexerRaw = process.env.INDEXER_URL || "http://127.0.0.1:4714";
const indexer = new URL(indexerRaw.startsWith("http://") || indexerRaw.startsWith("https://") ? indexerRaw : `http://${indexerRaw}`);
const port = Number(process.env.PORT || 4715);
// What /api passes on from the indexer. Its CORS header lets the landing page read /api/stats.
const PROXIED_HEADERS = ["content-type", "content-length", "cache-control", "access-control-allow-origin", "etag", "last-modified"];
const PROXY_TIMEOUT_MS = 10_000;

// Landing dev is 4711 and preview is 4716. Those ports stay clear of the game Vite server (4710), the asset studio (4712), the local ledger (4713), and the indexer (4714).
const LOCAL_ASSET_ORIGINS = [
  "http://127.0.0.1:4711",
  "http://localhost:4711",
  "http://127.0.0.1:4716",
  "http://localhost:4716",
];

const types = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".glb": "model/gltf-binary",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".wasm": "application/wasm",
};

function assetAllowlist() {
  const configured = String(process.env.ASSET_CORS_ORIGINS || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return configured.length ? configured : LOCAL_ASSET_ORIGINS;
}

function assetCorsHeaders(req) {
  const origin = req.headers.origin;
  if (!origin || !assetAllowlist().includes(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    Vary: "Origin",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  };
}

function file(res, target, type, extra = {}) {
  if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) return false;
  res.writeHead(200, { "Content-Type": type, ...extra });
  fs.createReadStream(target).on("error", () => res.destroy()).pipe(res);
  return true;
}

function inside(parent, target) {
  return target === parent || target.startsWith(parent + path.sep);
}

/**
 * `/api/<path>` on the indexer, GET and HEAD only. The path is set on a copy of the indexer URL, so
 * no request (`/api//evil.example/x`, a backslash, an encoded slash) can point it at another host.
 * Only `accept` goes up and only `PROXIED_HEADERS` come back, the body is JSON or plain text, and
 * `nosniff` keeps a browser from reading it as anything else.
 */
export function proxyApi(req, res, url, base = indexer) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { Allow: "GET, HEAD" });
    res.end();
    return;
  }
  const rest = url.pathname.slice("/api".length);
  if (!rest.startsWith("/") || rest.startsWith("//") || /\\|%2f|%5c/i.test(rest)) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("bad path");
    return;
  }
  const target = new URL(base.href);
  target.pathname = base.pathname.replace(/\/$/, "") + rest;
  target.search = url.search;
  if (target.origin !== base.origin) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("bad path");
    return;
  }
  const client = target.protocol === "https:" ? https : http;
  const headers = req.headers.accept ? { accept: req.headers.accept } : {};
  const proxy = client.request(target, { method: req.method, headers, timeout: PROXY_TIMEOUT_MS }, (upstream) => {
    const out = { "X-Content-Type-Options": "nosniff" };
    for (const name of PROXIED_HEADERS) if (upstream.headers[name] !== undefined) out[name] = upstream.headers[name];
    const type = String(upstream.headers["content-type"] || "");
    out["content-type"] = /^application\/json\b/i.test(type) ? type : "text/plain; charset=utf-8";
    res.writeHead(upstream.statusCode || 502, out);
    upstream.pipe(res);
  });
  proxy.on("timeout", () => proxy.destroy(new Error("indexer timed out")));
  proxy.on("error", () => {
    if (!res.headersSent) res.writeHead(502, { "Content-Type": "text/plain" });
    res.end("indexer unavailable");
  });
  proxy.end();
}

export function handle(req, res) {
  // `//` or `//[` does not parse as a path on this base; it is a bad request, not a crash.
  let url;
  try {
    url = new URL(req.url, "http://127.0.0.1");
  } catch {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("bad path");
    return;
  }
  if (url.pathname.startsWith("/chain/")) {
    handleChain(req, res, url.pathname.slice("/chain".length)).catch((err) => {
      console.error("chain call failed", err);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
    return;
  }
  if (url.pathname.startsWith("/api/")) {
    proxyApi(req, res, url);
    return;
  }
  if (url.pathname.startsWith("/assets/")) {
    const headers = assetCorsHeaders(req);
    if (req.method === "OPTIONS") {
      res.writeHead(204, headers);
      res.end();
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { ...headers, Allow: "GET, HEAD, OPTIONS" });
      res.end();
      return;
    }
    let rel = "";
    try {
      rel = decodeURIComponent(url.pathname.slice("/assets/".length));
    } catch {
      res.writeHead(400, headers);
      res.end("bad path");
      return;
    }
    const target = path.resolve(assets, rel);
    const type = types[path.extname(target)] || "application/octet-stream";
    if (inside(assets, target) && file(res, target, type, headers)) return;
    res.writeHead(404, headers);
    res.end("not found");
    return;
  }
  const relative = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  const target = path.resolve(dist, relative);
  if (inside(dist, target) && file(res, target, types[path.extname(target)] || "application/octet-stream")) return;
  file(res, path.join(dist, "index.html"), "text/html");
}

function safely(req, res) {
  try {
    handle(req, res);
  } catch (err) {
    console.error("request failed", err);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
}

if (main) http.createServer(safely).listen(port, () => console.log(`horizon-zero :${port}`));
