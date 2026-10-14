import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Dev is 4711 and preview is 4716 so this site does not take the game Vite port (4710) or the asset studio port (4712).
export default defineConfig({
  envDir: repoRoot,
  server: { host: "127.0.0.1", port: 4711, strictPort: true },
  preview: { host: "127.0.0.1", port: 4716, strictPort: true },
});
