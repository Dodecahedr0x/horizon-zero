import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { interpretCatalog } from "./interpret.mjs";

const defaultFile = path.join(path.dirname(fileURLToPath(import.meta.url)), "catalog.json");

export function catalogPath(file = defaultFile) {
  return path.resolve(file);
}

export function loadCatalog(file = defaultFile) {
  const full = catalogPath(file);
  if (!fs.existsSync(full)) throw new Error(`content catalog is missing: ${full}`);
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(full, "utf8"));
  } catch (err) {
    throw new Error(`content catalog ${full} is not valid JSON: ${err.message}`);
  }
  return interpretCatalog(raw);
}
