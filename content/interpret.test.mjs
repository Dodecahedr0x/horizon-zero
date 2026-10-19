import assert from "node:assert/strict";
import test from "node:test";
import { loadCatalog } from "./load.mjs";
import { MAX_BEHAVIOR_NAME_LEN, clipBehaviorName, encodeBehavior, nameBehavior, parseBehavior } from "./interpret.mjs";

const standards = loadCatalog().behaviors;
const nearest = { stat: 0, extremum: 0, side: 0 };

test("a custom behavior gets a short name, not its full description", () => {
  const elements = [
    { movement: { kind: 0, ...nearest, stop: 1 }, actions: [{ verb: 0, ...nearest }] },
    { movement: null, actions: [] },
  ];
  assert.equal(nameBehavior(elements, standards), "Approach, attack · Wait");
});

test("targets are named only when they are not the nearest foe or the movement's", () => {
  const weakest = { stat: 1, extremum: 0, side: 0 };
  assert.equal(
    nameBehavior([{ movement: { kind: 3, ...nearest, stop: 0 }, actions: [{ verb: 0, ...weakest }] }], standards),
    "Flank right, attack weakest foe",
  );
  const weakestAlly = { stat: 1, extremum: 0, side: 1 };
  assert.equal(
    nameBehavior([{ movement: { kind: 0, ...weakestAlly, stop: 0 }, actions: [{ verb: 1, ...weakestAlly }] }], standards),
    "Approach weakest ally, cast",
  );
  assert.equal(nameBehavior([{ movement: null, actions: [{ verb: 1, ...weakestAlly }] }], standards), "Cast weakest ally");
});

test("standard behaviors keep their catalog names", () => {
  for (const standard of standards) assert.equal(nameBehavior(standard.elements, standards), standard.name);
});

test("no generated name is longer than the cap", () => {
  let state = 7;
  const next = (bound) => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state % bound;
  };
  const spec = () => ({ stat: next(3), extremum: next(2), side: next(2) });
  for (let round = 0; round < 2000; round += 1) {
    const elements = Array.from({ length: 1 + next(4) }, () => ({
      movement: next(4) ? { kind: next(4), ...spec(), stop: next(2) } : null,
      actions: Array.from({ length: next(4) }, () => ({ verb: next(2), ...spec() })),
    }));
    if (!encodeBehavior(elements)) continue;
    const name = nameBehavior(elements, standards);
    assert.ok(name.length > 0 && name.length <= MAX_BEHAVIOR_NAME_LEN, `${name.length}: ${name}`);
  }
});

test("a long stored name is cut at a word with an ellipsis", () => {
  const clipped = clipBehaviorName("Approach Lowest Distance Enemy, Stop if an action triggers, Attack Lowest Distance Enemy · Wait");
  assert.ok(clipped.length <= MAX_BEHAVIOR_NAME_LEN);
  assert.equal(clipped, "Approach Lowest Distance Enemy…");
  assert.equal(clipBehaviorName("March"), "March");
});

test("parse and encode take only integer bytes inside each field's range", () => {
  const good = [1, 1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0];
  assert.deepEqual(encodeBehavior(parseBehavior(good)), good);
  for (let index = 0; index < good.length; index += 1) {
    for (const bad of [-1, 0.5, "0", undefined, null, Number.NaN, 9]) {
      const body = good.slice();
      body[index] = bad;
      assert.equal(parseBehavior(body), null, `byte ${index} = ${String(bad)}`);
    }
  }
  const element = () => ({ movement: { kind: 0, extremum: 0, stat: 0, side: 0, stop: 1 }, actions: [{ verb: 0, extremum: 0, stat: 0, side: 0 }] });
  assert.deepEqual(encodeBehavior([element()]), good);
  for (const field of ["kind", "extremum", "stat", "side", "stop"]) {
    for (const bad of [-1, 0.5, "0", undefined, 4]) {
      const elements = [element()];
      elements[0].movement[field] = bad;
      assert.equal(encodeBehavior(elements), null, `movement.${field} = ${String(bad)}`);
    }
  }
  for (const field of ["verb", "extremum", "stat", "side"]) {
    for (const bad of [-1, 0.5, "0", undefined, 3]) {
      const elements = [element()];
      elements[0].actions[0][field] = bad;
      assert.equal(encodeBehavior(elements), null, `action.${field} = ${String(bad)}`);
    }
  }
});
