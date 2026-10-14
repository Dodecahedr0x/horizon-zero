import fs from "node:fs";
import path from "node:path";

export function resolveAssetDir(root, rel) {
  const base = path.resolve(root);
  if (typeof rel === "string" && path.isAbsolute(rel)) throw new Error("path escapes assets");
  const dir = path.resolve(base, rel || ".");
  if (dir !== base && !dir.startsWith(base + path.sep)) throw new Error("path escapes assets");
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error("not an asset directory");
  const realBase = fs.realpathSync(base);
  const realDir = fs.realpathSync(dir);
  if (realDir !== realBase && !realDir.startsWith(realBase + path.sep)) throw new Error("path escapes assets");
  return dir;
}

export function imageName(root, dir) {
  const base = path.resolve(root);
  const resolved = path.resolve(dir);
  if (resolved === base) return "world";
  return path.basename(resolved);
}

export function modelRel(root, dir) {
  const name = imageName(root, dir);
  const file = fs.existsSync(path.join(dir, `${name}.approved.glb`))
    ? `${name}.approved.glb`
    : fs.existsSync(path.join(dir, `${name}.glb`))
      ? `${name}.glb`
      : "";
  if (!file) return "";
  const relative = path.relative(root, dir);
  if (!relative || relative === ".") return file;
  return `${relative.split(path.sep).join("/")}/${file}`;
}

export function imageTarget(root, rel) {
  const dir = resolveAssetDir(root, rel);
  if (!fs.existsSync(path.join(dir, "prompt.md"))) throw new Error("not an asset directory");
  const name = imageName(root, dir);
  return { dir, name, png: path.join(dir, `${name}.png`) };
}

export function descendantDirs(root, rel) {
  const start = resolveAssetDir(root, rel);
  const found = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const child = path.join(dir, entry.name);
      found.push(path.relative(root, child));
      visit(child);
    }
  };
  visit(start);
  found.sort((a, b) => a.localeCompare(b));
  return found;
}

export function descendantImagePaths(root, rel) {
  return descendantDirs(root, rel).map((relDir) => imageTarget(root, relDir).png);
}

export function ownPrompt(dir) {
  const file = path.join(dir, "prompt.md");
  if (!fs.existsSync(file)) return "";
  return fs.readFileSync(file, "utf8");
}

export function readPrompt(dir) {
  return ownPrompt(dir).trim();
}

export function writePrompt(root, rel, text) {
  if (typeof text !== "string") throw new Error("prompt must be a string");
  const dir = resolveAssetDir(root, rel);
  fs.writeFileSync(path.join(dir, "prompt.md"), text);
  return dir;
}

export function concatPrompt(root, leaf) {
  return promptChain(root, leaf)
    .map(readPrompt)
    .filter((part) => part.length > 0)
    .join("\n\n");
}

export function parentPrompt(root, dir) {
  const chain = promptChain(root, dir);
  chain.pop();
  return chain
    .map(readPrompt)
    .filter((part) => part.length > 0)
    .join("\n\n");
}

function promptChain(root, dir) {
  const relative = path.relative(root, dir);
  const parts = relative.split(path.sep).filter(Boolean);
  const dirs = [root];
  let cursor = root;
  for (const part of parts) {
    cursor = path.join(cursor, part);
    dirs.push(cursor);
  }
  return dirs;
}

export function assertSlug(name) {
  const slug = typeof name === "string" ? name.trim() : "";
  if (!slug || slug.includes("..") || slug.includes("/") || slug.includes("\\") || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    throw new Error("name must be a lowercase slug");
  }
  return slug;
}

export function createEntity(root, parentRel, name) {
  const slug = assertSlug(name);
  const parent = resolveAssetDir(root, parentRel);
  const dest = containedPath(root, parent, slug);
  if (fs.existsSync(dest)) throw new Error("name already exists");
  fs.mkdirSync(dest);
  fs.writeFileSync(path.join(dest, "prompt.md"), "");
  return dest;
}

export function renameEntity(root, rel, name) {
  const slug = assertSlug(name);
  const dir = resolveAssetDir(root, rel);
  if (isAssetsRoot(root, dir)) throw new Error("cannot rename the assets root");
  const dest = containedPath(root, path.dirname(dir), slug);
  if (dest === path.resolve(dir)) return dir;
  if (fs.existsSync(dest)) throw new Error("name already exists");
  fs.renameSync(dir, dest);
  return dest;
}

export function removeEntity(root, rel) {
  const dir = resolveAssetDir(root, rel);
  if (isAssetsRoot(root, dir)) throw new Error("cannot remove the assets root");
  const parent = path.dirname(dir);
  removeContained(root, dir);
  return parent;
}

function containedPath(root, parent, name) {
  const dest = path.resolve(parent, name);
  const base = path.resolve(root);
  if (dest !== base && !dest.startsWith(base + path.sep)) throw new Error("path escapes assets");
  return dest;
}

function isAssetsRoot(root, dir) {
  return fs.realpathSync(dir) === fs.realpathSync(path.resolve(root));
}

function removeContained(root, target) {
  const base = fs.realpathSync(path.resolve(root));
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink()) {
    const linkPath = path.resolve(target);
    const resolvedRoot = path.resolve(root);
    if (linkPath !== resolvedRoot && !linkPath.startsWith(resolvedRoot + path.sep)) throw new Error("path escapes assets");
    fs.unlinkSync(target);
    return;
  }
  if (stat.isDirectory()) {
    const real = fs.realpathSync(target);
    if (real !== base && !real.startsWith(base + path.sep)) throw new Error("path escapes assets");
    for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
      removeContained(root, path.join(target, entry.name));
    }
    fs.rmdirSync(target);
    return;
  }
  const real = fs.realpathSync(target);
  if (real !== base && !real.startsWith(base + path.sep)) throw new Error("path escapes assets");
  fs.rmSync(target);
}

export function isElement(dir) {
  const children = fs.readdirSync(dir, { withFileTypes: true });
  return !children.some((entry) => entry.isDirectory());
}

export function walk(root, dir = root) {
  const name = path.basename(dir);
  const node = {
    name: dir === root ? "world" : name,
    path: path.relative(root, dir) || ".",
    element: isElement(dir),
    children: [],
  };
  if (!node.element) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) node.children.push(walk(root, path.join(dir, entry.name)));
    }
  }
  return node;
}
