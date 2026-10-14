// Battle helpers shared by the battle screen and the behavior trial: health from a trace, the health bar, the chronicle, and sound cues.
import { parseTraceLine, targetsSelf, type TraceStep, type TraceUnit } from "../../content/trace.mjs";
import type { BoardImpact } from "./board-view.js";
import { unitSpec } from "./codec";
import type { Match } from "./devChain";

// Hit points of every fighter after the first `cursor` trace lines.
export function healthAt(match: Match, lines: string[], cursor: number) {
  const hp = [match.unitsA, match.unitsB].map((units) => units.map((unit): number => unit.hp || unitSpec(unit.race || 0, unit.kind)?.hp || 0));
  for (const step of lines.slice(0, cursor).map(parseTraceLine)) {
    if (step.kind === "attack" || step.kind === "cast") hp[step.target.side][step.target.index] = step.hp;
    if (step.kind === "death") hp[step.actor.side][step.actor.index] = 0;
  }
  return hp;
}

export function HealthBar({ hp, max, foe }: { hp: number; max: number; foe: boolean }) {
  return (
    <div className={foe ? "hz-health hz-health--foe" : "hz-health"} role="meter" aria-valuemin={0} aria-valuemax={max} aria-valuenow={hp}>
      {Array.from({ length: max }, (_, index) => <i key={index} className={index < hp ? "on" : ""} />)}
    </div>
  );
}

export type Entry = { text: string; kind: "move" | "hit" | "cast" | "defend" | "death" | "round" | "end"; index: number };

// Plain-language chronicle of a trace, naming each fighter by side and kind.
export function chronicle(match: Match, lines: string[], mySide: number, foeLabel?: string): Entry[] {
  const units = [match.unitsA, match.unitsB];
  const name = ({ side, index }: TraceUnit, start: boolean) => {
    const unit = units[side]?.[index];
    const kind = unit ? unitSpec(unit.race || 0, unit.kind)?.name || "soldier" : "soldier";
    if (side === mySide) return `${start ? "Your" : "your"} ${kind}`;
    if (foeLabel) return `${start ? "The" : "the"} ${foeLabel}`;
    return `${start ? "The" : "the"} foe's ${kind}`;
  };
  let round = 1;
  return lines.map((line, index): Entry => {
    const step = parseTraceLine(line);
    switch (step.kind) {
      case "move":
        return { index, kind: "move", text: `${name(step.actor, true)} moves to ${step.to.col},${step.to.row}` };
      case "attack": {
        const harm = step.damage > 0 ? ` · ${step.damage}${step.hp > 0 ? ` (${step.hp} HP left)` : ""}` : " · no damage";
        return { index, kind: "hit", text: `${name(step.actor, true)} strikes ${name(step.target, false)}${harm}` };
      }
      case "cast":
        return { index, kind: "cast", text: castText(step, name) };
      case "expire":
        return { index, kind: "cast", text: `${name(step.actor, true)}: ${STATUS_NAMES[step.effect] || "effect"} fades` };
      case "defend":
        return { index, kind: "defend", text: `${name(step.actor, true)} defends` };
      case "death":
        return { index, kind: "death", text: `${name(step.actor, true)} falls` };
      case "round":
        return { index, kind: "round", text: `End of round ${round++}` };
      case "end":
        if (step.winner === null) return { index, kind: "end", text: step.limit ? "Draw · both hosts still stand after twelve rounds" : "Draw" };
        return { index, kind: "end", text: step.winner === mySide ? "Your host holds the field" : "The foe holds the field" };
      default:
        return { index, kind: "end", text: line };
    }
  });
}

const STATUS_NAMES: Record<string, string> = { sprint: "sprint", reach: "longer reach", taunt: "taunt" };
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

type CastStep = Extract<TraceStep, { kind: "cast" }>;

function castText(step: CastStep, name: (unit: TraceUnit, start: boolean) => string) {
  const caster = name(step.actor, true);
  const self = targetsSelf(step);
  const target = self ? "itself" : name(step.target, false);
  const { damage, hp, amount, rounds } = step;
  const harm = damage > 0 ? ` · ${damage}${hp > 0 ? ` (${hp} HP left)` : ""}` : "";
  const lasting = rounds > 1 ? ` for ${plural(rounds, "round")}` : rounds === 1 ? " this round" : "";
  switch (step.effect) {
    case "push":
      return `${caster} shoves ${target}${harm}${amount > 0 ? ` · pushed to ${step.to.col},${step.to.row}` : hp > 0 ? " · it holds its ground" : ""}`;
    case "sprint":
      return self ? `${caster} sprints · ${amount + 1}× movement${lasting}` : `${caster} hastens ${target}${harm} · ${amount + 1}× movement${lasting}`;
    case "reach":
      return `${caster} lengthens ${self ? "its" : `${target}'s`} reach · +${amount} range${lasting}${harm}`;
    case "taunt":
      return `${caster} taunts ${target}${harm}${hp > 0 ? ` · it must close in${lasting}` : ""}`;
    case "heal":
      return `${caster} heals ${target} · +${amount} (${hp} HP)`;
    default:
      return `${caster} casts at ${target}${harm || " · no damage"}`;
  }
}

const IMPACT_CUE = { hit: "hit", cast: "cast", miss: "miss", defend: "defend", death: "death" } as const;

export function cueFor(event: BoardImpact) {
  if (event.kind === "hit" && (event.damage || 0) >= 3) return "heavy" as const;
  return IMPACT_CUE[event.kind];
}
