// Types for interpret.mjs, read by the app's TypeScript check.
export const MOVE_KINDS: string[];
export const EXTREMA: string[];
export const STATS: string[];
export const VERBS: string[];
export const SIDES: string[];
export const EFFECTS: string[];
export const AIMS: string[];
export const LASTING_EFFECTS: string[];
export type CastSpec = { damage: number; range: number; aoe: number; effect: number; aim: number; power: number; rounds: number; cooldown: number };
export function describeCast(cast: CastSpec): string;
export function interpretCatalog(raw: unknown): {
  battlegrounds: { id: number; slug: string; name: string; budget: number; stake: number; cols: number; rows: number }[];
  races: {
    id: number;
    name: string;
    slug: string;
    units: {
      id: number;
      name: string;
      /** Board and card swatch, `#rrggbb`. */
      color: string;
      cost: number;
      hp: number;
      atk: number;
      range: number;
      speed: number;
      actions: number;
      cast: CastSpec;
    }[];
  }[];
  behaviors: {
    name: string;
    elements: {
      movement: { kind: number; extremum: number; stat: number; side: number; stop: number } | null;
      actions: { verb: number; extremum: number; stat: number; side: number }[];
    }[];
    body: number[];
  }[];
};
export function encodeBehavior(elements: unknown): number[] | null;
export function parseBehavior(body: number[]): {
  movement: { kind: number; extremum: number; stat: number; side: number; stop: number } | null;
  actions: { verb: number; extremum: number; stat: number; side: number }[];
}[] | null;
export function standardName(elements: unknown, standards: { name: string; elements: unknown }[]): string;
export function describeBehavior(elements: unknown, standards: { name: string; elements: unknown }[]): string;
export const MAX_BEHAVIOR_NAME_LEN: number;
export function clipBehaviorName(text: string): string;
export function nameBehavior(elements: unknown, standards: { name: string; elements: unknown }[]): string;
