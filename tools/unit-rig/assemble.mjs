// Build the final unit file: rename clips to the board's action names and, for shield units,
// add the shield back as a rigid piece skinned 100% to the nearest hand bone.
import fs from "node:fs";
import { NodeIO } from "@gltf-transform/core";
import { prune, dedup } from "@gltf-transform/functions";
import { fit } from "./fit.mjs";

const io = new NodeIO();
const CLIPS = ["idle", "run", "attack", "cast", "defend", "hit", "death"];
const SHIELDED = new Set(["guard", "warden"]);
const REPLACE = { warden: { attack: "warden-body.219.glb" } };
fs.mkdirSync("final", { recursive: true });

function invertTranslation(m) {
  // Bone position in mesh bind space: translation of inverse(IBM). IBMs here are rigid + uniform scale.
  const r = [[m[0], m[4], m[8]], [m[1], m[5], m[9]], [m[2], m[6], m[10]]];
  const t = [m[12], m[13], m[14]];
  const scale2 = m[0] * m[0] + m[1] * m[1] + m[2] * m[2];
  return [0, 1, 2].map((i) => -(r[0][i] * t[0] + r[1][i] * t[1] + r[2][i] * t[2]) / scale2);
}

for (const n of process.argv.slice(2)) {
  const shielded = SHIELDED.has(n);
  const doc = await io.read(`${n}${shielded ? "-body" : ""}.anim.glb`);
  const root = doc.getRoot();

  const anims = root.listAnimations();
  if (anims.length !== CLIPS.length) throw new Error(`${n}: expected ${CLIPS.length} clips, got ${anims.length}`);
  anims.forEach((anim, i) => anim.setName(CLIPS[i]));

  // Swap a clip for one requested separately on the same rig, matching channels to nodes by name.
  for (const [clip, file] of Object.entries(REPLACE[n] || {})) {
    const donor = await io.read(file);
    const source = donor.getRoot().listAnimations()[0];
    const nodes = new Map(root.listNodes().map((node) => [node.getName(), node]));
    const buffer = root.listBuffers()[0];
    const copy = (acc) => doc.createAccessor().setType(acc.getType()).setArray(acc.getArray().slice()).setBuffer(buffer);
    const anim = doc.createAnimation(clip);
    for (const channel of source.listChannels()) {
      const target = nodes.get(channel.getTargetNode().getName());
      if (!target) continue;
      const sampler = channel.getSampler();
      const copied = doc.createAnimationSampler().setInput(copy(sampler.getInput())).setOutput(copy(sampler.getOutput())).setInterpolation(sampler.getInterpolation());
      anim.addSampler(copied).addChannel(doc.createAnimationChannel().setTargetNode(target).setTargetPath(channel.getTargetPath()).setSampler(copied));
    }
    const old = root.listAnimations().find((item) => item.getName() === clip && item !== anim);
    old.dispose();
    console.log(n, "replaced", clip, "with", file, anim.listChannels().length, "channels");
  }

  if (shielded) {
    const { s, off } = await fit(n);
    const shieldDoc = await io.read(`${n}.shield.glb`);
    const sp = shieldDoc.getRoot().listMeshes()[0].listPrimitives()[0];
    const pos = sp.getAttribute("POSITION").getArray().slice();
    for (let i = 0; i < pos.length; i += 3) for (let a = 0; a < 3; a++) pos[i + a] = pos[i + a] * s + off[a];
    // Grip: pre-rotate so the shield stands upright at the hand on the first idle frame (see grip.html).
    const P = JSON.parse(fs.readFileSync(new URL("./grip.json", import.meta.url), "utf8"))[n];
    const nrm = sp.getAttribute("NORMAL").getArray().slice();
    for (let i = 0; i < pos.length; i += 3) {
      const [x, y, z] = [pos[i], pos[i + 1], pos[i + 2]];
      pos[i] = P[0] * x + P[4] * y + P[8] * z + P[12];
      pos[i + 1] = P[1] * x + P[5] * y + P[9] * z + P[13];
      pos[i + 2] = P[2] * x + P[6] * y + P[10] * z + P[14];
      const [a, b, c] = [nrm[i], nrm[i + 1], nrm[i + 2]];
      nrm[i] = P[0] * a + P[4] * b + P[8] * c;
      nrm[i + 1] = P[1] * a + P[5] * b + P[9] * c;
      nrm[i + 2] = P[2] * a + P[6] * b + P[10] * c;
    }

    const skin = root.listSkins()[0];
    const joints = skin.listJoints();
    const ibm = skin.getInverseBindMatrices().getArray();
    const centroid = [0, 1, 2].map((a) => { let sum = 0; for (let i = a; i < pos.length; i += 3) sum += pos[i]; return sum / (pos.length / 3); });
    let best = -1, bestDist = Infinity;
    joints.forEach((joint, j) => {
      if (joint.getName() !== "LeftHand") return;
      const p = invertTranslation(ibm.slice(j * 16, j * 16 + 16));
      const d = Math.hypot(p[0] - centroid[0], p[1] - centroid[1], p[2] - centroid[2]);
      if (d < bestDist) { bestDist = d; best = j; }
    });
    console.log(n, "shield rides", joints[best].getName(), "at", bestDist.toFixed(3));

    const count = pos.length / 3;
    const buffer = root.listBuffers()[0];
    const make = (type, array) => doc.createAccessor().setType(type).setArray(array).setBuffer(buffer);
    const jointsArr = new Uint16Array(count * 4);
    const weightsArr = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) { jointsArr[4 * i] = best; weightsArr[4 * i] = 1; }

    const image = shieldDoc.getRoot().listTextures()[0];
    const texture = doc.createTexture("shield").setImage(image.getImage()).setMimeType(image.getMimeType());
    const bodyMaterial = root.listMeshes()[0].listPrimitives()[0].getMaterial();
    const material = doc.createMaterial("shield")
      .setBaseColorTexture(texture)
      .setMetallicFactor(bodyMaterial ? bodyMaterial.getMetallicFactor() : 0)
      .setRoughnessFactor(bodyMaterial ? bodyMaterial.getRoughnessFactor() : 1);
    const prim = doc.createPrimitive()
      .setAttribute("POSITION", make("VEC3", pos))
      .setAttribute("NORMAL", make("VEC3", nrm))
      .setAttribute("TEXCOORD_0", make("VEC2", sp.getAttribute("TEXCOORD_0").getArray().slice()))
      .setAttribute("JOINTS_0", make("VEC4", jointsArr))
      .setAttribute("WEIGHTS_0", make("VEC4", weightsArr))
      .setIndices(make("SCALAR", sp.getIndices().getArray().slice()))
      .setMaterial(material);
    root.listMeshes()[0].addPrimitive(prim);
  }

  await doc.transform(dedup(), prune());
  await io.write(`final/${n}.glb`, doc);
  const size = fs.statSync(`final/${n}.glb`).size;
  console.log(n, "final", (size / 1e6).toFixed(2), "MB, clips", root.listAnimations().map((a) => a.getName()).join(","));
}
