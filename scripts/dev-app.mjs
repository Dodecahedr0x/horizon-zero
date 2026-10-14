// Vite plus the local ledger. Children stay in this process group so a signal
// from `pnpm dev:all` reaches both of them.
import "./load-root-env.mjs";
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appDir = path.join(root, "app");
const port = Number(process.env.LOCAL_LEDGER_PORT || 4713);

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

function start(name, args, cwd) {
  const child = spawn(process.execPath, args, {
    cwd,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  prefix(child.stdout, name, process.stdout);
  prefix(child.stderr, name, process.stderr);
  child.on("error", (err) => {
    process.stderr.write(`[${name}] ${err.message}\n`);
  });
  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    const how = signal ? `signal ${signal}` : `code ${code}`;
    process.stderr.write(`[${name}] exited (${how})\n`);
    shutdown(code && code !== 0 ? code : 1);
  });
  return child;
}

function shutdown(exitCode) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (child.exitCode !== null || child.signalCode) continue;
    child.kill("SIGTERM");
  }
  const timer = setTimeout(() => {
    for (const child of children) {
      if (child.exitCode === null && !child.signalCode) child.kill("SIGKILL");
    }
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

function waitForPort(timeoutMs) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const socket = net.connect({ port, host: "127.0.0.1" });
      const fail = () => {
        socket.destroy();
        if (Date.now() - start > timeoutMs) reject(new Error(`local ledger did not listen on ${port}`));
        else setTimeout(tryOnce, 40);
      };
      socket.on("connect", () => {
        socket.end();
        resolve();
      });
      socket.on("error", fail);
    };
    tryOnce();
  });
}

process.on("SIGINT", () => shutdown(130));
process.on("SIGTERM", () => shutdown(143));

start("ledger", [path.join(appDir, "local-ledger.mjs")], root);
try {
  await waitForPort(8000);
} catch (err) {
  if (!shuttingDown) process.stderr.write(`[ledger] ${err.message}\n`);
  shutdown(1);
}
if (!shuttingDown) start("vite", [path.join(appDir, "node_modules/vite/bin/vite.js")], appDir);
