import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverJs = path.join(here, "server.js");
const glbBytes = Buffer.from("glTF-warden-model");

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readReq(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function startFakeMeshy() {
  const state = {
    releaseSuccess: false,
    rejectPosts: false,
    posts: [],
    origin: "",
  };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (req.method === "POST" && url.pathname === "/openapi/v1/image-to-3d") {
      const raw = await readReq(req);
      const parsed = JSON.parse(raw.toString());
      const encoded = String(parsed.image_url || "").split(",")[1] || "";
      const image = Buffer.from(encoded, "base64");
      state.posts.push({
        id: `task-${state.posts.length + 1}`,
        body: parsed,
        fail: image.includes(Buffer.from("FAIL")),
      });
      if (state.rejectPosts) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("unexpected create");
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ result: state.posts[state.posts.length - 1].id }));
      return;
    }
    if (req.method === "GET" && url.pathname === "/models/out.glb") {
      res.writeHead(200, { "Content-Type": "model/gltf-binary" });
      res.end(glbBytes);
      return;
    }
    if (req.method === "GET" && url.pathname.startsWith("/openapi/v1/image-to-3d/")) {
      const id = decodeURIComponent(url.pathname.slice("/openapi/v1/image-to-3d/".length));
      const task = id === "resume-warden" ? { fail: false, resume: true } : state.posts.find((row) => row.id === id);
      if (!task) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("missing");
        return;
      }
      let payload;
      if (task.fail) payload = { status: "FAILED", task_error: { message: "texture generation failed" } };
      else if (!task.resume && !state.releaseSuccess) payload = { status: "IN_PROGRESS", progress: 40 };
      else payload = { status: "SUCCEEDED", model_urls: { glb: `${state.origin}/models/out.glb` } };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("missing");
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      state.origin = `http://127.0.0.1:${server.address().port}`;
      state.close = () => new Promise((done) => server.close(() => done()));
      resolve(state);
    });
  });
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

function requestBuffer(port, pathname) {
  return new Promise((resolve, reject) => {
    http
      .get({ hostname: "127.0.0.1", port, path: pathname }, (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
      })
      .on("error", reject);
  });
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

async function waitUntil(read, ms) {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if (await read()) return true;
    await delay(15);
  }
  return false;
}

async function waitJob(port, node) {
  const started = Date.now();
  let last;
  while (Date.now() - started < 8000) {
    last = await request(port, "GET", "/api/tasks");
    const job = (last.body.tasks || []).find((task) => task.node === node && task.kind === "3d");
    if (job && (job.status === "done" || job.status === "failed")) return job;
    await delay(15);
  }
  throw new Error(`job did not finish: ${JSON.stringify(last && last.body)}`);
}

function writeLeaf(root, segments, png) {
  const dir = path.join(root, ...segments);
  fs.mkdirSync(dir, { recursive: true });
  const name = segments[segments.length - 1];
  fs.writeFileSync(path.join(dir, "prompt.md"), `${name}\n`);
  fs.writeFileSync(path.join(dir, `${name}.approved.png`), png);
  return dir;
}

function relPath(root, dir) {
  return path.relative(root, dir).split(path.sep).join("/");
}

test("a succeeded Meshy task writes the glb beside the race folder and a failed task does not", async () => {
  const assetsDir = fs.mkdtempSync(path.join(os.tmpdir(), "hz-meshy-assets-"));
  const wardenDir = writeLeaf(assetsDir, ["units", "ashborn", "warden"], Buffer.from("warden-png"));
  const brokenDir = writeLeaf(assetsDir, ["units", "ashborn", "broken"], Buffer.from("FAIL-png"));
  const wardenNode = relPath(assetsDir, wardenDir);
  const brokenNode = relPath(assetsDir, brokenDir);
  const meshy = await startFakeMeshy();
  const studio = startStudio({
    PORT: "0",
    ASSET_STUDIO_ASSETS: assetsDir,
    MESHY_API_BASE: meshy.origin,
    MESHY_API_KEY: "test-key",
    MESHY_POLL_MS: "20",
  });
  try {
    const port = await boundPort(studio.child, studio.text);
    const posted = await request(port, "POST", "/api/generate-3d", { path: wardenNode });
    assert.equal(posted.status, 200);
    assert.equal(posted.body.kind, "3d");
    assert.equal(posted.body.node, wardenNode);
    assert.equal(posted.body.status, "queued");

    const stillRunning = await waitUntil(async () => {
      const tasks = (await request(port, "GET", "/api/tasks")).body.tasks || [];
      const job = tasks.find((task) => task.kind === "3d" && task.node === wardenNode);
      const taskPath = path.join(wardenDir, "warden.meshy.json");
      if (!job || job.status !== "running" || !fs.existsSync(taskPath) || fs.existsSync(path.join(wardenDir, "warden.glb"))) return false;
      return JSON.parse(fs.readFileSync(taskPath, "utf8")).status === "IN_PROGRESS";
    }, 4000);
    assert.equal(stillRunning, true, studio.text().slice(-1500));
    assert.equal(meshy.posts.length, 1);
    const created = meshy.posts[0].body;
    assert.equal(created.should_texture, true);
    assert.deepEqual(created.target_formats, ["glb"]);
    assert.equal(created.ai_model, "latest");
    assert.equal(created.pose_mode, "a-pose");
    assert.equal(Object.hasOwn(created, "lowpoly"), false);
    assert.equal(created.image_url.startsWith("data:image/png;base64,"), true);

    meshy.releaseSuccess = true;
    const done = await waitJob(port, wardenNode);
    assert.equal(done.status, "done", done.error || "");
    assert.equal(done.error, null);
    const glbPath = path.join(wardenDir, "warden.glb");
    assert.equal(fs.existsSync(glbPath), true);
    assert.deepEqual(fs.readFileSync(glbPath), glbBytes);
    assert.equal(fs.existsSync(`${glbPath}.partial`), false);
    const task = JSON.parse(fs.readFileSync(path.join(wardenDir, "warden.meshy.json"), "utf8"));
    assert.equal(task.taskId, "task-1");
    assert.equal(task.status, "SUCCEEDED");
    assert.equal(task.error, undefined);

    const element = await request(port, "GET", `/api/element?path=${encodeURIComponent(wardenNode)}`);
    assert.equal(element.body.candidateGlb, true);
    assert.equal(element.body.name, "warden");
    const preview = await requestBuffer(port, `/files/${wardenNode}/warden.glb`);
    assert.equal(preview.status, 200);
    assert.deepEqual(preview.body, glbBytes);

    const failedPost = await request(port, "POST", "/api/generate-3d", { path: brokenNode });
    assert.equal(failedPost.status, 200);
    assert.equal(failedPost.body.status, "queued");
    const failed = await waitJob(port, brokenNode);
    assert.equal(failed.status, "failed");
    assert.equal(failed.error, "texture generation failed");
    assert.equal(fs.existsSync(path.join(brokenDir, "broken.glb")), false);
    const failedTask = JSON.parse(fs.readFileSync(path.join(brokenDir, "broken.meshy.json"), "utf8"));
    assert.equal(failedTask.status, "FAILED");
    assert.equal(failedTask.error, "texture generation failed");
    assert.equal(meshy.posts.length, 2);
    assert.equal(Object.hasOwn(meshy.posts[1].body, "lowpoly"), false);
  } finally {
    await stopStudio(studio.child);
    await meshy.close();
    fs.rmSync(assetsDir, { recursive: true, force: true });
  }
});

test("Generate 3D resumes a Meshy task id when the glb is missing", async () => {
  const assetsDir = fs.mkdtempSync(path.join(os.tmpdir(), "hz-meshy-resume-"));
  const wardenDir = writeLeaf(assetsDir, ["units", "ashborn", "warden"], Buffer.from("warden-png"));
  fs.writeFileSync(
    path.join(wardenDir, "warden.meshy.json"),
    JSON.stringify({ taskId: "resume-warden", status: "IN_PROGRESS" }),
  );
  const wardenNode = relPath(assetsDir, wardenDir);
  const meshy = await startFakeMeshy();
  meshy.rejectPosts = true;
  const studio = startStudio({
    PORT: "0",
    ASSET_STUDIO_ASSETS: assetsDir,
    MESHY_API_BASE: meshy.origin,
    MESHY_API_KEY: "test-key",
    MESHY_POLL_MS: "20",
  });
  try {
    const port = await boundPort(studio.child, studio.text);
    const posted = await request(port, "POST", "/api/generate-3d", { path: wardenNode });
    assert.equal(posted.status, 200);
    assert.equal(posted.body.kind, "3d");
    const done = await waitJob(port, wardenNode);
    assert.equal(done.status, "done", done.error || studio.text().slice(-1500));
    assert.equal(meshy.posts.length, 0);
    assert.deepEqual(fs.readFileSync(path.join(wardenDir, "warden.glb")), glbBytes);
    const task = JSON.parse(fs.readFileSync(path.join(wardenDir, "warden.meshy.json"), "utf8"));
    assert.equal(task.taskId, "resume-warden");
    assert.equal(task.status, "SUCCEEDED");
  } finally {
    await stopStudio(studio.child);
    await meshy.close();
    fs.rmSync(assetsDir, { recursive: true, force: true });
  }
});
