#!/usr/bin/env node
// Generates the trailer described in script.md as one Seedance clip through the ModelArk (Ark) API.
// Usage: node tools/trailer/generate.mjs [--dry-run] [--force] [--model id] [--script path] [--out dir]
import "../../scripts/load-root-env.mjs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const assetsDir = path.join(root, "assets");

const { values: args } = parseArgs({
  options: {
    script: { type: "string", default: path.join(here, "script.md") },
    out: { type: "string", default: path.join(here, "out") },
    model: { type: "string" },
    force: { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
  },
});

const baseUrl = (process.env.ARK_BASE_URL || "https://ark.ap-southeast.bytepluses.com/api/v3").replace(/\/$/, "");
const apiKey = process.env.ARK_API_KEY;
const pollMs = 10_000;
const timeoutMs = 45 * 60_000;

function coerce(value) {
  if (value === "true" || value === "false") return value === "true";
  if (/^-?\d+$/.test(value)) return Number(value);
  return value;
}

export function parseScript(text) {
  const front = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!front) throw new Error("script is missing its --- front matter");
  const config = {};
  for (const line of front[1].split("\n")) {
    const m = line.match(/^(\w+):\s*(.*)$/);
    if (m) config[m[1]] = coerce(m[2].trim());
  }
  const images = Object.keys(config)
    .filter((k) => /^image\d+$/.test(k))
    .sort((a, b) => a.slice(5) - b.slice(5))
    .map((k, i) => {
      if (k !== `image${i + 1}`) throw new Error(`reference images must be numbered image1..imageN without gaps; found ${k}`);
      return config[k];
    });
  const shots = [];
  for (const section of text.slice(front[0].length).split(/^## /m).slice(1)) {
    const heading = section.match(/^(\d+)\.\s*(.+)$/m);
    if (!heading) throw new Error(`shot heading must be "## N. Title": ${section.split("\n")[0]}`);
    const fields = {};
    for (const m of section.matchAll(/^- (\w+):\s*(.+)$/gm)) fields[m[1]] = m[2].trim();
    const prompt = section.match(/```prompt\n([\s\S]*?)\n```/);
    if (!prompt) throw new Error(`shot ${heading[1]} has no \`\`\`prompt block`);
    for (const m of prompt[1].matchAll(/@Image(\d+)/g)) {
      if (!images[m[1] - 1]) throw new Error(`shot ${heading[1]} uses @Image${m[1]}, which the front matter does not define`);
    }
    shots.push({ title: heading[2].trim(), duration: Number(fields.duration ?? 5), voiceover: fields.voiceover, prompt: prompt[1].trim() });
  }
  if (!shots.length) throw new Error("script has no shots");
  return { config, images, shots };
}

// One multi-shot prompt: each shot at its timecode, hard cuts between them, then the clip-wide style and narrator.
export function composePrompt(config, shots) {
  const total = shots.reduce((sum, s) => sum + s.duration, 0);
  const lines = [`A single continuous ${total}-second cinematic trailer made of ${shots.length} shots joined by hard cuts, in this order.`];
  let t = 0;
  shots.forEach((shot, i) => {
    let line = `[${t}s-${t + shot.duration}s] Shot ${i + 1}, ${shot.title}: ${shot.prompt}`;
    if (shot.voiceover) line += ` Voice-over: "${shot.voiceover}"`;
    lines.push(line);
    t += shot.duration;
  });
  if (config.style) lines.push(config.style);
  if (config.narrator) lines.push(`Every voice-over line is spoken by the same ${config.narrator}.`);
  return { text: lines.join("\n\n"), total };
}

function ffmpeg(...argv) {
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...argv], { stdio: "inherit" });
}

function refImage(ref) {
  const dir = path.resolve(assetsDir, ref);
  if (!dir.startsWith(assetsDir + path.sep)) throw new Error(`ref ${ref} is outside assets/`);
  const file = path.join(dir, `${path.basename(dir)}.approved.png`);
  if (!fs.existsSync(file)) throw new Error(`ref ${ref} has no approved image at ${path.relative(root, file)}`);
  // Full-size approved pngs are a few MB each; a 1024px jpeg keeps the request body small.
  // Transparency is flattened onto a neutral grey so dark units stay readable.
  const small = path.join(args.out, "refs", `${ref.replaceAll("/", "-")}.jpg`);
  if (!fs.existsSync(small) || fs.statSync(small).mtimeMs < fs.statSync(file).mtimeMs) {
    fs.mkdirSync(path.dirname(small), { recursive: true });
    ffmpeg("-i", file, "-f", "lavfi", "-i", "color=c=0x808080:s=1024x1024", "-filter_complex",
      "[0:v]scale=1024:1024:force_original_aspect_ratio=decrease[fg];[1:v][fg]overlay=(W-w)/2:(H-h)/2:shortest=1",
      "-frames:v", "1", "-q:v", "3", small);
  }
  return small;
}

function requestBody(script, model) {
  const { config, images, shots } = script;
  const { text, total } = composePrompt(config, shots);
  const content = [{ type: "text", text }];
  for (const ref of images) {
    const data = fs.readFileSync(refImage(ref)).toString("base64");
    content.push({ type: "image_url", role: "reference_image", image_url: { url: `data:image/jpeg;base64,${data}` } });
  }
  const body = { model, content, duration: total };
  for (const key of ["ratio", "resolution", "generate_audio", "watermark", "seed"]) {
    if (config[key] !== undefined) body[key] = config[key];
  }
  return body;
}

async function ark(method, route, body) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${baseUrl}${route}`, {
      method,
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: body && JSON.stringify(body),
    });
    const text = await res.text();
    if (res.ok) return JSON.parse(text);
    if ((res.status === 429 || res.status >= 500) && attempt < 5) {
      await new Promise((r) => setTimeout(r, 5000 * 2 ** attempt));
      continue;
    }
    throw new Error(`${method} ${route} -> ${res.status}: ${text}`);
  }
}

async function waitForVideo(taskId) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeoutMs) {
    const task = await ark("GET", `/contents/generations/tasks/${taskId}`);
    if (task.status !== last) console.log(`task ${taskId}: ${task.status}`);
    last = task.status;
    if (task.status === "succeeded") return task.content.video_url;
    if (["failed", "cancelled", "expired"].includes(task.status)) {
      throw new Error(`task ${task.status}: ${task.error?.message ?? JSON.stringify(task.error ?? {})}`);
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(`timed out; task ${taskId} is recorded in state.json and the next run resumes it`);
}

async function main() {
  const script = parseScript(fs.readFileSync(args.script, "utf8"));
  const model = args.model || process.env.ARK_VIDEO_MODEL || script.config.model;
  if (!model) throw new Error("no model: set it in the script front matter, ARK_VIDEO_MODEL, or --model");
  const body = requestBody(script, model);
  console.log(`${script.shots.length} shots in one ${body.duration}s clip, ${script.images.length} reference images, model ${model}, ${baseUrl}`);

  if (args["dry-run"]) {
    for (const item of body.content) if (item.image_url) item.image_url.url = `<${item.image_url.url.length} chars of base64 jpeg>`;
    console.log(JSON.stringify(body, null, 2));
    return;
  }
  if (!apiKey) throw new Error("ARK_API_KEY is not set (repo .env or environment)");

  const statePath = path.join(args.out, "state.json");
  const videoPath = path.join(args.out, "trailer.mp4");
  const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : {};
  const save = () => fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");
  const hash = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  const same = !args.force && state.hash === hash;

  if (same && state.done && fs.existsSync(videoPath)) {
    console.log(`script unchanged, keeping ${path.relative(root, videoPath)} (--force to regenerate)`);
    return;
  }
  let taskId = same ? state.taskId : undefined;
  if (taskId) console.log(`resuming task ${taskId}`);
  else {
    taskId = (await ark("POST", "/contents/generations/tasks", body)).id;
    Object.assign(state, { hash, taskId, done: false });
    save();
    console.log(`created task ${taskId}`);
  }
  const url = await waitForVideo(taskId);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed with ${res.status}`);
  fs.writeFileSync(videoPath, Buffer.from(await res.arrayBuffer()));
  state.done = true;
  save();
  console.log(`trailer: ${path.relative(root, videoPath)}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
