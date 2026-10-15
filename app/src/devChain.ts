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
/**
 * The connected wallet's Player, read in the rollup. Lamport amounts are decimal strings, like `stake`.
 * `free` is what the Player holds beyond its rent and the three counters. `outboxPending` is a
 * withdrawal that has left the Player but has not been paid to the wallet yet; `outboxInFlight` is
 * true while it is being committed and undelegated, so no new withdrawal can start.
 */
export type PlayerBalance = {
  free: string;
  budget: string;
  winnings: string;
  locked: string;
  segregate: boolean;
  outboxPending: string;
  outboxInFlight: boolean;
};
/** Config, read in the rollup. `fees` is the claimable fee balance in lamports. */
export type ProtocolConfig = { admin: string; feeBps: number; fees: string };
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
/**
 * A battle. `status`: 0 Awaiting its VRF seed, 1 Resolved, 2 Seeded (ready to settle), 3 Cancelled
 * (the indexer's value for a battle `cancel_match` closed; the chain account is gone then).
 * `openedAt` is the unix time `lock_army` opened it, when known: `cancel_match` waits
 * `CANCEL_AFTER_SECS` from it.
 */
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
  openedAt?: number | null;
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
  /** The connected wallet's Player, or null before it registers. */
  player(): Promise<PlayerBalance | null>;
  /** Creates the Player and Outbox with `depositLamports` free, and delegates both to the rollup. */
  register(depositLamports: bigint): Promise<void>;
  /** Moves lamports from the wallet into the delegated Player's free balance. */
  topUp(lamports: bigint): Promise<void>;
  /** Moves free lamports into the stake budget. */
  fundBudget(lamports: bigint): Promise<void>;
  /**
   * Pays lamports from the Player (free, then winnings, then budget) back to the wallet through the
   * Outbox. If an earlier withdrawal was still waiting, pays that instead and throws RecoveredError.
   */
  withdraw(lamports: bigint): Promise<void>;
  /**
   * Pays out an amount an earlier withdrawal (or, with "treasury", an earlier fee claim) left
   * behind. "paid" when it paid something, "none" when there was nothing to pay, "inFlight" while
   * a withdrawal or delegation is still on its way. Throws when the Outbox does not exist.
   */
  releasePending(which?: "player" | "treasury"): Promise<"none" | "paid" | "inFlight">;
  setSegregation(segregate: boolean): Promise<void>;
  /** Settles a Seeded battle. Anyone may. */
  settle(match: Match): Promise<void>;
  /**
   * Cancels an Awaiting battle whose seed never came, `CANCEL_AFTER_SECS` after it opened: both
   * stakes go back to their budgets. Anyone may. Dev mode settles every battle inside `lock`, so
   * there it always throws.
   */
  cancel(match: Match): Promise<void>;
  /** Config, or null before `initialize`. */
  admin(): Promise<ProtocolConfig | null>;
  /** Admin only: pays every claimable fee to the admin wallet through the treasury Outbox. */
  claimFees(): Promise<void>;
  /** Admin only. */
  setFee(bps: number): Promise<void>;
  /** The owner's latest matches, newest first. */
  matches(owner: string): Promise<Match[]>;
  match(pubkey: string): Promise<Match | null>;
}
