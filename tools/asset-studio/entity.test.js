import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createEntity, removeEntity, renameEntity } from "./prompts.js";

function tempAssets() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hz-entities-"));
  fs.mkdirSync(path.join(root, "units", "guard"), { recursive: true });
  fs.writeFileSync(path.join(root, "prompt.md"), "world\n");
  fs.writeFileSync(path.join(root, "units", "prompt.md"), "units\n");
  fs.writeFileSync(path.join(root, "units", "guard", "prompt.md"), "guard\n");
  return root;
}

test("create rejects traversal, empty names, and sibling collisions", () => {
  const root = tempAssets();
  assert.throws(() => createEntity(root, ".", ".."), /lowercase slug/);
  assert.throws(() => createEntity(root, ".", "foo/bar"), /lowercase slug/);
  assert.throws(() => createEntity(root, ".", ""), /lowercase slug/);
  assert.throws(() => createEntity(root, "..", "slug"), /path escapes assets/);
  assert.throws(() => createEntity(root, "units/../../outside", "slug"), /path escapes assets/);
  const created = createEntity(root, "units", "scout");
  assert.equal(fs.readFileSync(path.join(created, "prompt.md"), "utf8"), "");
  assert.equal(fs.readFileSync(path.join(root, "units", "guard", "prompt.md"), "utf8"), "guard\n");
  assert.throws(() => createEntity(root, "units", "scout"), /name already exists/);
  assert.throws(() => createEntity(root, "units", "guard"), /name already exists/);
});

test("rename rejects the assets root, traversal, and sibling collisions", () => {
  const root = tempAssets();
  const world = fs.readFileSync(path.join(root, "prompt.md"));
  assert.throws(() => renameEntity(root, ".", "elsewhere"), /cannot rename the assets root/);
  assert.deepEqual(fs.readFileSync(path.join(root, "prompt.md")), world);
  assert.throws(() => renameEntity(root, "units/guard", ".."), /lowercase slug/);
  assert.throws(() => renameEntity(root, "units/guard", "a/b"), /lowercase slug/);
  createEntity(root, "units", "scout");
  assert.throws(() => renameEntity(root, "units/scout", "guard"), /name already exists/);
  const png = path.join(root, "units", "guard", "guard.png");
  const glb = path.join(root, "units", "guard", "guard.glb");
  const task = path.join(root, "units", "guard", "guard.meshy.json");
  fs.writeFileSync(png, "png");
  fs.writeFileSync(glb, "glb");
  fs.writeFileSync(task, "{}");
  const renamed = renameEntity(root, "units/guard", "sentinel");
  assert.equal(path.basename(renamed), "sentinel");
  assert.equal(fs.existsSync(path.join(root, "units", "guard")), false);
  assert.equal(fs.readFileSync(path.join(renamed, "prompt.md"), "utf8"), "guard\n");
  assert.equal(fs.readFileSync(path.join(renamed, "guard.png"), "utf8"), "png");
  assert.equal(fs.readFileSync(path.join(renamed, "guard.glb"), "utf8"), "glb");
  assert.equal(fs.readFileSync(path.join(renamed, "guard.meshy.json"), "utf8"), "{}");
  assert.equal(fs.readFileSync(path.join(root, "units", "prompt.md"), "utf8"), "units\n");
  assert.equal(fs.readFileSync(path.join(root, "units", "scout", "prompt.md"), "utf8"), "");
});

test("remove rejects the assets root and does not follow symlinks outside", () => {
  const root = tempAssets();
  const world = fs.readFileSync(path.join(root, "prompt.md"));
  assert.throws(() => removeEntity(root, "."), /cannot remove the assets root/);
  assert.throws(() => removeEntity(root, ".."), /path escapes assets/);
  assert.deepEqual(fs.readFileSync(path.join(root, "prompt.md")), world);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "hz-outside-"));
  const secret = path.join(outside, "secret.txt");
  fs.writeFileSync(secret, "keep");
  fs.symlinkSync(secret, path.join(root, "units", "guard", "leak.txt"));
  fs.symlinkSync(outside, path.join(root, "units", "guard", "outside-dir"));
  const parent = removeEntity(root, "units/guard");
  assert.equal(path.basename(parent), "units");
  assert.equal(fs.existsSync(path.join(root, "units", "guard")), false);
  assert.equal(fs.readFileSync(secret, "utf8"), "keep");
  assert.equal(fs.existsSync(outside), true);
  assert.equal(fs.readFileSync(path.join(root, "units", "prompt.md"), "utf8"), "units\n");
  assert.equal(fs.readFileSync(path.join(root, "prompt.md"), "utf8"), "world\n");
});
