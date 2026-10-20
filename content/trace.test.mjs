import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { interpretCatalog } from "./interpret.mjs";
import { parseTraceLine, targetsSelf } from "./trace.mjs";
import catalogFile from "./catalog.json" with { type: "json" };

const require = createRequire(import.meta.url);
const { simulate_json } = require("../app/src/combat-node/horizon_combat.js");

test("every line kind parses into named fields", () => {
  assert.deepEqual(parseTraceLine("M 1 0 0 5 0 4"), { kind: "move", line: "M 1 0 0 5 0 4", actor: { side: 1, index: 0 }, from: { col: 0, row: 5 }, to: { col: 0, row: 4 } });
  assert.deepEqual(parseTraceLine("A 0 2 1 0 2 4"), { kind: "attack", line: "A 0 2 1 0 2 4", actor: { side: 0, index: 2 }, target: { side: 1, index: 0 }, damage: 2, hp: 4 });
  const cast = parseTraceLine("C 0 0 1 0 1 5 1 2 0 0 2 0 4");
  assert.equal(cast.kind, "cast");
  assert.equal(cast.effect, "push");
  assert.equal(cast.amount, 2);
  assert.deepEqual([cast.from, cast.to], [{ col: 0, row: 2 }, { col: 0, row: 4 }]);
  assert.ok(targetsSelf(parseTraceLine("C 0 1 0 1 0 4 2 1 1 3 1 3 1")));
  assert.equal(parseTraceLine("X 0 1 3").effect, "reach");
  assert.deepEqual(parseTraceLine("E 1"), { kind: "end", line: "E 1", winner: 1, limit: false, work: false });
  assert.deepEqual(parseTraceLine("E 0 work"), { kind: "end", line: "E 0 work", winner: 0, limit: false, work: true });
  assert.deepEqual(parseTraceLine("E draw limit"), { kind: "end", line: "E draw limit", winner: null, limit: true, work: false });
  assert.deepEqual(parseTraceLine("E draw work"), { kind: "end", line: "E draw work", winner: null, limit: false, work: true });
  assert.equal(parseTraceLine("R").kind, "round");
  assert.equal(parseTraceLine("Q 1").kind, "unknown");
});

test("a real battle parses with no unknown lines and its end matches the winner", () => {
  const catalog = interpretCatalog(catalogFile);
  const castAndStrike = catalog.behaviors.find((item) => item.name === "Charge cast").body;
  const army = catalog.races[0].units.map((unit, index) => ({ kind: unit.id, body: castAndStrike, col: index + 2, row: index % 2, cost: unit.cost, hp: unit.hp, atk: unit.atk, range: unit.range, speed: unit.speed, actions: unit.actions, cast: unit.cast }));
  const result = JSON.parse(simulate_json(JSON.stringify({ cols: 12, rows: 10, a: army, b: army, seed: Array.from({ length: 32 }, (_, i) => i) })));
  const steps = result.lines.map(parseTraceLine);
  assert.deepEqual(steps.filter((step) => step.kind === "unknown"), []);
  const end = steps.at(-1);
  assert.equal(end.kind, "end");
  assert.equal(end.winner, result.winner);
});
