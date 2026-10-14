// `cargo run` rebuilds the debug binary when sources changed and otherwise
// uses the cached binary under target/. The child stays in this process group
// so Ctrl+C from `pnpm dev:all` kills Cargo and the indexer together.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { indexerListenPort } from "./indexer-port.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const child = spawn("cargo", ["run", "--quiet"], {
  cwd: path.join(root, "indexer"),
  stdio: "inherit",
  env: { ...process.env, INDEXER_PORT: indexerListenPort() },
});

child.on("error", (err) => {
  process.stderr.write(`${err.message}\n`);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
