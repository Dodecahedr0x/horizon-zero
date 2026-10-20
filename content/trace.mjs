// One parser for the engine's trace lines (crates/combat/src/trace.rs). Every client reads lines
// through this instead of indexing split fields, so the line format lives in one place.
// Plain module, no imports beyond ./ids.mjs: the studio serves it to the browser as is.
import { effectName } from "./ids.mjs";

const ACTOR_CODES = new Set(["M", "A", "C", "F", "D", "X"]);

const unit = (side, index) => ({ side, index });
const tile = (col, row) => ({ col, row });

/**
 * A trace line as named fields. `kind` is move, attack, cast, defend, death, expire, round, end or
 * unknown. Actor lines carry `actor` ({side, index}); hits carry `target`, `damage` and `hp` (the
 * target's hp after the line); casts add `effect` (name), `effectId`, `amount`, `rounds`, `from`
 * and `to` (the target's tile before and after); moves carry `from` and `to`; `end` carries
 * `winner` (0, 1 or null), `limit` (twelve rounds ended a draw) and `work` (the engine's work limit
 * stopped the battle; the side with the larger share of its starting hp left wins).
 */
export function parseTraceLine(line) {
  const text = String(line ?? "").trim();
  const parts = text.split(/\s+/);
  const code = parts[0];
  const n = parts.map(Number);
  const actor = ACTOR_CODES.has(code) ? unit(n[1], n[2]) : null;
  switch (code) {
    case "M":
      return { kind: "move", line: text, actor, from: tile(n[3], n[4]), to: tile(n[5], n[6]) };
    case "A":
      return { kind: "attack", line: text, actor, target: unit(n[3], n[4]), damage: n[5], hp: n[6] };
    case "C":
      return {
        kind: "cast",
        line: text,
        actor,
        target: unit(n[3], n[4]),
        damage: n[5],
        hp: n[6],
        effectId: n[7],
        effect: effectName(n[7]),
        amount: n[8],
        rounds: n[9],
        from: tile(n[10], n[11]),
        to: tile(n[12], n[13]),
      };
    case "F":
      return { kind: "defend", line: text, actor };
    case "D":
      return { kind: "death", line: text, actor };
    case "X":
      return { kind: "expire", line: text, actor, effectId: n[3], effect: effectName(n[3]) };
    case "R":
      return { kind: "round", line: text };
    case "E":
      if (parts[1] === "draw") return { kind: "end", line: text, winner: null, limit: parts[2] === "limit", work: parts[2] === "work" };
      return { kind: "end", line: text, winner: n[1], limit: false, work: parts[2] === "work" };
    default:
      return { kind: "unknown", line: text };
  }
}

/** True when the line's target is its own actor, as for a cast aimed at the caster. */
export function targetsSelf(step) {
  return Boolean(step.actor && step.target && step.actor.side === step.target.side && step.actor.index === step.target.index);
}
