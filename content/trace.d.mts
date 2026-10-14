// Types for trace.mjs, read by the app's TypeScript check.
export type TraceUnit = { side: number; index: number };
export type TraceTile = { col: number; row: number };
export type TraceStep =
  | { kind: "move"; line: string; actor: TraceUnit; from: TraceTile; to: TraceTile }
  | { kind: "attack"; line: string; actor: TraceUnit; target: TraceUnit; damage: number; hp: number }
  | {
      kind: "cast";
      line: string;
      actor: TraceUnit;
      target: TraceUnit;
      damage: number;
      hp: number;
      effectId: number;
      effect: string;
      amount: number;
      rounds: number;
      from: TraceTile;
      to: TraceTile;
    }
  | { kind: "defend" | "death"; line: string; actor: TraceUnit }
  | { kind: "expire"; line: string; actor: TraceUnit; effectId: number; effect: string }
  | { kind: "round"; line: string }
  | { kind: "end"; line: string; winner: number | null; limit: boolean }
  | { kind: "unknown"; line: string };
export function parseTraceLine(line: string): TraceStep;
export function targetsSelf(step: TraceStep): boolean;
