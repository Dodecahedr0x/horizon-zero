// Split a unit mesh into body and shield by a triangle test, writing <n>.body.glb and <n>.shield.glb.
import { NodeIO } from "@gltf-transform/core";
import { compactPrimitive, prune } from "@gltf-transform/functions";
import { components } from "./parts.mjs";
const io = new NodeIO();
const [n, mode, value] = process.argv.slice(2);
const { groups, idx, pos, canon, find } = await components(`${n}.light.glb`);
let inShield;
if (mode === "component") {
  const root = groups[Number(value)][0];
  inShield = (t) => find(canon[idx[t]]) === root;
} else if (mode === "darkx>") {
  // Past the x cut, above the feet, and dark in the albedo texture (metal, not the white cloak).
  const sharp = (await import("sharp")).default;
  const doc = await io.read(`${n}.light.glb`);
  const prim = doc.getRoot().listMeshes()[0].listPrimitives()[0];
  const uv = prim.getAttribute("TEXCOORD_0").getArray();
  const tex = doc.getRoot().listTextures()[0];
  const { data, info } = await sharp(Buffer.from(tex.getImage())).raw().toBuffer({ resolveWithObject: true });
  const lum = (u, v) => {
    const x = Math.min(info.width - 1, Math.max(0, Math.floor(u * info.width)));
    const y = Math.min(info.height - 1, Math.max(0, Math.floor(v * info.height)));
    const o = (y * info.width + x) * info.channels;
    return (0.2126 * data[o] + 0.7152 * data[o + 1] + 0.0722 * data[o + 2]) / 255;
  };
  const cut = Number(value);
  inShield = (t) => {
    const a = idx[t], b = idx[t+1], c = idx[t+2];
    const cx = (pos[3*a] + pos[3*b] + pos[3*c]) / 3;
    const cy = (pos[3*a+1] + pos[3*b+1] + pos[3*c+1]) / 3;
    if (cx <= cut || cy < -0.85) return false;
    const l = (lum(uv[2*a], uv[2*a+1]) + lum(uv[2*b], uv[2*b+1]) + lum(uv[2*c], uv[2*c+1])) / 3;
    return l < 0.42;
  };
} else {
  // mode "x>": triangle centroid x beyond the value.
  const cut = Number(value);
  inShield = (t) => (pos[3*idx[t]] + pos[3*idx[t+1]] + pos[3*idx[t+2]]) / 3 > cut;
}
// Second pass: small disconnected leftovers on the shield side follow the shield.
const shieldTri = new Uint8Array(idx.length / 3);
for (let t = 0; t < idx.length; t += 3) shieldTri[t / 3] = inShield(t) ? 1 : 0;
if (mode !== "component") {
  const parent = new Int32Array(pos.length / 3).map((_, i) => i);
  const root = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  for (let t = 0; t < idx.length; t += 3) {
    if (shieldTri[t / 3]) continue;
    const a = root(canon[idx[t]]), b = root(canon[idx[t+1]]), c = root(canon[idx[t+2]]);
    parent[a] = c; parent[b] = c;
  }
  const stats = new Map();
  for (let t = 0; t < idx.length; t += 3) {
    if (shieldTri[t / 3]) continue;
    const r = root(canon[idx[t]]);
    const s = stats.get(r) || { tris: 0, x: 0 };
    s.tris++; s.x += (pos[3*idx[t]] + pos[3*idx[t+1]] + pos[3*idx[t+2]]) / 3;
    stats.set(r, s);
  }
  const largest = Math.max(...[...stats.values()].map((s) => s.tris));
  let moved = 0;
  for (let t = 0; t < idx.length; t += 3) {
    if (shieldTri[t / 3]) continue;
    const s = stats.get(root(canon[idx[t]]));
    if (s.tris < largest * 0.08 && s.x / s.tris > Number(value) - 0.15) { shieldTri[t / 3] = 1; moved++; }
  }
  console.log(n, "moved", moved, "leftover triangles to the shield");
}
for (const part of ["body", "shield"]) {
  const doc = await io.read(`${n}.light.glb`);
  const prim = doc.getRoot().listMeshes()[0].listPrimitives()[0];
  const keep = [];
  for (let t = 0; t < idx.length; t += 3) if ((shieldTri[t / 3] === 1) === (part === "shield")) keep.push(idx[t], idx[t+1], idx[t+2]);
  prim.getIndices().setArray(new Uint32Array(keep));
  compactPrimitive(prim);
  await doc.transform(prune());
  await io.write(`${n}.${part}.glb`, doc);
  console.log(n, part, keep.length / 3, "triangles");
}
