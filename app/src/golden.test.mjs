import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { createRequire } from "node:module";
import { STANDARDS, encodeBehavior, unitSpec } from "./codec.ts";

const require = createRequire(import.meta.url);
const { simulate_json } = require("./combat-node/horizon_combat.js");

test("wasm trace matches the advance golden vector", () => {
  const golden = fs.readFileSync(new URL("../../crates/combat/golden/advance.txt", import.meta.url), "utf8").trim();
  const guard = unitSpec(0, 0);
  const unit = {
    kind: 0,
    body: encodeBehavior(STANDARDS.find((item) => item.name === "March").elements),
    col: 0,
    row: 0,
    cost: guard.cost,
    hp: guard.hp,
    atk: guard.atk,
    range: guard.range,
    speed: guard.speed,
    actions: guard.actions,
    cast: guard.cast,
  };
  const raw = simulate_json(JSON.stringify({
    cols: 8,
    rows: 6,
    a: [unit],
    b: [unit],
    seed: Array.from({ length: 32 }, () => 9),
  }));
  const parsed = JSON.parse(raw);
  assert.equal(parsed.winner, 1);
  assert.equal(parsed.lines.join("\n"), golden);
});
