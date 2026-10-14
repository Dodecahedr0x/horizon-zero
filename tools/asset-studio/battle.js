import crypto from "node:crypto";
import { loadCatalog } from "../../content/load.mjs";
import { parseTraceLine, targetsSelf } from "../../content/trace.mjs";

const catalog = loadCatalog();

// The program's `MAX_UNITS`: an army holds at most this many units.
export const MAX_UNITS = 10;

// The studio names battlegrounds by slug in its API and saved batches.
export const GROUNDS = catalog.battlegrounds.map(({ slug, name, cols, rows, budget }) => ({ id: slug, name, cols, rows, budget }));

export function raceById(id) {
  return RACES.find((race) => race.id === Number(id)) || null;
}

export function unitArtPaths(raceSlug, kindSlug) {
  const file = `${kindSlug}.approved.png`;
  const paths = [`units/${kindSlug}/${file}`];
  if (raceSlug) paths.unshift(`units/${raceSlug}/${kindSlug}/${file}`);
  return paths;
}

// Bodies come from content/catalog.json. On a one-element body the side byte is index 5 and stop is index 6.
export const RACES = catalog.races;
export const BEHAVIORS = catalog.behaviors.map((behavior) => ({ name: behavior.name, body: behavior.body }));

export function groundById(id) {
  return GROUNDS.find((ground) => ground.id === id) || null;
}

function sameBody(left, right) {
  return Array.isArray(right) && left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function behaviorOf(body) {
  return BEHAVIORS.find((behavior) => sameBody(behavior.body, body)) || null;
}

export function assertArmy(ground, units) {
  if (!ground) throw new Error("unknown battleground");
  if (!Array.isArray(units) || units.length < 1 || units.length > MAX_UNITS) throw new Error(`army must have 1 to ${MAX_UNITS} units`);
  const race = raceById(units[0].race ?? 0);
  if (!race) throw new Error("unknown race");
  const seen = new Set();
  let cost = 0;
  for (const unit of units) {
    if ((unit.race ?? 0) !== race.id) throw new Error("unknown race");
    const kind = race.units.find((item) => item.id === unit.kind);
    if (!kind) throw new Error("unknown kind");
    if (!behaviorOf(unit.body)) throw new Error("unknown behavior");
    if (unit.row !== 0 && unit.row !== 1) throw new Error("row is outside the zone");
    if (!Number.isInteger(unit.col) || unit.col < 0 || unit.col >= ground.cols) throw new Error("col is outside the zone");
    const tile = `${unit.col},${unit.row}`;
    if (seen.has(tile)) throw new Error("two units share a tile");
    seen.add(tile);
    cost += kind.cost;
  }
  if (cost > ground.budget) throw new Error("army cost exceeds the battleground budget");
  return cost;
}

function shuffle(items, rng) {
  for (let index = items.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(rng() * (index + 1));
    const held = items[index];
    items[index] = items[swap];
    items[swap] = held;
  }
  return items;
}

export function randomArmy(groundId, rng = Math.random, raceId = 0) {
  const ground = groundById(groundId);
  const race = raceById(raceId);
  if (!ground) throw new Error("unknown battleground");
  if (!race) throw new Error("unknown race");
  const tiles = [];
  for (let row = 0; row < 2; row += 1) {
    for (let col = 0; col < ground.cols; col += 1) tiles.push({ col, row });
  }
  shuffle(tiles, rng);
  const units = [];
  let cost = 0;
  while (units.length < MAX_UNITS && tiles.length) {
    const affordable = race.units.filter((kind) => cost + kind.cost <= ground.budget);
    if (!affordable.length) break;
    const kind = affordable[Math.floor(rng() * affordable.length)];
    const behavior = BEHAVIORS[Math.floor(rng() * BEHAVIORS.length)];
    const tile = tiles.pop();
    units.push({
      kind: kind.id,
      name: kind.name,
      race: race.id,
      raceName: race.name,
      behavior: behavior.name,
      body: behavior.body.slice(),
      col: tile.col,
      row: tile.row,
      cost: kind.cost,
      hp: kind.hp,
      atk: kind.atk,
      range: kind.range,
      speed: kind.speed,
      actions: kind.actions,
      cast: { ...kind.cast },
    });
    cost += kind.cost;
  }
  if (!units.length) throw new Error("could not place a unit");
  return {
    ground: ground.id,
    name: ground.name,
    race: race.id,
    raceName: race.name,
    cols: ground.cols,
    rows: ground.rows,
    budget: ground.budget,
    cost,
    units,
  };
}

function asSeed(seed) {
  if (seed instanceof Uint8Array && seed.length === 32) return seed;
  if (Array.isArray(seed) && seed.length === 32 && seed.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)) {
    return Uint8Array.from(seed);
  }
  return crypto.randomBytes(32);
}

export function runFight(combat, { cols, rows, a, b, seed }) {
  const ground = GROUNDS.find((item) => item.cols === cols && item.rows === rows);
  if (!ground) throw new Error("unknown battleground");
  assertArmy(ground, a);
  assertArmy(ground, b);
  const seedBytes = asSeed(seed);
  const parsed = JSON.parse(combat.simulate_json(JSON.stringify({
    cols,
    rows,
    a: a.map(combatUnit),
    b: b.map(combatUnit),
    seed: [...seedBytes],
  })));
  if (!parsed || parsed.error) throw new Error(parsed && parsed.error ? parsed.error : "combat simulator did not return a trace");
  if (!Array.isArray(parsed.lines)) throw new Error("combat simulator did not return a trace");
  const blocked = JSON.parse(combat.blocked_json(cols, rows, seedBytes));
  if (!Array.isArray(blocked)) throw new Error("combat simulator did not return blocked tiles");
  const outcome = parsed.winner === 0 ? "A" : parsed.winner === 1 ? "B" : "draw";
  const sentences = parsed.lines.map((line) => describeStep(line, a, b));
  return {
    winner: parsed.winner === 0 || parsed.winner === 1 ? parsed.winner : null,
    outcome,
    result: sideResult(outcome),
    lines: parsed.lines,
    sentences,
    seed: Buffer.from(seedBytes).toString("hex"),
    blocked,
  };
}

function combatUnit(unit) {
  const race = raceById(unit.race ?? 0);
  const kind = race && race.units.find((item) => item.id === unit.kind);
  const cast = unit.cast || (kind && kind.cast);
  if (!cast || unit.hp == null && !kind) throw new Error("unit is missing its cast");
  return {
    kind: unit.kind,
    body: unit.body,
    col: unit.col,
    row: unit.row,
    cost: unit.cost ?? kind.cost,
    hp: unit.hp ?? kind.hp,
    atk: unit.atk ?? kind.atk,
    range: unit.range ?? kind.range,
    speed: unit.speed ?? kind.speed,
    actions: unit.actions ?? kind.actions,
    cast,
  };
}

function kindName(unit) {
  if (!unit) return "Unit";
  if (unit.name) return unit.name;
  const race = raceById(unit.race ?? 0);
  const kind = race && race.units.find((item) => item.id === unit.kind);
  return kind ? kind.name : "Unit";
}

function sameKind(left, right) {
  if (!left || !right) return false;
  if (left.kind != null && right.kind != null) return left.kind === right.kind;
  return kindName(left) === kindName(right);
}

function sideLabel(side) {
  if (Number(side) === 0) return "Side A";
  if (Number(side) === 1) return "Side B";
  return `Side ${side}`;
}

function unitLabel(units, index) {
  const at = Number(index);
  const unit = units[at];
  if (!unit) return `Unit ${at + 1}`;
  let ordinal = 0;
  for (let cursor = 0; cursor <= at; cursor += 1) {
    if (sameKind(units[cursor], unit)) ordinal += 1;
  }
  return `${kindName(unit)} ${ordinal}`;
}

function named(side, index, sideA, sideB) {
  const units = Number(side) === 0 ? sideA : sideB;
  return `${sideLabel(side)} ${unitLabel(units || [], index)}`;
}

export function applyKind(ground, units, index, kindId) {
  if (!ground) throw new Error("unknown battleground");
  if (!Array.isArray(units) || !units[index]) throw new Error("unknown unit");
  if (units.length > MAX_UNITS) throw new Error(`army must have 1 to ${MAX_UNITS} units`);
  const race = raceById(units[index].race ?? 0);
  if (!race) throw new Error("unknown race");
  const kind = race.units.find((item) => item.id === Number(kindId));
  if (!kind) throw new Error("unknown kind");
  const next = units.map((unit, unitIndex) => {
    if (unitIndex !== index) return unit;
    return {
      ...unit,
      kind: kind.id,
      name: kind.name,
      cost: kind.cost,
      hp: kind.hp,
      atk: kind.atk,
      range: kind.range,
      speed: kind.speed,
      actions: kind.actions,
      cast: { ...kind.cast },
    };
  });
  let cost = 0;
  for (const unit of next) {
    const item = race.units.find((entry) => entry.id === unit.kind);
    if (!item) throw new Error("unknown kind");
    cost += item.cost;
  }
  if (cost > ground.budget) throw new Error("army cost exceeds the battleground budget");
  return { units: next, cost };
}

export function applyBehavior(units, index, behaviorName) {
  const behavior = BEHAVIORS.find((item) => item.name === behaviorName);
  if (!behavior) throw new Error("unknown behavior");
  if (!Array.isArray(units) || !units[index]) throw new Error("unknown unit");
  return units.map((unit, unitIndex) => (
    unitIndex === index ? { ...unit, behavior: behavior.name, body: behavior.body.slice() } : unit
  ));
}

export function sideResult(outcome) {
  if (outcome === "A") return "win";
  if (outcome === "B") return "loss";
  return "draw";
}

export function describeStep(line, sideA, sideB) {
  const step = parseTraceLine(line);
  const who = (unit) => named(unit.side, unit.index, sideA, sideB);
  const rounds = (count) => (count > 0 ? ` for ${count} round${count === 1 ? "" : "s"}` : "");
  switch (step.kind) {
    case "move":
      return `${who(step.actor)} walks from (${step.from.col},${step.from.row}) to (${step.to.col},${step.to.row}). There is no target.`;
    case "attack":
      return `${who(step.actor)} attacks ${who(step.target)} for ${step.damage}`;
    case "cast": {
      const sentence = `${who(step.actor)} casts on ${targetsSelf(step) ? "itself" : who(step.target)}`;
      const damage = step.damage > 0 ? ` for ${step.damage}` : "";
      switch (step.effect) {
        case "push":
          if (step.amount === 0) return `${sentence}${damage} and shoves them, but they stay`;
          return `${sentence}${damage} and shoves them from (${step.from.col},${step.from.row}) to (${step.to.col},${step.to.row})`;
        case "sprint":
          return `${sentence}${damage}: ${step.amount + 1}x movement${rounds(step.rounds)}`;
        case "reach":
          return `${sentence}${damage}: +${step.amount} attack range${rounds(step.rounds)}`;
        case "taunt":
          return `${sentence}${damage}: taunted toward the caster${rounds(step.rounds)}`;
        case "heal":
          return `${sentence}: heals ${step.amount} (now ${step.hp} HP)`;
        default:
          return `${sentence} for ${step.damage}`;
      }
    }
    case "expire":
      return `${who(step.actor)}: ${step.effect} ends`;
    case "defend":
      return `${who(step.actor)} defends. There is no target.`;
    case "death":
      return `${who(step.actor)} dies`;
    case "round":
      return "Round ends";
    case "end":
      if (step.winner === 0) return "Side A wins.";
      if (step.winner === 1) return "Side B wins.";
      return step.limit ? "Draw. Round limit reached." : "Draw.";
    default:
      return `Unrecognized step (${line}).`;
  }
}

export function clampRounds(value) {
  const rounds = Number(value);
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 200) throw new Error("rounds must be from 1 to 200");
  return rounds;
}
