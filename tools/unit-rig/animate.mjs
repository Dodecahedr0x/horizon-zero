// Rig each simplified unit with Meshy, then request one merged animation file per unit.
// Task ids are saved to tasks.json after every step so a rerun resumes instead of paying twice.
import fs from "node:fs";

import { pathToFileURL } from "node:url";
// Model files are read and written in the current directory (tools/unit-rig/work); task ids live beside this script.
const here = pathToFileURL(`${process.cwd()}/`);
const env = fs.readFileSync(new URL("../../.env", import.meta.url), "utf8");
const key = (env.match(/^MESHY_API_KEY=(.*)$/m) || [])[1]?.trim().replace(/^["']|["']$/g, "");
if (!key) throw new Error("MESHY_API_KEY missing");
const API = "https://api.meshy.ai/openapi/v1";

// Order matters: clips are renamed in this order after download.
export const CLIPS = ["idle", "run", "attack", "cast", "defend", "hit", "death"];
const UNITS = {
  guard: { height: 1.8, actions: [89, 14, 240, 220, 138, 178, 187] },
  skirmisher: { height: 1.75, actions: [89, 14, 92, 91, 147, 178, 189] },
  archer: { height: 1.75, actions: [0, 14, 224, 222, 150, 179, 183] },
  vanguard: { height: 1.9, actions: [89, 14, 242, 127, 149, 178, 187] },
  warden: { height: 2.1, actions: [0, 14, 128, 255, 139, 171, 188] },
  // Rootborn: Reaping Swing and Axe Spin Attack for the thorn burst; Baseball Pitching and
  // Crouch Charge and Throw for the thorn sling; Heavy Hammer Swing and Charged Spell Cast for the heal.
  thornling: { height: 2.2, actions: [89, 14, 99, 238, 138, 178, 187] },
  briarsling: { height: 2.2, actions: [0, 14, 393, 398, 140, 179, 189] },
  elderoak: { height: 2.8, actions: [0, 14, 128, 125, 139, 171, 188] },
  // Deeplings: Kung Fu Punch and Charged Axe Chop for the claw; Left Slash and Crouch Pull and Throw for the
  // snare; Baseball Pitching and Crouch Charge and Throw for the spines; Mage Spell Casts for the tide.
  clawling: { height: 1.6, actions: [89, 14, 96, 237, 138, 178, 187] },
  eelsnare: { height: 1.8, actions: [89, 14, 97, 239, 147, 178, 189] },
  spineshot: { height: 1.5, actions: [0, 14, 393, 398, 140, 179, 183] },
  tidecaller: { height: 2.0, actions: [0, 14, 129, 125, 139, 171, 188] },
};

const tasksFile = new URL("./tasks.json", import.meta.url);
const tasks = fs.existsSync(tasksFile) ? JSON.parse(fs.readFileSync(tasksFile, "utf8")) : {};
const save = () => fs.writeFileSync(tasksFile, JSON.stringify(tasks, null, 1));

async function api(path, options = {}) {
  const res = await fetch(`${API}${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${options.method || "GET"} ${path} -> ${res.status} ${text.slice(0, 400)}`);
  return JSON.parse(text);
}

async function poll(path, label) {
  for (let i = 0; i < 360; i += 1) {
    const task = await api(path);
    if (task.status === "SUCCEEDED") return task;
    if (task.status === "FAILED" || task.status === "CANCELED") {
      throw new Error(`${label} ${task.status}: ${JSON.stringify(task.task_error || {}).slice(0, 300)}`);
    }
    if (i % 6 === 0) console.log(`${label} ${task.status} ${task.progress ?? ""}%`);
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error(`${label} timed out`);
}

async function download(url, file) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download ${res.status}`);
  fs.writeFileSync(new URL(file, here), Buffer.from(await res.arrayBuffer()));
}

async function run(arg) {
  const [name, src = "light"] = arg.split(":");
  const spec = UNITS[name];
  const id = src === "light" ? name : `${name}-${src}`;
  const record = (tasks[id] ||= {});
  if (!record.rig) {
    const glb = fs.readFileSync(new URL(`./${name}.${src}.glb`, here));
    const created = await api("/rigging", {
      method: "POST",
      body: JSON.stringify({ model_url: `data:model/gltf-binary;base64,${glb.toString("base64")}`, height_meters: spec.height }),
    });
    record.rig = created.result;
    save();
    console.log(`${id} rig task created`);
  }
  const rig = await poll(`/rigging/${record.rig}`, `${name} rig`);
  record.rigCredits = rig.consumed_credits;
  save();
  if (!fs.existsSync(new URL(`./${id}.rigged.glb`, here))) await download(rig.result.rigged_character_glb_url, `${id}.rigged.glb`);
  if (!record.anim) {
    const created = await api("/animations", {
      method: "POST",
      body: JSON.stringify({ rig_task_id: record.rig, action_ids: spec.actions }),
    });
    record.anim = created.result;
    save();
    console.log(`${id} animation task created`);
  }
  const anim = await poll(`/animations/${record.anim}`, `${name} anim`);
  record.animCredits = anim.consumed_credits;
  record.actions = spec.actions;
  save();
  await download(anim.result.animation_glb_url, `${id}.anim.glb`);
  console.log(`${id} done (rig ${record.rigCredits} + anim ${record.animCredits} credits)`);
}

const only = process.argv.slice(2);
const names = only.length ? only : Object.keys(UNITS);
const results = await Promise.allSettled(names.map(run));
results.forEach((r, i) => console.log(names[i], r.status, r.status === "rejected" ? r.reason.message : ""));
