// Request one extra action on an existing rig and save it as <id>.<action>.glb.
import fs from "node:fs";
const env = fs.readFileSync(new URL("../../.env", import.meta.url), "utf8");
const key = (env.match(/^MESHY_API_KEY=(.*)$/m) || [])[1]?.trim().replace(/^["']|["']$/g, "");
const [id, action] = process.argv.slice(2);
const tasks = JSON.parse(fs.readFileSync(new URL("./tasks.json", import.meta.url), "utf8"));
const rig = tasks[id].rig;
const api = async (p, o = {}) => { const r = await fetch(`https://api.meshy.ai/openapi/v1${p}`, { ...o, headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" } }); const t = await r.text(); if (!r.ok) throw new Error(`${r.status} ${t.slice(0, 300)}`); return JSON.parse(t); };
const extraKey = `extra-${action}`;
tasks[id][extraKey] ||= (await api("/animations", { method: "POST", body: JSON.stringify({ rig_task_id: rig, action_id: Number(action) }) })).result;
fs.writeFileSync(new URL("./tasks.json", import.meta.url), JSON.stringify(tasks, null, 1));
for (let i = 0; i < 120; i++) {
  const t = await api(`/animations/${tasks[id][extraKey]}`);
  if (t.status === "SUCCEEDED") {
    const res = await fetch(t.result.animation_glb_url);
    fs.writeFileSync(`${id}.${action}.glb`, Buffer.from(await res.arrayBuffer()));
    console.log(id, action, "saved,", t.consumed_credits, "credits");
    process.exit(0);
  }
  if (t.status === "FAILED" || t.status === "CANCELED") throw new Error(t.status);
  await new Promise((r) => setTimeout(r, 5000));
}
