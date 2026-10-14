// Balance lab: run many seeded simulations with tuned unit stats and compare them with the catalog.
// Every run is played twice on the same seeds, once with the tuned stats and once with the catalog, so the
// difference between the two is the effect of the change and not the luck of the draw.
import crypto from "node:crypto";
import fs from "node:fs";
import { AIMS, EFFECTS, LASTING_EFFECTS } from "../../content/ids.mjs";
import { parseTraceLine } from "../../content/trace.mjs";
import { BEHAVIORS, GROUNDS, MAX_UNITS, RACES } from "./battle.js";

// Bounds keep values inside the engine's types (cost u16, hp, atk and cast fields u8) and inside sane play.
// Stats are on a scale of about 3 per old point, so hp, atk, damage and heal have room to grow.
export const LIMITS = {
  cost: [1, 32],
  hp: [1, 255],
  atk: [0, 99],
  range: [1, 10],
  speed: [0, 10],
  actions: [0, 4],
  castDamage: [0, 99],
  castRange: [0, 10],
  castAoe: [0, 4],
  castEffect: [0, EFFECTS.length - 1],
  castAim: [0, AIMS.length - 1],
  castPower: [0, 30],
  castRounds: [0, 12],
  castCooldown: [0, 12],
};

export const MAX_DUEL_GAMES = 500;
export const MAX_ARMY_GAMES = 2000;

// Default trial behavior per unit name; any standard can be picked in the page.
const DEFAULT_BEHAVIOR = {
  Guard: "March",
  Skirmisher: "Charge",
  Archer: "Kite",
  Vanguard: "Charge",
  Warden: "March",
  Thornling: "Charge",
  Briarsling: "Kite",
  Elderoak: "March cast",
  Clawling: "March cast",
  Eelsnare: "Charge cast",
  Spineshot: "Kite cast",
  Tidecaller: "March cast",
};

export function catalogStats(raceId = 0) {
  const race = RACES.find((item) => item.id === raceId);
  if (!race) throw new Error("unknown race");
  return race.units.map((unit) => ({
    id: unit.id,
    name: unit.name,
    cost: unit.cost,
    hp: unit.hp,
    atk: unit.atk,
    range: unit.range,
    speed: unit.speed,
    actions: unit.actions,
    cast: { ...unit.cast },
    behavior: DEFAULT_BEHAVIOR[unit.name] || BEHAVIORS[0].name,
  }));
}

function bounded(value, [min, max], label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new Error(`${label} must be a whole number from ${min} to ${max}`);
  return number;
}

// Validate a stat table sent by the page. Unknown units, missing units and out-of-range values are rejected.
export function normalizeStats(units, raceId = 0) {
  const base = catalogStats(raceId);
  if (!Array.isArray(units) || units.length !== base.length) throw new Error(`expected ${base.length} units`);
  return base.map((unit) => {
    const given = units.find((item) => Number(item.id) === unit.id);
    if (!given) throw new Error(`missing ${unit.name}`);
    const behavior = BEHAVIORS.find((item) => item.name === (given.behavior || unit.behavior));
    if (!behavior) throw new Error(`${unit.name}: unknown behavior`);
    const cast = given.cast || {};
    return {
      id: unit.id,
      name: unit.name,
      cost: bounded(given.cost, LIMITS.cost, `${unit.name} cost`),
      hp: bounded(given.hp, LIMITS.hp, `${unit.name} hp`),
      atk: bounded(given.atk, LIMITS.atk, `${unit.name} atk`),
      range: bounded(given.range, LIMITS.range, `${unit.name} range`),
      speed: bounded(given.speed, LIMITS.speed, `${unit.name} speed`),
      actions: bounded(given.actions, LIMITS.actions, `${unit.name} actions`),
      cast: {
        damage: bounded(cast.damage, LIMITS.castDamage, `${unit.name} cast damage`),
        range: bounded(cast.range, LIMITS.castRange, `${unit.name} cast range`),
        aoe: bounded(cast.aoe, LIMITS.castAoe, `${unit.name} cast area`),
        effect: bounded(cast.effect, LIMITS.castEffect, `${unit.name} cast effect`),
        aim: bounded(cast.aim, LIMITS.castAim, `${unit.name} cast aim`),
        power: bounded(cast.power, LIMITS.castPower, `${unit.name} cast power`),
        rounds: bounded(cast.rounds, LIMITS.castRounds, `${unit.name} cast rounds`),
        cooldown: bounded(cast.cooldown, LIMITS.castCooldown, `${unit.name} cast cooldown`),
      },
      behavior: behavior.name,
    };
  });
}

// Plain warnings about a stat line, e.g. a unit that can never act.
export function warnings(unit) {
  const out = [];
  const points = unit.actions;
  if (points === 0) out.push("0 action points: it never attacks, casts or defends.");
  if (unit.speed === 0) out.push("Speed 0: it never moves.");
  if (unit.atk === 0 && unit.cast.damage === 0) out.push("No attack or cast damage.");
  const effect = EFFECTS[unit.cast.effect];
  if (unit.cast.damage === 0 && (effect === "none" || (effect !== "taunt" && unit.cast.power === 0))) out.push("The cast changes nothing, so it never fires.");
  if (LASTING_EFFECTS.includes(effect) && unit.cast.rounds === 0) out.push(`A ${effect} that lasts 0 rounds never lands.`);
  return out;
}

function seedFor(base, index) {
  return crypto.createHash("sha256").update(Buffer.from(base, "hex")).update(Buffer.from([index & 255, index >> 8])).digest();
}

// Small seeded generator so army draws repeat for the tuned and catalog runs.
function rngFrom(seed) {
  let state = seed.readUInt32LE(0) || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return ((state >>> 0) % 1_000_000) / 1_000_000;
  };
}

function behaviorBody(name) {
  const behavior = BEHAVIORS.find((item) => item.name === name);
  if (!behavior) throw new Error(`unknown behavior ${name}`);
  return behavior.body.slice();
}

function engineUnit(stats, col, row) {
  return { kind: stats.id, body: behaviorBody(stats.behavior), col, row, cost: stats.cost, hp: stats.hp, atk: stats.atk, range: stats.range, speed: stats.speed, actions: stats.actions, cast: { ...stats.cast } };
}

function simulate(combat, cols, rows, a, b, seed) {
  const parsed = JSON.parse(combat.simulate_json(JSON.stringify({ cols, rows, a, b, seed: [...seed] })));
  if (!parsed || parsed.error || !Array.isArray(parsed.lines)) throw new Error(parsed && parsed.error ? parsed.error : "no trace");
  return parsed;
}

function groundOf(id) {
  const ground = GROUNDS.find((item) => item.id === id);
  if (!ground) throw new Error("unknown battleground");
  return ground;
}

// Every unit against every unit, one on one, at the middle of each zone.
function duelTable(combat, stats, ground, games, base) {
  const col = Math.floor(ground.cols / 2);
  const table = stats.map((attacker) => stats.map((defender) => {
    const cell = { wins: 0, losses: 0, draws: 0 };
    for (let game = 0; game < games; game += 1) {
      // Alternate sides so neither the side nor the starting tile decides the duel.
      const swap = game % 2 === 1;
      const mine = engineUnit(attacker, swap ? col - 1 : col, 0);
      const theirs = engineUnit(defender, swap ? col : col - 1, 0);
      const result = simulate(combat, ground.cols, ground.rows, swap ? [theirs] : [mine], swap ? [mine] : [theirs], seedFor(base, attacker.id * 1000 + defender.id * 100 + game));
      const won = result.winner === (swap ? 1 : 0);
      const lost = result.winner === (swap ? 0 : 1);
      if (won) cell.wins += 1;
      else if (lost) cell.losses += 1;
      else cell.draws += 1;
    }
    return cell;
  }));
  return { kind: "duels", units: stats.map((unit) => unit.name), table, games };
}

function randomArmy(stats, ground, rng) {
  const tiles = [];
  for (let row = 0; row < 2; row += 1) for (let col = 0; col < ground.cols; col += 1) tiles.push({ col, row });
  for (let i = tiles.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [tiles[i], tiles[j]] = [tiles[j], tiles[i]];
  }
  const units = [];
  let cost = 0;
  while (units.length < MAX_UNITS && tiles.length) {
    const affordable = stats.filter((unit) => cost + unit.cost <= ground.budget);
    if (!affordable.length) break;
    const pick = affordable[Math.floor(rng() * affordable.length)];
    const tile = tiles.pop();
    units.push(engineUnit(pick, tile.col, tile.row));
    cost += pick.cost;
  }
  return units;
}

// Random budget-legal armies on both sides; per-unit numbers come from the traces.
function armyTable(combat, stats, ground, games, base) {
  const per = stats.map((unit) => ({ name: unit.name, cost: unit.cost, fielded: 0, survived: 0, dealt: 0, taken: 0, healed: 0, kills: 0, gamesIn: 0, winsIn: 0 }));
  const totals = { a: 0, b: 0, draws: 0, rounds: 0 };
  for (let game = 0; game < games; game += 1) {
    const seed = seedFor(base, game);
    const rng = rngFrom(seed);
    const sides = [randomArmy(stats, ground, rng), randomArmy(stats, ground, rng)];
    const result = simulate(combat, ground.cols, ground.rows, sides[0], sides[1], seed);
    if (result.winner === 0) totals.a += 1;
    else if (result.winner === 1) totals.b += 1;
    else totals.draws += 1;
    const dead = new Set();
    for (const step of result.lines.map(parseTraceLine)) {
      if (step.kind === "round") totals.rounds += 1;
      if (step.kind === "attack" || step.kind === "cast") {
        const actor = sides[step.actor.side][step.actor.index];
        const target = sides[step.target.side][step.target.index];
        if (actor) per[actor.kind].dealt += step.damage;
        if (target) per[target.kind].taken += step.damage;
        if (actor && step.hp <= 0 && step.damage > 0) per[actor.kind].kills += 1;
        if (actor && step.kind === "cast" && step.effect === "heal") per[actor.kind].healed += step.amount;
      }
      if (step.kind === "death") dead.add(`${step.actor.side}:${step.actor.index}`);
    }
    sides.forEach((units, side) => {
      const kinds = new Set();
      units.forEach((unit, index) => {
        per[unit.kind].fielded += 1;
        if (!dead.has(`${side}:${index}`)) per[unit.kind].survived += 1;
        kinds.add(unit.kind);
      });
      for (const kind of kinds) {
        per[kind].gamesIn += 1;
        if (result.winner === side) per[kind].winsIn += 1;
      }
    });
  }
  return { kind: "armies", games, totals, units: per };
}

export function runBalance(combat, { units, mode, ground, games, seed, raceId = 0 }) {
  const tuned = normalizeStats(units, raceId);
  const catalog = catalogStats(raceId).map((unit) => ({ ...unit, behavior: tuned.find((item) => item.id === unit.id).behavior }));
  const place = groundOf(ground);
  const base = typeof seed === "string" && /^[0-9a-f]{64}$/.test(seed) ? seed : crypto.randomBytes(32).toString("hex");
  if (mode === "duels") {
    const count = bounded(games, [1, MAX_DUEL_GAMES], "games");
    return { seed: base, ground: place.id, tuned: duelTable(combat, tuned, place, count, base), catalog: duelTable(combat, catalog, place, count, base), warnings: Object.fromEntries(tuned.map((unit) => [unit.name, warnings(unit)])) };
  }
  if (mode === "armies") {
    const count = bounded(games, [1, MAX_ARMY_GAMES], "games");
    return { seed: base, ground: place.id, tuned: armyTable(combat, tuned, place, count, base), catalog: armyTable(combat, catalog, place, count, base), warnings: Object.fromEntries(tuned.map((unit) => [unit.name, warnings(unit)])) };
  }
  throw new Error("mode must be duels or armies");
}

// Catalog slugs to the Rust enum variants in crates/combat (`Effect`, `Aim`). `self` is `Aim::Caster`.
const variant = (slug) => (slug === "self" ? "Caster" : slug.charAt(0).toUpperCase() + slug.slice(1));

function rustCast(c) {
  const effect = `Effect::${variant(EFFECTS[c.effect])}`;
  const aim = `Aim::${variant(AIMS[c.aim])}`;
  return `Cast { damage: ${c.damage}, range: ${c.range}, aoe: ${c.aoe}, effect: ${effect}, aim: ${aim}, power: ${c.power}, rounds: ${c.rounds}, cooldown: ${c.cooldown} }`;
}

// Write tuned stats to content/catalog.json and the matching Rust table, which a test keeps in step.
export function saveStats(units, { catalogPath, rustPath }, raceId = 0) {
  const tuned = normalizeStats(units, raceId);
  // Replace each unit's single line in catalog.json, leaving the rest of the file exactly as it is.
  const lines = fs.readFileSync(catalogPath, "utf8").split("\n");
  for (const unit of tuned) {
    const at = lines.findIndex((line) => line.trim().startsWith(`{ "id": ${unit.id}, "name": ${JSON.stringify(unit.name)}`));
    if (at === -1) throw new Error(`could not find ${unit.name} in content/catalog.json`);
    const indent = lines[at].match(/^\s*/)[0];
    const comma = lines[at].trimEnd().endsWith(",") ? "," : "";
    const c = unit.cast;
    const castJson = `{ "damage": ${c.damage}, "range": ${c.range}, "aoe": ${c.aoe}, "effect": "${EFFECTS[c.effect]}", "aim": "${AIMS[c.aim]}", "power": ${c.power}, "rounds": ${c.rounds}, "cooldown": ${c.cooldown} }`;
    // Fields the table does not edit, such as the swatch color, are kept from the current line.
    const current = JSON.parse(lines[at].trim().replace(/,$/, ""));
    lines[at] = `${indent}{ "id": ${unit.id}, "name": ${JSON.stringify(unit.name)}, "color": ${JSON.stringify(current.color)}, "cost": ${unit.cost}, "hp": ${unit.hp}, "atk": ${unit.atk}, "range": ${unit.range}, "speed": ${unit.speed}, "actions": ${unit.actions}, "cast": ${castJson} }${comma}`;
  }
  const text = lines.join("\n");
  JSON.parse(text);
  let rust = fs.readFileSync(rustPath, "utf8");
  // Each race has its own kind enum in crates/combat/src/ids.rs, named after the race.
  const race = RACES.find((item) => item.id === raceId);
  for (const unit of tuned) {
    const constant = `${race.name}Kind::${unit.name}`;
    const pattern = new RegExp(`(${constant} => UnitStats \\{\\s*kind,\\s*)cost: \\d+,\\s*hp: -?\\d+,\\s*atk: -?\\d+,\\s*range: -?\\d+,\\s*speed: -?\\d+,\\s*actions: -?\\d+,\\s*cast: Cast \\{ damage: \\d+, range: \\d+, aoe: \\d+, effect: Effect::[A-Za-z]+, aim: Aim::[A-Za-z]+, power: \\d+, rounds: \\d+, cooldown: \\d+ \\},`);
    if (!pattern.test(rust)) throw new Error(`could not find ${constant} in the Rust stats table`);
    rust = rust.replace(pattern, (_, head) => {
      const indent = head.match(/\n(\s*)kind,/)[1];
      return `${head}cost: ${unit.cost},\n${indent}hp: ${unit.hp},\n${indent}atk: ${unit.atk},\n${indent}range: ${unit.range},\n${indent}speed: ${unit.speed},\n${indent}actions: ${unit.actions},\n${indent}cast: ${rustCast(unit.cast)},`;
    });
  }
  fs.writeFileSync(catalogPath, text.endsWith("\n") ? text : `${text}\n`);
  fs.writeFileSync(rustPath, rust);
  return tuned;
}
