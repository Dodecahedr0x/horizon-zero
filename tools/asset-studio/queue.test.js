import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createTaskQueue } from "./queue.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverJs = path.join(here, "server.js");
const repoAssets = path.resolve(here, "../../assets");

function promptChecksums(dir) {
  const out = {};
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(full);
      else if (entry.name === "prompt.md") {
        out[path.relative(dir, full)] = crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex");
      }
    }
  };
  walk(dir);
  return out;
}

const repoPrompts = promptChecksums(repoAssets);
test.after(() => {
  assert.deepEqual(promptChecksums(repoAssets), repoPrompts);
});

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(read, ms) {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if (await read()) return true;
    await delay(15);
  }
  return false;
}

function request(port, method, pathname, payload) {
  return new Promise((resolve, reject) => {
    const body = payload == null ? null : Buffer.from(JSON.stringify(payload));
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: pathname,
        method,
        headers: body ? { "Content-Type": "application/json", "Content-Length": body.length } : {},
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString();
          let parsed = text;
          try {
            parsed = text ? JSON.parse(text) : {};
          } catch {
            parsed = text;
          }
          resolve({ status: res.statusCode, body: parsed });
        });
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

const fakeBinSource = [
  "#!/usr/bin/env node",
  'import fs from "node:fs";',
  "const args = process.argv.slice(2);",
  'const joined = args.join("\\n");',
  "const argsFile = process.env.HZ_QUEUE_ARGS;",
  'if (argsFile) fs.writeFileSync(argsFile + "." + process.pid, JSON.stringify(args));',
  "const sleepMs = Number(process.env.HZ_QUEUE_SLEEP || 400);",
  "const log = process.env.HZ_QUEUE_LOG;",
  "function mark(phase) {",
  "  if (!log) return;",
  '  fs.appendFileSync(log, phase + " " + process.pid + " " + Date.now() + "\\n");',
  "}",
  "const png = Buffer.from(",
  '  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",',
  '  "base64",',
  ");",
  'mark("start");',
  "await new Promise((resolve) => setTimeout(resolve, sleepMs));",
  'if (joined.includes("FAILJOB")) {',
  '  mark("end");',
  '  fs.writeSync(2, "forced failure\\n");',
  "  process.exit(1);",
  "}",
  "const promptFile = joined.match(/Read the entire image prompt from the file (.+?) and pass/);",
  "if (promptFile) {",
  '  const prompt = fs.readFileSync(promptFile[1], "utf8");',
  "  const out = joined.match(/Copy the generated PNG to (.+?), replacing/);",
  '  if (!prompt.includes("NOWRITE") && out) fs.writeFileSync(out[1], png);',
  '  mark("end");',
  "  process.exit(0);",
  "}",
  'const last = args.indexOf("--output-last-message");',
  "if (last !== -1 && args[last + 1]) {",
  '  fs.writeFileSync(args[last + 1], "rewritten level\\n");',
  "}",
  'fs.writeSync(1, "rewritten level\\n");',
  'mark("end");',
  "",
].join("\n");

function writeFakeBin(dir) {
  const file = path.join(dir, "fake-codex.mjs");
  fs.writeFileSync(file, fakeBinSource);
  fs.chmodSync(file, 0o755);
  return file;
}

function logCounts(logFile) {
  const text = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "";
  const lines = text.split(/\n/).filter(Boolean);
  return {
    text,
    starts: lines.filter((line) => line.startsWith("start ")).length,
    ends: lines.filter((line) => line.startsWith("end ")).length,
  };
}

function overlapped(logText) {
  const byPid = new Map();
  for (const line of logText.split(/\n/)) {
    const [phase, pid, ms] = line.trim().split(/\s+/);
    if ((phase !== "start" && phase !== "end") || !pid) continue;
    const row = byPid.get(pid) || {};
    row[phase] = Number(ms);
    byPid.set(pid, row);
  }
  const spans = [...byPid.values()].filter((row) => Number.isFinite(row.start) && Number.isFinite(row.end));
  for (let i = 0; i < spans.length; i += 1) {
    for (let j = i + 1; j < spans.length; j += 1) {
      if (spans[i].start < spans[j].end && spans[j].start < spans[i].end) return true;
    }
  }
  return false;
}

function startStudio(env) {
  const child = spawn(process.execPath, [serverJs], {
    env: { ...process.env, ...env },
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

async function stopStudio(child) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 1000);
  await new Promise((resolve) => child.once("exit", resolve));
  clearTimeout(timer);
}

async function boundPort(child, text) {
  const started = Date.now();
  while (Date.now() - started < 8000) {
    if (child.exitCode !== null) throw new Error(text() || "studio exited");
    const match = text().match(/asset studio http:\/\/127\.0\.0\.1:(\d+)/);
    if (match) return Number(match[1]);
    await delay(20);
  }
  throw new Error(text() || "studio did not listen");
}

async function settle(port, count) {
  const started = Date.now();
  let last;
  while (Date.now() - started < 8000) {
    last = await request(port, "GET", "/api/tasks");
    const tasks = last.body.tasks || [];
    if (tasks.length >= count && tasks.every((task) => task.status === "done" || task.status === "failed")) return tasks;
    await delay(20);
  }
  throw new Error(`tasks did not finish: ${JSON.stringify(last && last.body)}`);
}

test("two jobs on one node both stay queued until they start", async () => {
  const queue = createTaskQueue();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const first = queue.enqueue({ node: "same", kind: "prompt", work: () => gate });
  const second = queue.enqueue({ node: "same", kind: "prompt", work: () => gate });
  assert.equal(first.status, "queued");
  assert.equal(second.status, "queued");
  assert.deepEqual(
    queue.list().map((task) => task.node),
    ["same", "same"],
  );
  await delay(20);
  assert.equal(queue.list().every((task) => task.status === "running"), true);
  release();
  await delay(20);
  assert.equal(queue.list().every((task) => task.status === "done"), true);
  assert.deepEqual(queue.clearFinished(), []);
});

test("a failed job can be cleared while another is still running", async () => {
  const queue = createTaskQueue();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  queue.enqueue({ node: "slow", kind: "image", work: () => gate });
  queue.enqueue({
    node: "bad",
    kind: "3d",
    work: async () => {
      throw new Error("meshy FAILED");
    },
  });
  await delay(20);
  const mid = queue.list();
  assert.equal(mid.find((task) => task.node === "slow").status, "running");
  const failed = mid.find((task) => task.node === "bad");
  assert.equal(failed.status, "failed");
  assert.equal(failed.kind, "3d");
  assert.equal(failed.error, "meshy FAILED");
  const left = queue.clearFinished();
  assert.equal(left.length, 1);
  assert.equal(left[0].status, "running");
  release();
  await delay(20);
});

test("generation jobs overlap, then both finish", async () => {
  const assetsDir = fs.mkdtempSync(path.join(os.tmpdir(), "hz-queue-assets-"));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "hz-queue-bin-"));
  const logFile = path.join(work, "log");
  fs.writeFileSync(path.join(assetsDir, "prompt.md"), "world\n");
  fs.mkdirSync(path.join(assetsDir, "left"));
  fs.mkdirSync(path.join(assetsDir, "right"));
  fs.writeFileSync(path.join(assetsDir, "left", "prompt.md"), "left level\n");
  fs.writeFileSync(path.join(assetsDir, "right", "prompt.md"), "plain image\n");
  const bin = writeFakeBin(work);
  const studio = startStudio({
    PORT: "0",
    ASSET_STUDIO_ASSETS: assetsDir,
    ASSET_CODEX_BIN: bin,
    HZ_QUEUE_LOG: logFile,
    HZ_QUEUE_SLEEP: "400",
  });
  try {
    const port = await boundPort(studio.child, studio.text);
    const rejected = await request(port, "POST", "/api/regenerate-prompt", { path: "../outside", textProvider: "codex" });
    assert.equal(rejected.status, 400);
    const notLeaf = await request(port, "POST", "/api/generate-3d", { path: "." });
    assert.equal(notLeaf.status, 400);
    assert.equal((await request(port, "GET", "/api/tasks")).body.tasks.length, 0);

    const posted = await Promise.all([
      request(port, "POST", "/api/regenerate-prompt", { path: "left", textProvider: "codex" }),
      request(port, "POST", "/api/regenerate-prompt", { path: "left", textProvider: "codex" }),
      request(port, "POST", "/api/generate", { path: "right", provider: "codex" }),
    ]);
    assert.equal(posted.every((res) => res.status === 200 && res.body.status === "queued"), true);
    assert.equal(new Set(posted.map((res) => res.body.id)).size, 3);
    assert.equal(posted.filter((res) => res.body.node === "left" && res.body.kind === "prompt").length, 2);
    assert.equal(posted.filter((res) => res.body.node === "right" && res.body.kind === "image").length, 1);

    const overlap = await waitUntil(async () => {
      const mid = await request(port, "GET", "/api/tasks");
      const counts = logCounts(logFile);
      const running = (mid.body.tasks || []).filter((task) => task.status === "running").length;
      return counts.starts >= 2 && counts.ends === 0 && running >= 2;
    }, 3000);
    assert.equal(overlap, true, JSON.stringify({ log: logCounts(logFile), tasks: (await request(port, "GET", "/api/tasks")).body, server: studio.text().slice(-1500) }));

    const tasks = await settle(port, 3);
    assert.equal(tasks.every((task) => task.status === "done"), true, JSON.stringify(tasks));
    assert.equal(overlapped(fs.readFileSync(logFile, "utf8")), true);
    assert.equal(fs.readFileSync(path.join(assetsDir, "left", "prompt.md"), "utf8"), "rewritten level\n");
    assert.equal(fs.readFileSync(path.join(assetsDir, "right", "prompt.md"), "utf8"), "plain image\n");
    assert.equal(fs.readFileSync(path.join(assetsDir, "prompt.md"), "utf8"), "world\n");
    const png = fs.readFileSync(path.join(assetsDir, "right", "right.png"));
    assert.equal(png.subarray(0, 4).toString("hex"), "89504e47");
    assert.equal(fs.existsSync(path.join(assetsDir, "left", "left.png")), false);
    assert.deepEqual((await request(port, "POST", "/api/tasks/clear")).body.tasks, []);
  } finally {
    await stopStudio(studio.child);
    fs.rmSync(assetsDir, { recursive: true, force: true });
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test("prompt direction stays on that job and is not saved as the prompt", async () => {
  const assetsDir = fs.mkdtempSync(path.join(os.tmpdir(), "hz-queue-direction-"));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "hz-queue-bin-"));
  const logFile = path.join(work, "log");
  const argsFile = path.join(work, "args");
  fs.writeFileSync(path.join(assetsDir, "prompt.md"), "world\n");
  fs.mkdirSync(path.join(assetsDir, "left"));
  fs.writeFileSync(path.join(assetsDir, "left", "prompt.md"), "left level\n");
  const bin = writeFakeBin(work);
  const studio = startStudio({
    PORT: "0",
    ASSET_STUDIO_ASSETS: assetsDir,
    ASSET_CODEX_BIN: bin,
    HZ_QUEUE_LOG: logFile,
    HZ_QUEUE_ARGS: argsFile,
    HZ_QUEUE_SLEEP: "50",
  });
  try {
    const port = await boundPort(studio.child, studio.text);
    const direction = "emphasize weathered bronze";
    const guided = await request(port, "POST", "/api/regenerate-prompt", {
      path: "left",
      textProvider: "codex",
      direction: `  ${direction}  `,
    });
    const plain = await request(port, "POST", "/api/regenerate-prompt", {
      path: "left",
      textProvider: "codex",
      direction: "",
    });
    assert.equal(guided.status, 200);
    assert.equal(guided.body.direction, direction);
    assert.equal(guided.body.kind, "prompt");
    assert.equal(plain.status, 200);
    assert.equal(Object.hasOwn(plain.body, "direction"), false);
    const tasks = await settle(port, 2);
    assert.equal(tasks.find((task) => task.id === guided.body.id).direction, direction);
    assert.equal(Object.hasOwn(tasks.find((task) => task.id === plain.body.id), "direction"), false);
    assert.equal(fs.readFileSync(path.join(assetsDir, "left", "prompt.md"), "utf8"), "rewritten level\n");
    assert.equal(fs.readFileSync(path.join(assetsDir, "prompt.md"), "utf8"), "world\n");
    const instructions = fs
      .readdirSync(work)
      .filter((name) => name.startsWith("args."))
      .map((name) => JSON.parse(fs.readFileSync(path.join(work, name), "utf8")).at(-1));
    assert.equal(instructions.length, 2);
    assert.equal(instructions.filter((text) => text.includes(direction)).length, 1);
    assert.equal(instructions.filter((text) => text.includes("hard constraint")).length, 1);
    assert.equal(instructions.every((text) => text.includes("Print only this level's prompt and nothing else")), true);
  } finally {
    await stopStudio(studio.child);
    fs.rmSync(assetsDir, { recursive: true, force: true });
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test("a failing job does not fail the sibling", async () => {
  const assetsDir = fs.mkdtempSync(path.join(os.tmpdir(), "hz-queue-fail-"));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "hz-queue-bin-"));
  const logFile = path.join(work, "log");
  fs.writeFileSync(path.join(assetsDir, "prompt.md"), "world\n");
  fs.mkdirSync(path.join(assetsDir, "ok"));
  fs.mkdirSync(path.join(assetsDir, "bad"));
  fs.mkdirSync(path.join(assetsDir, "blank"));
  fs.writeFileSync(path.join(assetsDir, "ok", "prompt.md"), "ok level\n");
  fs.writeFileSync(path.join(assetsDir, "bad", "prompt.md"), "FAILJOB\n");
  fs.writeFileSync(path.join(assetsDir, "blank", "prompt.md"), "NOWRITE\n");
  const bin = writeFakeBin(work);
  const studio = startStudio({
    PORT: "0",
    ASSET_STUDIO_ASSETS: assetsDir,
    ASSET_CODEX_BIN: bin,
    HZ_QUEUE_LOG: logFile,
    HZ_QUEUE_SLEEP: "400",
  });
  try {
    const port = await boundPort(studio.child, studio.text);
    const posted = await Promise.all([
      request(port, "POST", "/api/regenerate-prompt", { path: "ok", textProvider: "codex" }),
      request(port, "POST", "/api/regenerate-prompt", { path: "bad", textProvider: "codex" }),
      request(port, "POST", "/api/generate", { path: "blank", provider: "codex" }),
    ]);
    assert.equal(posted.every((res) => res.status === 200), true);
    const overlap = await waitUntil(async () => {
      const mid = await request(port, "GET", "/api/tasks");
      const counts = logCounts(logFile);
      const running = (mid.body.tasks || []).filter((task) => task.status === "running").length;
      return counts.starts >= 2 && counts.ends === 0 && running >= 2;
    }, 3000);
    assert.equal(overlap, true, JSON.stringify({ log: logCounts(logFile), tasks: (await request(port, "GET", "/api/tasks")).body, server: studio.text().slice(-1500) }));

    const tasks = await settle(port, 3);
    const ok = tasks.find((task) => task.node === "ok");
    const bad = tasks.find((task) => task.node === "bad");
    const blank = tasks.find((task) => task.node === "blank");
    assert.equal(ok.status, "done");
    assert.equal(ok.error, null);
    assert.equal(bad.status, "failed");
    assert.match(bad.error, /forced failure/);
    assert.equal(blank.status, "failed");
    assert.match(blank.error, /candidate png/);
    assert.equal(fs.readFileSync(path.join(assetsDir, "ok", "prompt.md"), "utf8"), "rewritten level\n");
    assert.equal(fs.readFileSync(path.join(assetsDir, "bad", "prompt.md"), "utf8"), "FAILJOB\n");
    assert.equal(fs.readFileSync(path.join(assetsDir, "blank", "prompt.md"), "utf8"), "NOWRITE\n");
    assert.equal(fs.readFileSync(path.join(assetsDir, "prompt.md"), "utf8"), "world\n");
    assert.equal(fs.existsSync(path.join(assetsDir, "blank", "blank.png")), false);
    assert.equal(overlapped(fs.readFileSync(logFile, "utf8")), true);
  } finally {
    await stopStudio(studio.child);
    fs.rmSync(assetsDir, { recursive: true, force: true });
    fs.rmSync(work, { recursive: true, force: true });
  }
});
