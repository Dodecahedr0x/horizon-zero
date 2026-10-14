import { parseTraceLine } from "../../content/trace.mjs";

function kindName(unit) {
  if (!unit) return "Unit";
  if (unit.name) return unit.name;
  return "Unit";
}

function sameKind(left, right) {
  if (!left || !right) return false;
  if (left.kind != null && right.kind != null) return left.kind === right.kind;
  return kindName(left) === kindName(right);
}

export function unitLabel(units, index) {
  const at = Number(index);
  const unit = units[at];
  if (!unit) return `Unit ${at + 1}`;
  let ordinal = 0;
  for (let cursor = 0; cursor <= at; cursor += 1) {
    if (sameKind(units[cursor], unit)) ordinal += 1;
  }
  return `${kindName(unit)} ${ordinal}`;
}

export function stepActor(line, sideA, sideB) {
  const { actor } = parseTraceLine(line);
  if (!actor) return null;
  const { side, index } = actor;
  if (side !== 0 && side !== 1) return null;
  if (!Number.isInteger(index) || index < 0) return null;
  const units = side === 0 ? sideA : sideB;
  return {
    team: side === 0 ? "A" : "B",
    side,
    index,
    label: unitLabel(Array.isArray(units) ? units : [], index),
  };
}

function filterMatches(actor, filter) {
  if (!filter || (filter.type !== "team" && filter.type !== "unit")) return false;
  if (actor == null) return filter.type === "team";
  if (filter.type === "team") return filter.team === actor.team;
  return filter.team === actor.team && Number(filter.index) === actor.index;
}

// A row is shown when every active filter matches its actor.
// A team filter matches that side. A unit filter matches that side and that unit.
// Round-end and outcome rows have no actor: they match a team filter and do not match a unit filter.
export function eventShown(actor, filters) {
  const active = Array.isArray(filters) ? filters : [];
  return active.every((filter) => filterMatches(actor, filter));
}
