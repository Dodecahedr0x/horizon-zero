import type { Match, MatchUnit } from "./devChain";

type CombatModule = {
  default?: () => Promise<unknown>;
  simulate_json: (input: string) => string;
  blocked_json: (cols: number, rows: number, seed: Uint8Array) => string;
};

let modulePromise: Promise<CombatModule> | null = null;

function loadCombat() {
  if (!modulePromise) {
    modulePromise = import("./combat-wasm/horizon_combat.js").then(async (mod: CombatModule) => {
      if (mod.default) await mod.default();
      return mod;
    });
  }
  return modulePromise;
}

function seedBytes(seed: string) {
  return Uint8Array.from(seed.match(/.{2}/g)?.map((byte) => Number.parseInt(byte, 16)) || []);
}

export async function replay(match: Match) {
  const mod = await loadCombat();
  const raw = mod.simulate_json(JSON.stringify({
    cols: match.cols,
    rows: match.rows,
    a: match.unitsA,
    b: match.unitsB,
    seed: [...seedBytes(match.seed)],
  }));
  const parsed = JSON.parse(raw) as { lines?: string[] };
  return parsed.lines || [];
}

// Run any two rosters through the same engine, for the behavior trial. Returns the trace or the engine's error.
export async function simulateTrial(input: { cols: number; rows: number; a: MatchUnit[]; b: MatchUnit[]; seed: string }) {
  const mod = await loadCombat();
  const raw = mod.simulate_json(JSON.stringify({ cols: input.cols, rows: input.rows, a: input.a, b: input.b, seed: [...seedBytes(input.seed)] }));
  const parsed = JSON.parse(raw) as { lines?: string[]; winner?: number | null; error?: string };
  return { lines: parsed.lines || [], winner: parsed.winner ?? null, error: parsed.error || "" };
}

export function randomSeed() {
  return [...crypto.getRandomValues(new Uint8Array(32))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function blockedTiles(cols: number, rows: number, seed: string) {
  const mod = await loadCombat();
  const raw = mod.blocked_json(cols, rows, seedBytes(seed));
  const parsed = JSON.parse(raw) as { col: number; row: number }[] | { error: string };
  if (!Array.isArray(parsed)) return [];
  return parsed;
}

export async function installDevSimulate() {
  const mod = await loadCombat();
  (globalThis as { __hzSimulate?: (input: string) => string }).__hzSimulate = (input) => mod.simulate_json(input);
}
