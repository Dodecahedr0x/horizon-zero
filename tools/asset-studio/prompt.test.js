import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { concatPrompt, descendantImagePaths, imageTarget, modelRel, parentPrompt, writePrompt } from "./prompts.js";

test("concatenates prompt.md from the root down to the leaf", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hz-prompts-"));
  fs.mkdirSync(path.join(root, "units", "guard"), { recursive: true });
  fs.writeFileSync(path.join(root, "prompt.md"), "world");
  fs.writeFileSync(path.join(root, "units", "prompt.md"), "units");
  fs.writeFileSync(path.join(root, "units", "guard", "prompt.md"), "guard");
  assert.equal(concatPrompt(root, path.join(root, "units", "guard")), "world\n\nunits\n\nguard");
  assert.equal(concatPrompt(root, path.join(root, "units")), "world\n\nunits");
  assert.equal(parentPrompt(root, path.join(root, "units", "guard")), "world\n\nunits");
  assert.equal(parentPrompt(root, root), "");
});

test("generate accepts a parent path and a leaf in that folder", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hz-image-path-"));
  fs.mkdirSync(path.join(root, "units", "guard"), { recursive: true });
  fs.mkdirSync(path.join(root, "board"));
  fs.writeFileSync(path.join(root, "prompt.md"), "world\n");
  fs.writeFileSync(path.join(root, "units", "prompt.md"), "units\n");
  fs.writeFileSync(path.join(root, "units", "guard", "prompt.md"), "guard\n");
  fs.writeFileSync(path.join(root, "board", "prompt.md"), "board\n");
  const units = imageTarget(root, "units");
  const guard = imageTarget(root, "units/guard");
  const world = imageTarget(root, ".");
  assert.equal(units.png, path.join(root, "units", "units.png"));
  assert.equal(guard.png, path.join(root, "units", "guard", "guard.png"));
  assert.equal(world.png, path.join(root, "world.png"));
  assert.equal(concatPrompt(root, units.dir), "world\n\nunits");
  assert.throws(() => imageTarget(root, "../outside"), /path escapes assets/);
  assert.throws(() => imageTarget(root, "units/../../outside"), /path escapes assets/);
});

test("a parent with two leaf descendants expands to those two image paths", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hz-descendants-"));
  const camp = path.join(root, "camp");
  fs.mkdirSync(path.join(camp, "guard"), { recursive: true });
  fs.mkdirSync(path.join(camp, "archer"), { recursive: true });
  fs.writeFileSync(path.join(camp, "prompt.md"), "camp\n");
  fs.writeFileSync(path.join(camp, "guard", "prompt.md"), "guard\n");
  fs.writeFileSync(path.join(camp, "archer", "prompt.md"), "archer\n");
  const paths = descendantImagePaths(root, "camp");
  assert.deepEqual(paths, [
    path.join(camp, "archer", "archer.png"),
    path.join(camp, "guard", "guard.png"),
  ]);
  assert.equal(paths.includes(path.join(camp, "camp.png")), false);
  fs.mkdirSync(path.join(camp, "north", "warden"), { recursive: true });
  fs.writeFileSync(path.join(camp, "north", "prompt.md"), "north\n");
  fs.writeFileSync(path.join(camp, "north", "warden", "prompt.md"), "warden\n");
  const nested = descendantImagePaths(root, "camp");
  assert.deepEqual(nested, [
    path.join(camp, "archer", "archer.png"),
    path.join(camp, "guard", "guard.png"),
    path.join(camp, "north", "north.png"),
    path.join(camp, "north", "warden", "warden.png"),
  ]);
  assert.equal(nested.includes(path.join(camp, "camp.png")), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test("saving one level writes that prompt.md and leaves the sibling unchanged", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hz-prompts-"));
  const guard = path.join(root, "units", "guard");
  const archer = path.join(root, "units", "archer");
  fs.mkdirSync(guard, { recursive: true });
  fs.mkdirSync(archer, { recursive: true });
  fs.writeFileSync(path.join(root, "prompt.md"), "world");
  fs.writeFileSync(path.join(root, "units", "prompt.md"), "units");
  fs.writeFileSync(path.join(archer, "prompt.md"), "archer");
  const unitsBefore = fs.readFileSync(path.join(root, "units", "prompt.md"));
  const archerBefore = fs.readFileSync(path.join(archer, "prompt.md"));
  writePrompt(root, "units/guard", "guard revised");
  assert.equal(fs.readFileSync(path.join(guard, "prompt.md"), "utf8"), "guard revised");
  assert.deepEqual(fs.readFileSync(path.join(root, "units", "prompt.md")), unitsBefore);
  assert.deepEqual(fs.readFileSync(path.join(archer, "prompt.md")), archerBefore);
  assert.equal(concatPrompt(root, guard), "world\n\nunits\n\nguard revised");
  assert.equal(concatPrompt(root, archer), "world\n\nunits\n\narcher");
  assert.throws(() => writePrompt(root, "../outside", "nope"), /path escapes assets/);
});

test("model url for units/ashborn/warden is the glb in that folder", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hz-model-url-"));
  const dir = path.join(root, "units", "ashborn", "warden");
  fs.mkdirSync(dir, { recursive: true });
  assert.equal(modelRel(root, dir), "");
  fs.writeFileSync(path.join(dir, "warden.glb"), "candidate");
  assert.equal(modelRel(root, dir), "units/ashborn/warden/warden.glb");
  fs.writeFileSync(path.join(dir, "warden.approved.glb"), "approved");
  assert.equal(modelRel(root, dir), "units/ashborn/warden/warden.approved.glb");
  fs.rmSync(path.join(dir, "warden.glb"));
  assert.equal(modelRel(root, dir), "units/ashborn/warden/warden.approved.glb");
});
