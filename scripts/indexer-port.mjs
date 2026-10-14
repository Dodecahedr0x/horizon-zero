// Local indexer listen port. Reads INDEXER_PORT from the process, then the
// repo-root .env, then 4714. Does not read or set PORT: that variable is shared
// by other processes, and Render injects it on the indexer service.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function indexerListenPort() {
  const fromProcess = process.env.INDEXER_PORT;
  if (fromProcess) return fromProcess;
  const fromFile = readIndexerPort(path.join(root, ".env"));
  return fromFile || "4714";
}

function readIndexerPort(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice("export ".length).trim();
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    if (line.slice(0, eq).trim() !== "INDEXER_PORT") continue;
    let value = line.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    return value;
  }
  return "";
}
