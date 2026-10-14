import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import { catalogStats, normalizeStats, runBalance, saveStats, warnings } from "./balance.js";

const require = createRequire(import.meta.url);
const combat = require("../../app/src/combat-node/horizon_combat.js");
const SEED = "ab".repeat(32);

test("normalizeStats accepts the catalog and rejects bad values", () => {
  const base = catalogStats();
  assert.equal(normalizeStats(base).length, base.length);
  const bad = base.map((unit) => (unit.name === "Guard" ? { ...unit, hp: 0 } : unit));
  assert.throws(() => normalizeStats(bad), /Guard hp/);
  assert.throws(() => normalizeStats(base.slice(1)), /expected/);
  const odd = base.map((unit) => (unit.name === "Archer" ? { ...unit, behavior: "Dance" } : unit));
  assert.throws(() => normalizeStats(odd), /unknown behavior/);
});

test("warnings flag a unit with no action points", () => {
  const guard = catalogStats().find((unit) => unit.name === "Guard");
  assert.equal(guard.actions, 1);
  assert.deepEqual(warnings(guard), []);
  assert.match(warnings({ ...guard, actions: 0 }).join(" "), /0 action points/);
});

test("unchanged stats give identical tuned and catalog duels on the same seeds", () => {
  const result = runBalance(combat, { units: catalogStats(), mode: "duels", ground: "outpost", games: 3, seed: SEED });
  assert.equal(result.seed, SEED);
  assert.deepEqual(result.tuned.table, result.catalog.table);
  for (const row of result.tuned.table) for (const cell of row) assert.equal(cell.wins + cell.losses + cell.draws, 3);
});

test("a stronger unit wins more duels than the catalog version", () => {
  const units = catalogStats().map((unit) => (unit.name === "Skirmisher" ? { ...unit, atk: 8, hp: 20 } : unit));
  const result = runBalance(combat, { units, mode: "duels", ground: "outpost", games: 6, seed: SEED });
  const row = result.tuned.units.indexOf("Skirmisher");
  // The mirror match is left out: both sides get the stronger stats there.
  const wins = (table) => table[row].reduce((sum, cell, col) => (col === row ? sum : sum + cell.wins), 0);
  assert.ok(wins(result.tuned.table) > wins(result.catalog.table));
});

test("army trials count every game and every fielded unit", () => {
  const result = runBalance(combat, { units: catalogStats(), mode: "armies", ground: "garrison", games: 8, seed: SEED });
  const { totals, units } = result.tuned;
  assert.equal(totals.a + totals.b + totals.draws, 8);
  assert.ok(units.reduce((sum, unit) => sum + unit.fielded, 0) >= 16);
  for (const unit of units) assert.ok(unit.survived <= unit.fielded);
  assert.deepEqual(result.tuned, result.catalog);
});

test("saveStats rewrites the catalog line and the Rust table together", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hz-balance-"));
  const catalogPath = path.join(dir, "catalog.json");
  const rustPath = path.join(dir, "catalog.rs");
  fs.copyFileSync(new URL("../../content/catalog.json", import.meta.url), catalogPath);
  fs.copyFileSync(new URL("../../crates/combat/src/catalog.rs", import.meta.url), rustPath);
  // Change two Guard values away from whatever the catalog holds now.
  const guard = catalogStats().find((unit) => unit.name === "Guard");
  const edited = { ...guard, speed: guard.speed === 2 ? 3 : 2, cast: { ...guard.cast, damage: guard.cast.damage + 1 } };
  const units = catalogStats().map((unit) => (unit.name === "Guard" ? edited : unit));
  saveStats(units, { catalogPath, rustPath });
  const saved = JSON.parse(fs.readFileSync(catalogPath, "utf8")).races[0].units.find((unit) => unit.name === "Guard");
  assert.equal(saved.speed, edited.speed);
  assert.equal(saved.cast.damage, edited.cast.damage);
  const rust = fs.readFileSync(rustPath, "utf8");
  assert.equal(saved.cast.effect, "push");
  assert.equal(saved.cast.aim, "foe");
  const c = edited.cast;
  const expected = `AshbornKind::Guard => UnitStats \\{\\s*kind,\\s*cost: ${edited.cost},\\s*hp: ${edited.hp},\\s*atk: ${edited.atk},\\s*range: ${edited.range},\\s*speed: ${edited.speed},\\s*actions: ${edited.actions},\\s*cast: Cast \\{ damage: ${c.damage}, range: ${c.range}, aoe: ${c.aoe}, effect: Effect::Push, aim: Aim::Foe, power: ${c.power}, rounds: ${c.rounds}, cooldown: ${c.cooldown} \\},`;
  assert.match(rust, new RegExp(expected));
  const original = fs.readFileSync(new URL("../../content/catalog.json", import.meta.url), "utf8").split("\n");
  const written = fs.readFileSync(catalogPath, "utf8").split("\n");
  assert.equal(written.length, original.length);
  assert.equal(written.filter((line, index) => line !== original[index]).length, 1);
});

test("saveStats writes a Rootborn unit to the RootbornKind arm", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hz-balance-"));
  const catalogPath = path.join(dir, "catalog.json");
  const rustPath = path.join(dir, "catalog.rs");
  fs.copyFileSync(new URL("../../content/catalog.json", import.meta.url), catalogPath);
  fs.copyFileSync(new URL("../../crates/combat/src/catalog.rs", import.meta.url), rustPath);
  const units = catalogStats(1).map((unit) => (unit.name === "Elderoak" ? { ...unit, hp: unit.hp + 1 } : unit));
  saveStats(units, { catalogPath, rustPath }, 1);
  const saved = JSON.parse(fs.readFileSync(catalogPath, "utf8")).races[1].units.find((unit) => unit.name === "Elderoak");
  const elderoak = units.find((unit) => unit.name === "Elderoak");
  assert.equal(saved.hp, elderoak.hp);
  assert.match(fs.readFileSync(rustPath, "utf8"), new RegExp(`RootbornKind::Elderoak => UnitStats \\{\\s*kind,\\s*cost: ${elderoak.cost},\\s*hp: ${elderoak.hp},`));
  assert.throws(() => normalizeStats(catalogStats(0), 1), /expected 3 units/);
});
