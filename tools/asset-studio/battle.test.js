import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { BEHAVIORS, MAX_UNITS, RACES, applyBehavior, applyKind, assertArmy, describeStep, groundById, randomArmy, runFight, sideResult } from "./battle.js";
import { eventShown, stepActor } from "./event-list.js";

const require = createRequire(import.meta.url);
const combat = require("../../app/src/combat-node/horizon_combat.js");

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let next = state;
    next = Math.imul(next ^ (next >>> 15), next | 1);
    next ^= next + Math.imul(next ^ (next >>> 7), next | 61);
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296;
  };
}

test("a random Rootborn or Deeplings army uses only its race's kinds and stays inside the budget", () => {
  const rng = mulberry32(11);
  for (const [raceId, raceName] of [[1, "Rootborn"], [2, "Deeplings"]]) {
    for (const id of ["outpost", "garrison", "citadel"]) {
      const ground = groundById(id);
      const army = randomArmy(id, rng, raceId);
      assert.equal(army.raceName, raceName);
      assert.equal(assertArmy(ground, army.units), army.cost);
      assert.ok(army.units.length >= 1 && army.units.length <= MAX_UNITS);
      for (const unit of army.units) {
        assert.equal(unit.race, raceId);
        assert.ok(RACES[raceId].units.some((kind) => kind.id === unit.kind && kind.name === unit.name));
      }
    }
  }
});

test("a random army stays inside the battleground rules", () => {
  const rng = mulberry32(7);
  for (const id of ["outpost", "garrison", "citadel"]) {
    const ground = groundById(id);
    const army = randomArmy(id, rng);
    assert.equal(army.raceName, "Ashborn");
    assert.equal(assertArmy(ground, army.units), army.cost);
    assert.ok(army.units.length >= 1 && army.units.length <= MAX_UNITS);
    assert.ok(army.cost <= ground.budget);
    const tiles = new Set(army.units.map((unit) => `${unit.col},${unit.row}`));
    assert.equal(tiles.size, army.units.length);
    for (const unit of army.units) {
      assert.ok(RACES[0].units.some((kind) => kind.id === unit.kind));
      assert.equal(unit.race, 0);
      const behavior = BEHAVIORS.find((item) => item.name === unit.behavior);
      assert.ok(behavior);
      assert.deepEqual(unit.body, behavior.body);
      assert.equal(unit.body[1], 1);
      assert.equal(unit.body[5], 0);
      assert.ok(unit.body[6] === 0 || unit.body[6] === 1);
    }
  }
});

test("two generated armies fight through simulate_json", () => {
  const rng = mulberry32(11);
  const armyA = randomArmy("outpost", rng);
  const armyB = randomArmy("outpost", rng);
  const result = runFight(combat, {
    cols: 8,
    rows: 6,
    a: armyA.units,
    b: armyB.units,
    seed: Array.from({ length: 32 }, () => 4),
  });
  assert.ok(result.lines.length > 0);
  assert.match(result.lines.at(-1), /^E /);
  assert.equal(result.sentences.length, result.lines.length);
  assert.match(result.sentences.at(-1), /^(Side A wins\.|Side B wins\.|Draw\.|Draw\. Round limit reached\.)$/);
  for (const sentence of result.sentences) {
    assert.doesNotMatch(sentence, /^[MACFDR] /);
    assert.doesNotMatch(sentence, /^E /);
  }
  assert.equal(result.result, sideResult(result.outcome));
  assert.ok(result.outcome === "A" || result.outcome === "B" || result.outcome === "draw");
  assert.equal(result.seed, "04".repeat(32));
  assert.ok(Array.isArray(result.blocked));
});

test("trace lines become sentences", () => {
  const sideA = [
    { name: "Skirmisher", kind: 1 },
    { name: "Warden", kind: 4 },
    { name: "Archer", kind: 2 },
    { name: "Archer", kind: 2 },
  ];
  const sideB = [{ name: "Guard", kind: 0 }, { name: "Archer", kind: 2 }, { name: "Vanguard", kind: 3 }];
  assert.equal(describeStep("M 0 0 1 0 2 0", sideA, sideB), "Side A Skirmisher 1 walks from (1,0) to (2,0). There is no target.");
  assert.equal(describeStep("A 1 1 1 0 2 4", sideA, sideB), "Side B Archer 1 attacks Side B Guard 1 for 2");
  assert.equal(describeStep("A 0 3 1 0 2 4", sideA, sideB), "Side A Archer 2 attacks Side B Guard 1 for 2");
  assert.equal(describeStep("C 1 1 1 0 2 4 0 0 0 1 2 1 2", sideA, sideB), "Side B Archer 1 casts on Side B Guard 1 for 2");
  assert.equal(
    describeStep("C 1 0 0 0 1 5 1 1 0 0 2 0 3", sideA, sideB),
    "Side B Guard 1 casts on Side A Skirmisher 1 for 1 and shoves them from (0,2) to (0,3)",
  );
  assert.equal(
    describeStep("C 1 0 0 0 1 5 1 0 0 0 2 0 2", sideA, sideB),
    "Side B Guard 1 casts on Side A Skirmisher 1 for 1 and shoves them, but they stay",
  );
  assert.equal(describeStep("C 0 0 0 0 0 4 2 1 1 1 0 1 0", sideA, sideB), "Side A Skirmisher 1 casts on itself: 2x movement for 1 round");
  assert.equal(describeStep("C 1 1 1 0 0 6 5 2 0 0 2 0 2", sideA, sideB), "Side B Archer 1 casts on Side B Guard 1: heals 2 (now 6 HP)");
  assert.equal(describeStep("X 0 0 2", sideA, sideB), "Side A Skirmisher 1: sprint ends");
  assert.equal(describeStep("F 0 1", sideA, sideB), "Side A Warden 1 defends. There is no target.");
  assert.equal(describeStep("D 1 2", sideA, sideB), "Side B Vanguard 1 dies");
  assert.equal(describeStep("R", sideA, sideB), "Round ends");
  assert.equal(describeStep("E draw limit", sideA, sideB), "Draw. Round limit reached.");
  assert.equal(describeStep("E 0", sideA, sideB), "Side A wins.");
  assert.equal(sideResult("A"), "win");
  assert.equal(sideResult("B"), "loss");
  assert.equal(sideResult("draw"), "draw");
  const vanguard = stepActor("D 1 2", sideA, sideB);
  assert.deepEqual(vanguard, { team: "B", side: 1, index: 2, label: "Vanguard 1" });
  assert.equal(stepActor("M 0 0 1 0 2 0", sideA, sideB).label, "Skirmisher 1");
  assert.equal(stepActor("R", sideA, sideB), null);
  assert.equal(stepActor("E draw limit", sideA, sideB), null);
  assert.equal(stepActor("E 0", sideA, sideB), null);
  const teamB = { type: "team", team: "B" };
  const unit = { type: "unit", team: "B", index: 2 };
  const otherUnit = { type: "unit", team: "A", index: 0 };
  assert.equal(eventShown(vanguard, []), true);
  assert.equal(eventShown(null, [teamB]), true);
  assert.equal(eventShown(vanguard, [teamB]), true);
  assert.equal(eventShown(vanguard, [{ type: "team", team: "A" }]), false);
  assert.equal(eventShown(vanguard, [unit]), true);
  assert.equal(eventShown(null, [unit]), false);
  assert.equal(eventShown(vanguard, [teamB, unit]), true);
  assert.equal(eventShown(vanguard, [{ type: "team", team: "A" }, unit]), false);
  assert.equal(eventShown(vanguard, [unit, otherUnit]), false);
  assert.equal(eventShown(null, [teamB, unit]), false);
});

test("kind and behavior edits use the catalog", () => {
  const ground = groundById("outpost");
  const guard = RACES[0].units[0];
  const units = [0, 1, 2, 3].map((col) => ({
    kind: guard.id,
    name: guard.name,
    race: 0,
    behavior: "March",
    body: BEHAVIORS[0].body.slice(),
    col,
    row: 0,
    cost: guard.cost,
    hp: guard.hp,
    atk: guard.atk,
    range: guard.range,
    speed: guard.speed,
    cast: { ...guard.cast },
  }));
  assert.throws(() => applyKind(ground, units, 0, 4), /budget/);
  const skirmisher = RACES[0].units[1];
  const changed = applyKind(ground, units.slice(0, 2), 0, skirmisher.id);
  assert.equal(changed.cost, guard.cost + skirmisher.cost);
  assert.equal(changed.units[0].name, "Skirmisher");
  assert.equal(changed.units[0].hp, skirmisher.hp);
  assert.equal(changed.units[0].speed, skirmisher.speed);
  assert.deepEqual(changed.units[0].cast, skirmisher.cast);
  assert.equal(changed.units[1].name, "Guard");
  const cast = applyBehavior(changed.units, 1, "March cast");
  assert.equal(cast[1].behavior, "March cast");
  assert.deepEqual(cast[1].body, BEHAVIORS.find((item) => item.name === "March cast").body);
  assert.equal(cast[1].body.includes(undefined), false);
  const march = applyBehavior(cast, 0, "March");
  assert.equal(march[0].body[5], 0);
  assert.equal(march[0].body[6], 1);
  assert.equal(BEHAVIORS.some((item) => item.name === "Volley"), false);
});
