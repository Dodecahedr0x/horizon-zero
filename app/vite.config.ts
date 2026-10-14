import react from "@vitejs/plugin-react";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const root = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(root, "..");
const assets = path.resolve(repoRoot, "assets");
const devHost = process.env.HORIZON_VITE_HOST;
const ledgerPort = process.env.LOCAL_LEDGER_PORT || "4713";
const indexerRaw = process.env.INDEXER_URL || "http://127.0.0.1:4714";
const indexer = /^https?:\/\//.test(indexerRaw) ? indexerRaw : `http://${indexerRaw}`;
// The no-wallet game keeps its world in the local ledger, so the landing page's stats come from there.
const devMode = process.env.VITE_DEV_MODE === "true";

export default defineConfig({
  envDir: repoRoot,
  clearScreen: process.env.HORIZON_VITE_CLEAR_SCREEN !== "0",
  plugins: [
    react(),
    {
      name: "horizon-assets",
      configureServer(server) {
        server.middlewares.use("/assets", (req, res, next) => {
          const origin = req.headers.origin;
          if (typeof origin === "string" && origin) {
            res.setHeader("Access-Control-Allow-Origin", origin);
            res.setHeader("Vary", "Origin");
            res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
          }
          if (req.method === "OPTIONS") {
            res.statusCode = 204;
            res.end();
            return;
          }
          const file = path.resolve(assets, decodeURIComponent((req.url || "/").split("?")[0].slice(1)));
          if (!file.startsWith(assets) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return next();
          res.setHeader("Content-Type", file.endsWith(".glb") ? "model/gltf-binary" : "application/octet-stream");
          fs.createReadStream(file).pipe(res);
        });
      },
    },
  ],
  server: {
    port: 4710,
    strictPort: process.env.HORIZON_VITE_STRICT_PORT === "1",
    ...(devHost ? { host: devHost } : {}),
    // The production server (app/server.js) sends /api/* to the indexer; this does the same in dev.
    // Keys are matched in order, so the specific prefixes come first.
    proxy: {
      "/api/local": {
        target: `http://127.0.0.1:${ledgerPort}`,
      },
      "/api/stats": devMode
        ? { target: `http://127.0.0.1:${ledgerPort}`, rewrite: () => "/api/local/stats" }
        : { target: indexer, changeOrigin: true, rewrite: (url) => url.replace(/^\/api/, "") },
      "/api": {
        target: indexer,
        changeOrigin: true,
        rewrite: (url) => url.replace(/^\/api/, ""),
      },
    },
  },
  resolve: { alias: { buffer: "buffer" } },
});
