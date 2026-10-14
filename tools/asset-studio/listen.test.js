import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const serverJs = path.join(path.dirname(fileURLToPath(import.meta.url)), "server.js");

function listen(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function runStudio(port) {
  const child = spawn(process.execPath, [serverJs], {
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (chunk) => {
    out += chunk;
  });
  child.stderr.on("data", (chunk) => {
    out += chunk;
  });
  return { child, text: () => out };
}

function waitFor(read, ms) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const value = read();
      if (value) return resolve(value);
      if (Date.now() - start > ms) return reject(new Error("timed out waiting for the studio process"));
      setTimeout(tick, 30);
    };
    tick();
  });
}

function exited(child) {
  if (child.exitCode !== null || child.signalCode) return Promise.resolve(child.exitCode);
  return new Promise((resolve) => {
    child.once("exit", (code) => resolve(code));
  });
}

test("a second studio leaves an existing studio bound to the port", async () => {
  const server = await listen((req, res) => {
    if (req.url === "/api/provider") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ provider: "codex", textProvider: "agent" }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const port = server.address().port;
  const { child, text } = runStudio(port);
  try {
    const line = await waitFor(() => (text().includes("already listening") ? text() : ""), 5000);
    assert.match(line, new RegExp(`asset studio already listening at http://127\\.0\\.0\\.1:${port}`));
    assert.equal(child.exitCode, null);
    const body = await new Promise((resolve, reject) => {
      http.get({ hostname: "127.0.0.1", port, path: "/api/provider" }, (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve(Buffer.concat(chunks).toString()));
      }).on("error", reject);
    });
    assert.equal(body, JSON.stringify({ provider: "codex", textProvider: "agent" }));
    child.kill("SIGTERM");
    assert.equal(await exited(child), 0);
  } finally {
    if (child.exitCode === null && !child.signalCode) child.kill("SIGKILL");
    server.close();
  }
});

test("a taken port that is not the studio exits with the listen error", async () => {
  const server = await listen((_req, res) => {
    res.writeHead(404);
    res.end("nope");
  });
  const port = server.address().port;
  const { child, text } = runStudio(port);
  try {
    const code = await waitFor(() => (child.exitCode === null ? "" : String(child.exitCode)), 5000);
    assert.equal(Number(code), 1);
    assert.match(text(), new RegExp(`asset studio cannot listen on 127\\.0\\.0\\.1:${port}: address already in use`));
    assert.doesNotMatch(text(), /Unhandled/);
  } finally {
    if (child.exitCode === null && !child.signalCode) child.kill("SIGKILL");
    server.close();
  }
});
