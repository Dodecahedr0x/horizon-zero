import type { CastSpec, ElementSpec } from "./codec";

export type Behavior = { pubkey: string; creator: string; name: string; elements: ElementSpec[] };
export type ArmyUnit = { kind: number; behavior: string; elements: ElementSpec[]; col: number; row: number };
export type DraftUnit = { kind: number; behavior: string; col: number; row: number };
export type Army = {
  pubkey: string;
  owner: string;
  battleground: string;
  battlegroundId: number;
  race: number;
  index: number;
  status: number;
  units: ArmyUnit[];
};
export type Battleground = {
  pubkey: string;
  battlegroundId: number;
  name: string;
  budget: number;
  stake: string;
  cols: number;
  rows: number;
  queue: string[];
  matchSeq: number;
};
/** Lamport amounts as decimal strings, like `stake`. */
export type Pot = { budget: string; winnings: string; segregate: boolean };
export type MatchUnit = {
  kind: number;
  body: number[];
  col: number;
  row: number;
  cost?: number;
  hp?: number;
  atk?: number;
  range?: number;
  speed?: number;
  actions?: number;
  cast?: CastSpec;
  race?: number;
};
export type Match = {
  pubkey: string;
  battleground: string;
  armyA: string;
  armyB: string;
  playerA: string;
  playerB: string;
  stake: string;
  cols: number;
  rows: number;
  unitsA: MatchUnit[];
  unitsB: MatchUnit[];
  status: number;
  seed: string;
  outcome: number;
};

export interface ChainAdapter {
  owner(): Promise<string>;
  behaviors(): Promise<Behavior[]>;
  battlegrounds(): Promise<Battleground[]>;
  armies(owner: string): Promise<Army[]>;
  createBehavior(elements: ElementSpec[]): Promise<void>;
  createArmy(battlegroundId: number, units: DraftUnit[], race: number): Promise<void>;
  lock(army: Army): Promise<Match | null>;
  unlock(army: Army): Promise<void>;
  closeArmy(army: Army): Promise<void>;
  /** The connected player's pot on a battleground, or null before it is first funded. */
  pot(battlegroundId: number): Promise<Pot | null>;
  fundPot(battlegroundId: number, lamports: bigint): Promise<void>;
  withdrawPot(battlegroundId: number, lamports: bigint): Promise<void>;
  setSegregation(battlegroundId: number, segregate: boolean): Promise<void>;
  /** The owner's latest matches, newest first. */
  matches(owner: string): Promise<Match[]>;
  match(pubkey: string): Promise<Match | null>;
}
