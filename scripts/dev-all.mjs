// One foreground process for local dev. Each child is its own process group so
// SIGINT and SIGTERM reach pnpm and npm grandchildren, not only the direct child.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { indexerListenPort } from "./indexer-port.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// --chain plays against the local Solana + ephemeral rollup stack (scripts/local-stack.mjs) with a
// wallet, instead of the no-wallet local ledger.
const chain = process.argv.includes("--chain");

const jobs = [
  {
    name: "game",
    command: "pnpm",
    args: ["--filter", "app", "dev"],
    env: {
      HORIZON_VITE_HOST: "127.0.0.1",
      HORIZON_VITE_STRICT_PORT: "1",
      HORIZON_VITE_CLEAR_SCREEN: "0",
      VITE_DEV_MODE: chain ? "false" : "true",
      // Solana, the rollup, and the ephemeral test queue whose oracle the stack runs on the rollup.
      ...(chain
        ? {
            VITE_RPC_URL: "http://127.0.0.1:8899",
            VITE_ER_RPC_URL: "http://127.0.0.1:7799",
            VITE_ORACLE_QUEUE: "Sc9MJUngNbQXSXGP3F67KvKwVnhaYn6kcioxXNVowYT",
          }
        : {}),
    },
  },
  {
    name: "landing",
    command: "npm",
    args: ["run", "dev", "--prefix", "landing", "--", "--clearScreen", "false"],
    env: { VITE_WEB_ORIGIN: "http://127.0.0.1:4710" },
  },
  {
    name: "studio",
    command: "pnpm",
    args: ["--filter", "asset-studio", "start"],
  },
  // The stack starts the indexer on the rollup once it is bootstrapped; the no-wallet game uses
  // the local ledger instead.
  ...(chain ? [{ name: "localnet", command: "node", args: ["scripts/local-stack.mjs"], env: { INDEXER_PORT: indexerListenPort() } }] : []),
];

const children = [];
let shuttingDown = false;

function prefix(stream, name, dest) {
  let rest = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    rest += chunk;
    const lines = rest.split(/\r?\n/);
    rest = lines.pop() ?? "";
    for (const line of lines) dest.write(`[${name}] ${line}\n`);
  });
  stream.on("end", () => {
    if (rest) dest.write(`[${name}] ${rest}\n`);
  });
}

function killTree(signal) {
  for (const child of children) {
    if (!child.pid) continue;
    try {
      process.kill(-child.pid, signal);
    } catch (err) {
      if (err.code === "ESRCH") continue;
      try {
        child.kill(signal);
      } catch {
        // already gone
      }
    }
  }
}

function shutdown(signal) {
  const exitCode = signal === "SIGINT" ? 130 : signal === "SIGHUP" ? 129 : 143;
  const childSignal = signal === "SIGHUP" ? "SIGTERM" : signal;
  if (shuttingDown) {
    killTree("SIGKILL");
    process.exit(exitCode);
    return;
  }
  shuttingDown = true;
  killTree(childSignal);
  const timer = setTimeout(() => {
    killTree("SIGKILL");
    process.exit(exitCode);
  }, 2000);
  timer.unref();
  const pending = () => children.filter((child) => child.exitCode === null && child.signalCode == null);
  const finish = () => {
    if (pending().length === 0) {
      clearTimeout(timer);
      process.exit(exitCode);
    }
  };
  for (const child of children) child.once("exit", finish);
  finish();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGHUP", () => shutdown("SIGHUP"));
process.on("exit", () => {
  if (!shuttingDown) killTree("SIGTERM");
});

for (const job of jobs) {
  const child = spawn(job.command, job.args, {
    cwd: root,
    env: { ...process.env, ...job.env },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  prefix(child.stdout, job.name, process.stdout);
  prefix(child.stderr, job.name, process.stderr);
  child.on("error", (err) => {
    process.stderr.write(`[${job.name}] ${err.message}\n`);
  });
  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    const how = signal ? `signal ${signal}` : `code ${code}`;
    process.stderr.write(`[${job.name}] exited (${how})\n`);
    const alive = children.some((item) => item.exitCode === null && item.signalCode == null);
    if (!alive) process.exit(code && code !== 0 ? code : 1);
  });
}
