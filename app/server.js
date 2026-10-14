import "../scripts/load-root-env.mjs";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(root, "dist");
const assets = path.resolve(root, "../assets");
const indexerRaw = process.env.INDEXER_URL || "http://127.0.0.1:4714";
const indexer = indexerRaw.startsWith("http://") || indexerRaw.startsWith("https://") ? indexerRaw : `http://${indexerRaw}`;
const port = Number(process.env.PORT || 4715);

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
  fs.createReadStream(target).pipe(res);
  return true;
}

function inside(parent, target) {
  return target === parent || target.startsWith(parent + path.sep);
}

http.createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  if (url.pathname.startsWith("/api/")) {
    const target = new URL(url.pathname.slice(4) + url.search, indexer.endsWith("/") ? indexer : `${indexer}/`);
    const proxy = http.request(target, { method: req.method, headers: req.headers }, (upstream) => {
      res.writeHead(upstream.statusCode || 502, upstream.headers);
      upstream.pipe(res);
    });
    proxy.on("error", () => {
      res.writeHead(502);
      res.end("indexer unavailable");
    });
    req.pipe(proxy);
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
  if (target.startsWith(dist) && file(res, target, types[path.extname(target)] || "application/octet-stream")) return;
  file(res, path.join(dist, "index.html"), "text/html");
}).listen(port, () => console.log(`horizon-zero :${port}`));
