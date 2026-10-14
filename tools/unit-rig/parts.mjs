import { NodeIO } from "@gltf-transform/core";
const io = new NodeIO();
export async function components(file) {
  const doc = await io.read(file);
  const prim = doc.getRoot().listMeshes()[0].listPrimitives()[0];
  const pos = prim.getAttribute("POSITION").getArray();
  const idx = prim.getIndices().getArray();
  const n = pos.length / 3;
  // Merge vertices that share a position (UV seams split them).
  const key = new Map(); const canon = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const k = `${Math.round(pos[3*i]*1e4)},${Math.round(pos[3*i+1]*1e4)},${Math.round(pos[3*i+2]*1e4)}`;
    if (!key.has(k)) key.set(k, i); canon[i] = key.get(k);
  }
  const parent = new Int32Array(n).map((_, i) => i);
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const unite = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[a] = b; };
  for (let t = 0; t < idx.length; t += 3) { const a = canon[idx[t]], b = canon[idx[t+1]], c = canon[idx[t+2]]; unite(a, b); unite(b, c); }
  const groups = new Map();
  for (let t = 0; t < idx.length; t += 3) {
    const r = find(canon[idx[t]]);
    if (!groups.has(r)) groups.set(r, { tris: 0, min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] });
    const g = groups.get(r); g.tris++;
    for (const v of [idx[t], idx[t+1], idx[t+2]]) for (let a = 0; a < 3; a++) { g.min[a] = Math.min(g.min[a], pos[3*v+a]); g.max[a] = Math.max(g.max[a], pos[3*v+a]); }
  }
  return { doc, prim, pos, idx, canon, find, groups: [...groups.entries()].sort((a, b) => b[1].tris - a[1].tris) };
}
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  for (const n of process.argv.slice(2)) {
    const { groups } = await components(`${n}.light.glb`);
    console.log(n, "components", groups.length);
    for (const [, g] of groups.slice(0, 8)) console.log("  tris", g.tris, "min", g.min.map((v) => v.toFixed(2)).join(","), "max", g.max.map((v) => v.toFixed(2)).join(","));
  }
}
