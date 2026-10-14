import { NodeIO } from "@gltf-transform/core";
const io = new NodeIO();
export function bbox(arr) { const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity]; for (let i = 0; i < arr.length; i += 3) for (let a = 0; a < 3; a++) { mn[a] = Math.min(mn[a], arr[i+a]); mx[a] = Math.max(mx[a], arr[i+a]); } return [mn, mx]; }
// Uniform scale from height, offsets from the min corner; reports how well the max corner agrees.
export async function fit(n) {
  const body = await io.read(`${n}.body.glb`);
  const rig = await io.read(`${n}-body.anim.glb`);
  const [bmn, bmx] = bbox(body.getRoot().listMeshes()[0].listPrimitives()[0].getAttribute("POSITION").getArray());
  const [rmn, rmx] = bbox(rig.getRoot().listMeshes()[0].listPrimitives()[0].getAttribute("POSITION").getArray());
  const s = (rmx[1] - rmn[1]) / (bmx[1] - bmn[1]);
  const off = [0, 1, 2].map((a) => (rmn[a] + rmx[a]) / 2 - ((bmn[a] + bmx[a]) / 2) * s);
  const err = [0, 1, 2].map((a) => [bmn[a] * s + off[a] - rmn[a], bmx[a] * s + off[a] - rmx[a]]);
  return { s, off, err, rmn, rmx };
}
if (process.argv[1].endsWith("fit.mjs")) for (const n of process.argv.slice(2)) { const f = await fit(n); console.log(n, "scale", f.s.toFixed(5), "offset", f.off.map((v) => v.toFixed(4)), "corner error", f.err.map((e) => e.map((v) => v.toFixed(4)).join("/"))); }
