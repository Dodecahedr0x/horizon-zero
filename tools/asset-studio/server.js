import "../../scripts/load-root-env.mjs";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { agentImageArgs, agentTextArgs, assertProvider, codexImageArgs, codexTextArgs, newestPng, promptFromCliOutput, savedPngFromOutput, textRewriteInstruction, withoutApiKey } from "./generate.js";
import { concatPrompt, createEntity, descendantDirs, descendantImagePaths, imageName, imageTarget, isElement, modelRel, ownPrompt, parentPrompt, removeEntity, renameEntity, resolveAssetDir, walk, writePrompt } from "./prompts.js";
import { BEHAVIORS, RACES, assertArmy, clampRounds, groundById, randomArmy, runFight } from "./battle.js";
import { createTaskQueue } from "./queue.js";
import { AIMS, EFFECTS } from "../../content/interpret.mjs";
import { LIMITS, MAX_ARMY_GAMES, MAX_DUEL_GAMES, catalogStats, runBalance, saveStats, warnings } from "./balance.js";

const require = createRequire(import.meta.url);
const combat = require("../../app/src/combat-node/horizon_combat.js");

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const CONTENT_FILES = {
  "/content/ids.mjs": { file: "ids.mjs", type: "text/javascript; charset=utf-8" },
  "/content/trace.mjs": { file: "trace.mjs", type: "text/javascript; charset=utf-8" },
  "/content/catalog.json": { file: "catalog.json", type: "application/json; charset=utf-8" },
};
const assets = path.resolve(process.env.ASSET_STUDIO_ASSETS || path.join(root, "assets"));
const taskQueue = createTaskQueue();
const providerFile = path.join(here, "provider.json");
const port = Number(process.env.PORT || 4712);

function resolveLeaf(rel) {
  const { dir } = imageTarget(assets, rel);
  if (!isElement(dir)) throw new Error("not a leaf element");
  return dir;
}

function describeDir(dir) {
  const rel = path.relative(assets, dir) || ".";
  const name = imageName(assets, dir);
  const candidatePng = path.join(dir, `${name}.png`);
  const approvedPng = path.join(dir, `${name}.approved.png`);
  const candidateGlb = path.join(dir, `${name}.glb`);
  const approvedGlb = path.join(dir, `${name}.approved.glb`);
  const taskPath = path.join(dir, `${name}.meshy.json`);
  return {
    name,
    path: rel,
    ownPrompt: ownPrompt(dir),
    prompt: concatPrompt(assets, dir),
    element: isElement(dir),
    candidatePng: fs.existsSync(candidatePng),
    approvedPng: fs.existsSync(approvedPng),
    candidateGlb: fs.existsSync(candidateGlb),
    approvedGlb: fs.existsSync(approvedGlb),
    model: modelRel(assets, dir),
    task: fs.existsSync(taskPath) ? JSON.parse(fs.readFileSync(taskPath, "utf8")) : null,
    unit: rel.startsWith("units" + path.sep),
  };
}

function readProviderFile() {
  try {
    const parsed = JSON.parse(fs.readFileSync(providerFile, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function savedChoice(value) {
  return value === "codex" || value === "agent" ? value : null;
}

function fallbackImage() {
  const saved = savedChoice(readProviderFile().provider);
  if (saved) return saved;
  const env = process.env.ASSET_IMAGE_PROVIDER;
  if (env === "codex" || env === "agent") return env;
  return "codex";
}

function fallbackText() {
  const saved = savedChoice(readProviderFile().textProvider);
  if (saved) return saved;
  const env = process.env.ASSET_TEXT_PROVIDER;
  if (env === "codex" || env === "agent") return env;
  return "codex";
}

function providerForRequest(requested) {
  if (requested == null || requested === "") return fallbackImage();
  return assertProvider(requested);
}

function textProviderForRequest(requested) {
  if (requested == null || requested === "") return fallbackText();
  return assertProvider(requested);
}

function writeProviderFile(next) {
  const current = readProviderFile();
  const stored = {};
  const provider = next.provider === undefined ? savedChoice(current.provider) : savedChoice(next.provider);
  const textProvider = next.textProvider === undefined ? savedChoice(current.textProvider) : savedChoice(next.textProvider);
  if (provider) stored.provider = provider;
  if (textProvider) stored.textProvider = textProvider;
  fs.writeFileSync(providerFile, `${JSON.stringify(stored)}\n`);
  return { provider: fallbackImage(), textProvider: fallbackText() };
}

function run(command, args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      if (error.code === "ENOENT") reject(new Error(`${command} is not installed`));
      else reject(error);
    });
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error((stderr || stdout || `${command} exited ${code}`).trim().slice(-2000)));
    });
  });
}

function generatedImageDir() {
  const home = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  return path.join(home, "generated_images");
}

async function generateImage(dir, provider) {
  const name = imageName(assets, dir);
  const out = path.join(dir, `${name}.png`);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hz-asset-"));
  const promptFile = path.join(tempDir, "prompt.md");
  const started = Date.now();
  try {
    fs.writeFileSync(promptFile, concatPrompt(assets, dir));
    if (provider === "agent") {
      const spec = agentImageArgs({
        bin: process.env.ASSET_AGENT_BIN || "agent",
        out,
        promptText: fs.readFileSync(promptFile, "utf8"),
      });
      await run(spec.command, spec.args, withoutApiKey(process.env));
    } else if (provider === "codex") {
      const spec = codexImageArgs({
        bin: process.env.ASSET_CODEX_BIN || "codex",
        promptFile,
        out,
        cwd: root,
        tempDir,
      });
      const stdout = await run(spec.command, spec.args, withoutApiKey(process.env));
      if (!fs.existsSync(out)) {
        const saved = savedPngFromOutput(stdout);
        const source = saved && fs.existsSync(saved) ? saved : newestPng(generatedImageDir(), started);
        if (!source) throw new Error("image provider did not write the candidate png");
        fs.copyFileSync(source, out);
      }
    } else {
      throw new Error(`unknown image provider ${provider}`);
    }
    if (!fs.existsSync(out)) throw new Error("image provider did not write the candidate png");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function regeneratePrompt(rel, provider, direction) {
  const dir = resolveAssetDir(assets, rel);
  const instruction = textRewriteInstruction({
    parents: parentPrompt(assets, dir),
    current: ownPrompt(dir),
    direction,
  });
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hz-prompt-"));
  try {
    let stdout = "";
    if (provider === "agent") {
      const spec = agentTextArgs({
        bin: process.env.ASSET_AGENT_BIN || "agent",
        instruction,
      });
      stdout = await run(spec.command, spec.args, withoutApiKey(process.env));
    } else if (provider === "codex") {
      const lastMessage = path.join(tempDir, "last.md");
      const spec = codexTextArgs({
        bin: process.env.ASSET_CODEX_BIN || "codex",
        instruction,
        cwd: root,
        lastMessage,
      });
      stdout = await run(spec.command, spec.args, withoutApiKey(process.env));
      if (fs.existsSync(lastMessage)) {
        const fileText = fs.readFileSync(lastMessage, "utf8");
        if (fileText.trim()) stdout = fileText;
      }
    } else {
      throw new Error(`unknown image provider ${provider}`);
    }
    writePrompt(assets, rel, promptFromCliOutput(stdout));
    return dir;
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function approve(from, to) {
  if (!fs.existsSync(from)) throw new Error("candidate is missing");
  if (fs.existsSync(to)) fs.rmSync(to);
  fs.renameSync(from, to);
}

function meshyOrigin() {
  return (process.env.MESHY_API_BASE || "https://api.meshy.ai").replace(/\/$/, "");
}

function meshyPollDelay() {
  const value = Number(process.env.MESHY_POLL_MS);
  if (Number.isFinite(value) && value >= 0) return value;
  return 4000;
}

function meshyFailure(payload, status) {
  const taskError = payload && payload.task_error;
  const message = taskError && typeof taskError === "object" ? taskError.message : taskError;
  if (typeof message === "string" && message.trim()) return message.trim();
  return `meshy ${status}`;
}

function writeMeshyTask(taskPath, record) {
  fs.writeFileSync(taskPath, JSON.stringify(record));
}

function readMeshyTask(taskPath) {
  if (!fs.existsSync(taskPath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(taskPath, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

async function meshy(pathname, options) {
  const response = await fetch(`${meshyOrigin()}${pathname}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${process.env.MESHY_API_KEY || ""}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  if (!response.ok) throw new Error(`meshy ${response.status} ${await response.text()}`);
  return response.json();
}

async function pollMeshy(taskId, taskPath) {
  let status = "PENDING";
  let payload = null;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, meshyPollDelay()));
    payload = await meshy(`/openapi/v1/image-to-3d/${taskId}`, { method: "GET" });
    status = payload.status;
    if (status === "FAILED") {
      const error = meshyFailure(payload, status);
      writeMeshyTask(taskPath, { taskId, status, error });
      throw new Error(error);
    }
    writeMeshyTask(taskPath, { taskId, status });
    if (status === "SUCCEEDED") return payload;
  }
  throw new Error(`meshy ${status}`);
}

async function downloadGlb(url, dest) {
  const response = await fetch(url);
  if (!response.ok) throw new Error("glb download failed");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0) throw new Error("glb download was empty");
  const partial = `${dest}.partial`;
  fs.writeFileSync(partial, bytes);
  fs.renameSync(partial, dest);
}

async function generateModel(leaf) {
  const name = imageName(assets, leaf);
  const png = path.join(leaf, `${name}.approved.png`);
  if (!fs.existsSync(png)) throw new Error("approve an image first");
  const taskPath = path.join(leaf, `${name}.meshy.json`);
  const glbPath = path.join(leaf, `${name}.glb`);
  const existing = readMeshyTask(taskPath);
  const resume = Boolean(
    existing &&
      typeof existing.taskId === "string" &&
      existing.taskId &&
      existing.status !== "FAILED" &&
      !fs.existsSync(glbPath),
  );
  let taskId = resume ? existing.taskId : "";
  if (!taskId) {
    const image = fs.readFileSync(png).toString("base64");
    const body = {
      image_url: `data:image/png;base64,${image}`,
      should_texture: true,
      target_formats: ["glb"],
      ai_model: "latest",
    };
    if (path.relative(assets, leaf).startsWith("units" + path.sep)) body.pose_mode = "a-pose";
    const created = await meshy("/openapi/v1/image-to-3d", { method: "POST", body: JSON.stringify(body) });
    taskId = created.result;
    if (typeof taskId !== "string" || !taskId) throw new Error("meshy did not return a task id");
    writeMeshyTask(taskPath, { taskId, status: "PENDING" });
  }
  const payload = await pollMeshy(taskId, taskPath);
  const url = payload && payload.model_urls && payload.model_urls.glb;
  if (typeof url !== "string" || !url) throw new Error("meshy SUCCEEDED without a glb url");
  await downloadGlb(url, glbPath);
  if (!fs.existsSync(glbPath) || fs.statSync(glbPath).size === 0) throw new Error("glb was not written");
}

// The race a Balance request tunes: the catalog race id, 0 when the request names none.
function balanceRace(value) {
  return value == null || value === "" ? 0 : Number(value);
}

function nodeOf(dir) {
  return path.relative(assets, dir) || ".";
}

function enqueueImage(dir, provider) {
  return taskQueue.enqueue({
    node: nodeOf(dir),
    kind: "image",
    work: () => generateImage(dir, provider),
  });
}

function enqueueModel(leaf) {
  const glbPath = path.join(leaf, `${imageName(assets, leaf)}.glb`);
  return taskQueue.enqueue({
    node: nodeOf(leaf),
    kind: "3d",
    work: async () => {
      await generateModel(leaf);
      if (!fs.existsSync(glbPath) || fs.statSync(glbPath).size === 0) throw new Error("glb was not written");
    },
  });
}

function modelReady(dir) {
  const name = imageName(assets, dir);
  if (!fs.existsSync(path.join(dir, `${name}.approved.png`))) return false;
  const taskPath = path.join(dir, `${name}.meshy.json`);
  if (!fs.existsSync(taskPath)) return true;
  try {
    const existing = JSON.parse(fs.readFileSync(taskPath, "utf8"));
    return !existing || existing.status === "SUCCEEDED" || existing.status === "FAILED";
  } catch {
    return false;
  }
}

function menuModelTask(rel) {
  try {
    return enqueueModel(resolveLeaf(rel));
  } catch (error) {
    if (error.message !== "not a leaf element") throw error;
    return taskQueue.fail({
      node: nodeOf(resolveAssetDir(assets, rel)),
      kind: "3d",
      error: error.message,
    });
  }
}

function childModelTasks(rel) {
  const parent = resolveAssetDir(assets, rel);
  const ready = [];
  for (const child of descendantDirs(assets, rel)) {
    try {
      const leaf = resolveLeaf(child);
      if (modelReady(leaf)) ready.push(leaf);
    } catch {
      continue;
    }
  }
  if (ready.length === 0) {
    return [
      taskQueue.fail({
        node: nodeOf(parent),
        kind: "3d",
        error: "no descendant can be modeled",
      }),
    ];
  }
  return ready.map((leaf) => enqueueModel(leaf));
}

function send(res, status, body, type = "application/json") {
  res.writeHead(status, { "Content-Type": type });
  if (Buffer.isBuffer(body) || typeof body === "string") res.end(body);
  else res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {});
      } catch (error) {
        reject(error);
      }
    });
  });
}

const battles = new Map();
let battleSeq = 1;

function battleView(batch) {
  return {
    id: batch.id,
    done: batch.done,
    rounds: batch.rounds,
    wins: batch.wins,
    losses: batch.losses,
    draws: batch.draws,
    running: batch.running,
    error: batch.error,
    games: batch.games,
  };
}

function copyUnits(units) {
  return units.map((unit) => ({ ...unit, body: Array.isArray(unit.body) ? unit.body.slice() : unit.body }));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runBatch(batch, ground, army) {
  try {
    while (batch.done < batch.rounds && !batch.stop) {
      const opponent = randomArmy(ground.id, Math.random, army[0] && army[0].race != null ? army[0].race : 0);
      const result = runFight(combat, { cols: ground.cols, rows: ground.rows, a: army, b: opponent.units });
      if (result.outcome === "A") batch.wins += 1;
      else if (result.outcome === "B") batch.losses += 1;
      else batch.draws += 1;
      batch.games.push({
        index: batch.done + 1,
        result: result.result,
        seed: result.seed,
        lines: result.lines,
        sentences: result.sentences,
        blocked: result.blocked,
        cols: ground.cols,
        rows: ground.rows,
        a: copyUnits(army),
        b: copyUnits(opponent.units),
      });
      batch.done += 1;
      await delay(20);
    }
  } catch (error) {
    batch.error = error.message;
  } finally {
    batch.running = false;
  }
}

function startBatch(ground, army, rounds) {
  const batch = {
    id: String(battleSeq),
    rounds,
    done: 0,
    wins: 0,
    losses: 0,
    draws: 0,
    running: true,
    stop: false,
    error: null,
    games: [],
  };
  battleSeq += 1;
  battles.set(batch.id, batch);
  runBatch(batch, ground, army);
  return battleView(batch);
}

const publicDir = path.join(here, "public");
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if (req.method === "GET" && url.pathname === "/") {
      return send(res, 200, fs.readFileSync(path.join(publicDir, "index.html")), "text/html; charset=utf-8");
    }
    if (req.method === "GET" && url.pathname === "/theme.css") {
      return send(res, 200, fs.readFileSync(path.join(root, "app/src/theme.css")), "text/css; charset=utf-8");
    }
    if (req.method === "GET" && url.pathname === "/board-view.js") {
      return send(res, 200, fs.readFileSync(path.join(root, "app/src/board-view.js")), "text/javascript; charset=utf-8");
    }
    // Shared content modules that the board and the event list import in the browser. Served from a
    // fixed list, so no other path under content/ is reachable.
    const content = CONTENT_FILES[url.pathname];
    if (req.method === "GET" && content) {
      return send(res, 200, fs.readFileSync(path.join(root, "content", content.file)), content.type);
    }
    if (req.method === "GET" && url.pathname === "/event-list.js") {
      return send(res, 200, fs.readFileSync(path.join(here, "event-list.js")), "text/javascript; charset=utf-8");
    }
    if (req.method === "GET" && url.pathname.startsWith("/assets/")) {
      const rel = decodeURIComponent(url.pathname.slice("/assets/".length));
      const file = path.resolve(assets, rel);
      if (file !== assets && !file.startsWith(assets + path.sep)) return send(res, 404, "missing");
      let stat;
      try {
        stat = fs.statSync(file);
      } catch {
        return send(res, 404, "missing");
      }
      if (!stat.isFile()) return send(res, 404, "missing");
      const type = file.endsWith(".glb") ? "model/gltf-binary" : file.endsWith(".png") ? "image/png" : "application/octet-stream";
      res.writeHead(200, { "Content-Type": type, "Content-Length": stat.size });
      const stream = fs.createReadStream(file);
      stream.on("error", () => res.destroy());
      res.on("close", () => stream.destroy());
      stream.pipe(res);
      return;
    }
    if (req.method === "GET" && url.pathname.startsWith("/vendor/")) {
      const base = path.join(here, "node_modules");
      const file = path.resolve(base, decodeURIComponent(url.pathname.slice("/vendor/".length)));
      if (file !== base && !file.startsWith(base + path.sep)) return send(res, 404, "missing");
      if (!fs.existsSync(file)) return send(res, 404, "missing");
      return send(res, 200, fs.readFileSync(file), "text/javascript");
    }
    if (req.method === "GET" && url.pathname.startsWith("/files/")) {
      const file = path.resolve(assets, decodeURIComponent(url.pathname.slice("/files/".length)));
      if (!file.startsWith(assets)) return send(res, 404, "missing");
      if (!fs.existsSync(file)) return send(res, 404, "missing");
      const type = file.endsWith(".png") ? "image/png" : file.endsWith(".glb") ? "model/gltf-binary" : "application/octet-stream";
      const body = fs.readFileSync(file);
      res.writeHead(200, {
        "Content-Type": type,
        "Content-Length": body.length,
      });
      return res.end(body);
    }
    if (req.method === "GET" && url.pathname === "/api/tree") return send(res, 200, walk(assets));
    if (req.method === "GET" && url.pathname === "/api/tasks") {
      res.setHeader("Cache-Control", "no-store");
      return send(res, 200, { tasks: taskQueue.list() });
    }
    if (req.method === "POST" && url.pathname === "/api/tasks/clear") {
      res.setHeader("Cache-Control", "no-store");
      return send(res, 200, { tasks: taskQueue.clearFinished() });
    }
    if (req.method === "GET" && url.pathname === "/api/provider") {
      return send(res, 200, { provider: fallbackImage(), textProvider: fallbackText() });
    }
    if (req.method === "GET" && url.pathname === "/api/element") {
      return send(res, 200, describeDir(resolveAssetDir(assets, url.searchParams.get("path"))));
    }
    if (req.method === "POST" && url.pathname === "/api/provider") {
      const body = await readBody(req);
      const next = {};
      if (body.provider != null && body.provider !== "") next.provider = assertProvider(body.provider);
      if (body.textProvider != null && body.textProvider !== "") next.textProvider = assertProvider(body.textProvider);
      if (next.provider === undefined && next.textProvider === undefined) throw new Error("unknown image provider");
      return send(res, 200, writeProviderFile(next));
    }
    if (req.method === "POST" && url.pathname === "/api/prompt") {
      const body = await readBody(req);
      const dir = writePrompt(assets, body.path, body.prompt);
      return send(res, 200, describeDir(dir));
    }
    if (req.method === "POST" && url.pathname === "/api/regenerate-prompt") {
      const body = await readBody(req);
      const dir = resolveAssetDir(assets, body.path);
      const provider = textProviderForRequest(body.textProvider);
      const node = nodeOf(dir);
      const direction = typeof body.direction === "string" ? body.direction.trim() : "";
      return send(res, 200, taskQueue.enqueue({
        node,
        kind: "prompt",
        direction,
        work: () => regeneratePrompt(node, provider, direction),
      }));
    }
    if (req.method === "POST" && url.pathname === "/api/create") {
      const body = await readBody(req);
      return send(res, 200, describeDir(createEntity(assets, body.path, body.name)));
    }
    if (req.method === "POST" && url.pathname === "/api/rename") {
      const body = await readBody(req);
      return send(res, 200, describeDir(renameEntity(assets, body.path, body.name)));
    }
    if (req.method === "POST" && url.pathname === "/api/remove") {
      const body = await readBody(req);
      return send(res, 200, describeDir(removeEntity(assets, body.path)));
    }
    if (req.method === "POST" && url.pathname === "/api/generate") {
      const body = await readBody(req);
      const target = imageTarget(assets, body.path);
      const provider = providerForRequest(body.provider);
      return send(res, 200, taskQueue.enqueue({
        node: nodeOf(target.dir),
        kind: "image",
        work: () => generateImage(target.dir, provider),
      }));
    }
    if (req.method === "POST" && url.pathname === "/api/approve-image") {
      const body = await readBody(req);
      const target = imageTarget(assets, body.path);
      approve(target.png, path.join(target.dir, `${target.name}.approved.png`));
      return send(res, 200, describeDir(target.dir));
    }
    if (req.method === "POST" && url.pathname === "/api/generate-3d") {
      const body = await readBody(req);
      return send(res, 200, enqueueModel(resolveLeaf(body.path)));
    }
    if (req.method === "POST" && url.pathname === "/api/generate-descendants") {
      const body = await readBody(req);
      const provider = providerForRequest(body.provider);
      resolveAssetDir(assets, body.path);
      const tasks = descendantImagePaths(assets, body.path).map((png) => enqueueImage(path.dirname(png), provider));
      return send(res, 200, { tasks });
    }
    if (req.method === "POST" && url.pathname === "/api/regenerate-model") {
      const body = await readBody(req);
      return send(res, 200, menuModelTask(body.path));
    }
    if (req.method === "POST" && url.pathname === "/api/regenerate-models") {
      const body = await readBody(req);
      return send(res, 200, { tasks: childModelTasks(body.path) });
    }
    if (req.method === "GET" && url.pathname === "/api/battle/races") {
      return send(res, 200, {
        races: RACES.map((race) => ({
          id: race.id,
          name: race.name,
          units: race.units.map((unit) => ({
            id: unit.id,
            name: unit.name,
            cost: unit.cost,
            hp: unit.hp,
            atk: unit.atk,
            range: unit.range,
            speed: unit.speed,
            actions: unit.actions,
            cast: unit.cast,
          })),
        })),
        behaviors: BEHAVIORS.map((behavior) => ({ name: behavior.name, body: behavior.body })),
      });
    }
    if (req.method === "GET" && url.pathname === "/api/balance") {
      const raceId = balanceRace(url.searchParams.get("race"));
      const units = catalogStats(raceId);
      return send(res, 200, {
        race: raceId,
        races: RACES.map((race) => ({ id: race.id, name: race.name })),
        units,
        behaviors: BEHAVIORS.map((behavior) => behavior.name),
        limits: LIMITS,
        effects: EFFECTS,
        aims: AIMS,
        maxGames: { duels: MAX_DUEL_GAMES, armies: MAX_ARMY_GAMES },
        warnings: Object.fromEntries(units.map((unit) => [unit.name, warnings(unit)])),
      });
    }
    if (req.method === "POST" && url.pathname === "/api/balance/run") {
      const body = await readBody(req);
      return send(res, 200, runBalance(combat, { ...body, raceId: balanceRace(body.race) }));
    }
    if (req.method === "POST" && url.pathname === "/api/balance/save") {
      const body = await readBody(req);
      const raceId = balanceRace(body.race);
      const saved = saveStats(body.units, {
        catalogPath: path.join(root, "content/catalog.json"),
        rustPath: path.join(root, "crates/combat/src/catalog.rs"),
      }, raceId);
      // The Battle tab and the next comparison read the in-memory catalog: update it so no restart is needed.
      const race = RACES.find((item) => item.id === raceId);
      for (const unit of saved) {
        const entry = race.units.find((item) => item.id === unit.id);
        Object.assign(entry, { cost: unit.cost, hp: unit.hp, atk: unit.atk, range: unit.range, speed: unit.speed, actions: unit.actions, cast: { ...unit.cast } });
      }
      return send(res, 200, { units: catalogStats(raceId) });
    }
    if (req.method === "POST" && url.pathname === "/api/battle/army") {
      const body = await readBody(req);
      const race = body.race == null ? 0 : Number(body.race);
      return send(res, 200, randomArmy(body.ground, Math.random, race));
    }
    if (req.method === "POST" && url.pathname === "/api/battle/fight") {
      const body = await readBody(req);
      const ground = groundById(body.ground);
      if (!ground) throw new Error("unknown battleground");
      assertArmy(ground, body.a);
      assertArmy(ground, body.b);
      return send(res, 200, runFight(combat, { cols: ground.cols, rows: ground.rows, a: body.a, b: body.b }));
    }
    if (req.method === "POST" && url.pathname === "/api/battle/batch") {
      const body = await readBody(req);
      const ground = groundById(body.ground);
      if (!ground) throw new Error("unknown battleground");
      assertArmy(ground, body.army);
      const rounds = body.rounds == null ? 20 : clampRounds(body.rounds);
      return send(res, 200, startBatch(ground, body.army, rounds));
    }
    if (req.method === "GET" && url.pathname === "/api/battle/batch") {
      const batch = battles.get(url.searchParams.get("id"));
      if (!batch) return send(res, 404, { error: "unknown batch" });
      return send(res, 200, battleView(batch));
    }
    if (req.method === "POST" && url.pathname === "/api/battle/batch/stop") {
      const body = await readBody(req);
      const batch = battles.get(String(body.id || ""));
      if (!batch) return send(res, 404, { error: "unknown batch" });
      batch.stop = true;
      return send(res, 200, battleView(batch));
    }
    if (req.method === "POST" && url.pathname === "/api/approve-model") {
      const body = await readBody(req);
      const leaf = resolveLeaf(body.path);
      const name = imageName(assets, leaf);
      approve(path.join(leaf, `${name}.glb`), path.join(leaf, `${name}.approved.glb`));
      return send(res, 200, describeDir(leaf));
    }
    send(res, 404, { error: "not found" });
  } catch (error) {
    send(res, 400, { error: error.message });
  }
});

function studioResponse(body) {
  if (!body || typeof body !== "object") return false;
  const known = (value) => value === "codex" || value === "agent";
  return known(body.provider) && known(body.textProvider);
}

function probeStudio(listenPort) {
  return new Promise((resolve) => {
    const req = http.get({ hostname: "127.0.0.1", port: listenPort, path: "/api/provider", timeout: 1000 }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        if (res.statusCode !== 200) return resolve(false);
        try {
          resolve(studioResponse(JSON.parse(Buffer.concat(chunks).toString())));
        } catch {
          resolve(false);
        }
      });
    });
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
  });
}

function waitForSignal() {
  const keep = setInterval(() => {}, 60_000);
  const stop = () => {
    clearInterval(keep);
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

let listenFailed = false;
server.on("error", (err) => {
  if (listenFailed) return;
  listenFailed = true;
  if (err.code !== "EADDRINUSE") {
    console.error(`asset studio listen failed: ${err.message}`);
    process.exit(1);
  }
  probeStudio(port).then((ours) => {
    if (!ours) {
      console.error(`asset studio cannot listen on 127.0.0.1:${port}: address already in use`);
      process.exit(1);
      return;
    }
    console.log(`asset studio already listening at http://127.0.0.1:${port}`);
    waitForSignal();
  });
});

server.listen(port, "127.0.0.1", () => {
  const bound = server.address().port;
  console.log(`asset studio http://127.0.0.1:${bound}`);
});
