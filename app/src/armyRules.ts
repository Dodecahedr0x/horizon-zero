// Client rules for building an army. The program only checks the budget ceiling, ten units, and the zone;
// the client also asks that an army be full before it is saved, so every army in a league spends its budget.
import { STANDARDS, ZONE_DEPTH, encodeBehavior, raceById, unitSpec } from "./codec";
import type { MatchUnit } from "./devChain";

export const MAX_UNITS = 10;

export function armyCost(race: number, units: { kind: number }[]) {
  return units.reduce((sum, unit) => sum + (unitSpec(race, unit.kind)?.cost || 0), 0);
}

/** Full: the budget is spent, or no unit of the race still fits, or ten units stand. */
export function isFull(race: number, units: { kind: number }[], budget: number) {
  if (!units.length) return false;
  const cost = armyCost(race, units);
  if (cost > budget) return false;
  if (units.length >= MAX_UNITS) return true;
  const cheapest = Math.min(...(raceById(race)?.units.map((unit) => unit.cost) ?? [Infinity]));
  return budget - cost < cheapest;
}

export function matchUnit(race: number, kind: number, body: number[], col: number, row: number): MatchUnit {
  const spec = unitSpec(race, kind);
  return { kind, race, body, col, row, cost: spec?.cost, hp: spec?.hp, atk: spec?.atk, range: spec?.range, speed: spec?.speed, actions: spec?.actions, cast: spec?.cast };
}

function pick<T>(items: readonly T[]) {
  return items[crypto.getRandomValues(new Uint32Array(1))[0] % items.length];
}

/** A random full army for a simulation: random soldiers until nothing fits, each on a random standard behavior and tile. */
export function randomArmy(race: number, budget: number, cols: number): MatchUnit[] {
  const kinds = raceById(race)?.units ?? [];
  const tiles = Array.from({ length: cols * ZONE_DEPTH }, (_, index) => ({ col: index % cols, row: Math.floor(index / cols) }));
  const army: MatchUnit[] = [];
  let left = budget;
  while (army.length < MAX_UNITS) {
    const affordable = kinds.filter((unit) => unit.cost <= left);
    if (!affordable.length) break;
    const unit = pick(affordable);
    const tile = tiles.splice(crypto.getRandomValues(new Uint32Array(1))[0] % tiles.length, 1)[0];
    army.push(matchUnit(race, unit.id, encodeBehavior(pick(STANDARDS).elements) || [], tile.col, tile.row));
    left -= unit.cost;
  }
  return army;
}
