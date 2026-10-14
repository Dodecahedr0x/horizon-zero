import { lamportsDelegatedTransferIx } from "@magicblock-labs/ephemeral-rollups-sdk";
import { Connection, PublicKey, Transaction, type AccountInfo, type TransactionInstruction } from "@solana/web3.js";
import type { WalletContextState } from "@solana/wallet-adapter-react";
import {
  BATTLEGROUNDS,
  DELEGATION_PROGRAM_ID,
  PLAYER_LEN,
  PROGRAM_ID,
  armyPda,
  claimFeesIx,
  closeArmyIx,
  computeBudgetIx,
  configPda,
  createArmyIx,
  createBehaviorIx,
  customErrorCode,
  decodeArmyHead,
  decodeBattle,
  decodeBattleground,
  decodeConfig,
  decodeOutbox,
  decodePlayer,
  delegateOutboxIx,
  delegatePlayerIx,
  delegateTreasuryOutboxIx,
  fundBudgetIx,
  fundOutboxIx,
  fundTreasuryOutboxIx,
  lockArmyIx,
  matchPda,
  nameBehavior,
  outboxPda,
  parseBehavior,
  playerPda,
  programError,
  registerPlayerIx,
  releaseOutboxIx,
  resolvedOutcome,
  setFeeIx,
  setSegregationIx,
  settleMatchIx,
  treasuryOutboxPda,
  unlockArmyIx,
  withdrawIx,
  type ElementSpec,
} from "./codec";
import type { ChainAdapter, Match } from "./devChain";
import { ER_RPC_URL, ORACLE_QUEUE, RPC_URL } from "./network";

const POLL_MS = 500;
// How long to wait for a confirmation, for the rollup to see a delegation, for a VRF seed, for an
// Outbox to come back to Solana, and then for its post-undelegate action to pay.
const CONFIRM_WAIT_MS = 60_000;
const DELEGATION_WAIT_MS = 60_000;
const SEED_WAIT_MS = 60_000;
const RELEASE_WAIT_MS = 30_000;
const ACTION_WAIT_MS = 5_000;
// A legacy transaction fits about 33 distinct accounts. lock_army's fixed accounts, the program and
// the compute-budget program take 15; behaviors, candidates and their Players share the rest.
const LOCK_ACCOUNT_LIMIT = 32;
const LOCK_FIXED_ACCOUNTS = 15;

/** A program error, named from `HorizonError`. */
export class ProgramError extends Error {
  readonly code: number;
  readonly errorName: string;
  readonly signature?: string;
  constructor(code: number, errorName: string, message: string, signature?: string) {
    super(message);
    this.code = code;
    this.errorName = errorName;
    this.signature = signature;
  }
}

/**
 * The work was sent but has not finished: a transaction not confirmed yet, or a top-up, delegation
 * or withdrawal still on its way. It may still land; check the balance before trying again.
 */
export class PendingError extends Error {
  readonly signature?: string;
  constructor(message: string, signature?: string) {
    super(message);
    this.signature = signature;
  }
}

async function read<T>(path: string): Promise<T> {
  const response = await fetch(`/api${path}`);
  if (!response.ok) throw new Error(`indexer ${response.status}`);
  return response.json();
}

function groundName(id: number) {
  return BATTLEGROUNDS.find((ground) => ground.id === id)?.name || `Battleground ${id}`;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function lamports(value: string | undefined) {
  return BigInt(value ?? "0");
}

/** `err` as a ProgramError when it carries one of this program's codes, else unchanged. */
function friendly(err: unknown, signature?: string) {
  const source = err as { logs?: string[]; transactionLogs?: string[]; message?: string };
  const code = customErrorCode({ logs: source.logs ?? source.transactionLogs, message: source.message });
  const known = code === null ? null : programError(code);
  return known ? new ProgramError(known.code, known.name, known.message, signature) : err;
}

/**
 * Polls `check`, a read, until it returns a value; returns null after `ms`. A read that throws is
 * treated as transient and tried again until the deadline.
 */
async function until<T>(ms: number, check: () => Promise<T | null>, signal?: AbortSignal) {
  for (const end = Date.now() + ms; ;) {
    signal?.throwIfAborted();
    try {
      const value = await check();
      if (value !== null) return value;
    } catch {
      // transient: try again
    }
    if (Date.now() >= end) return null;
    await sleep(POLL_MS);
  }
}

type UnitRow = { kind: number; behavior: string; body?: number[]; elements?: ElementSpec[]; col: number; row: number };
type ArmyRow = { pubkey: string; owner: string; battleground: string; race: number; idx: number; status: number; units: UnitRow[] };
type GroundRow = {
  pubkey: string;
  battlegroundId: number;
  budget: number;
  stake: string;
  cols: number;
  rows: number;
  queue: string[];
  matchSeq: number;
};

/**
 * Where an Outbox stands. `undelegated`: owned by the program on Solana, maybe holding an unpaid
 * amount. `ready`: delegated and empty in the rollup. `funded`: delegated, with an amount whose
 * `withdraw` never ran. `inFlight`: delegated on Solana but not the program's in the rollup, which
 * is a withdrawal being committed and undelegated, or a delegation the rollup has not picked up.
 */
type OutboxState =
  | { kind: "missing" }
  | { kind: "undelegated"; amount: bigint; owner: PublicKey }
  | { kind: "ready" }
  | { kind: "funded"; amount: bigint }
  | { kind: "inFlight"; amount: bigint };

/**
 * Solana holds the Player, the Outbox and their delegations; the rollup holds the live Player,
 * Config, battlegrounds, armies, behaviors and battles. Each transaction goes to one of the two
 * connections, with that connection's blockhash, signed by the wallet.
 */
export function createSolanaChain(wallet: WalletContextState): ChainAdapter {
  if (!ER_RPC_URL) throw new Error("VITE_ER_RPC_URL is not set: name the rollup that serves Config's validator");
  const base = new Connection(RPC_URL, "confirmed");
  const er = new Connection(ER_RPC_URL, "confirmed");
  let playerRent: Promise<number> | null = null;

  function me() {
    if (!wallet.publicKey) throw new Error("Connect a wallet");
    return wallet.publicKey;
  }

  function rent() {
    playerRent ??= base.getMinimumBalanceForRentExemption(PLAYER_LEN).catch((err) => {
      playerRent = null;
      throw err;
    });
    return playerRent;
  }

  /**
   * Polls the signature's status, which works the same on Solana and in the rollup. Returns once
   * it is confirmed; throws the program error if it failed; throws PendingError if it is still
   * unknown at the deadline.
   */
  async function confirm(connection: Connection, signature: string) {
    const status = await until(CONFIRM_WAIT_MS, async () => {
      const { value } = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
      const found = value[0];
      return found && (found.err || found.confirmationStatus === "confirmed" || found.confirmationStatus === "finalized") ? found : null;
    });
    if (!status) throw new PendingError(`Transaction ${signature} was sent but is not confirmed yet; it may still land`, signature);
    if (status.err) {
      const code = customErrorCode({ err: status.err });
      const known = code === null ? null : programError(code);
      if (known) throw new ProgramError(known.code, known.name, known.message, signature);
      throw new Error(`Transaction ${signature} failed: ${JSON.stringify(status.err)}`);
    }
  }

  async function send(connection: Connection, ...instructions: TransactionInstruction[]): Promise<string> {
    const payer = me();
    for (let attempt = 0; ; attempt += 1) {
      const tx = new Transaction().add(...instructions);
      tx.feePayer = payer;
      tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
      let signature: string;
      try {
        // Sign, then send through our own connection: a wallet that sends for itself would send a
        // rollup transaction to Solana.
        if (wallet.signTransaction) {
          const signed = await wallet.signTransaction(tx);
          signature = await connection.sendRawTransaction(signed.serialize());
        } else if (connection === base && wallet.sendTransaction) {
          signature = await wallet.sendTransaction(tx, connection);
        } else {
          throw new Error("This wallet cannot sign transactions for the rollup");
        }
      } catch (err) {
        // A rollup blockhash can expire while the wallet waits for approval: sign again once.
        if (attempt === 0 && /blockhash not found/i.test((err as Error)?.message ?? "")) continue;
        throw friendly(err);
      }
      await confirm(connection, signature);
      return signature;
    }
  }

  async function ownedInRollup(account: PublicKey) {
    const info = await er.getAccountInfo(account);
    return info && info.owner.equals(PROGRAM_ID) ? info : null;
  }

  async function outboxState(outbox: PublicKey): Promise<OutboxState> {
    const onBase = await base.getAccountInfo(outbox);
    if (!onBase) return { kind: "missing" };
    if (onBase.owner.equals(PROGRAM_ID)) {
      const state = decodeOutbox(onBase.data);
      return { kind: "undelegated", amount: lamports(state?.amount), owner: new PublicKey(state?.owner ?? PublicKey.default) };
    }
    if (!onBase.owner.equals(DELEGATION_PROGRAM_ID)) throw new Error("The Outbox has an unexpected owner");
    const inRollup = await er.getAccountInfo(outbox);
    const amount = lamports(inRollup ? decodeOutbox(inRollup.data)?.amount : "0");
    if (!inRollup?.owner.equals(PROGRAM_ID)) return { kind: "inFlight", amount };
    return amount > 0n ? { kind: "funded", amount } : { kind: "ready" };
  }

  /**
   * Gets an Outbox ready to fund in the rollup: delegated, empty and visible there. An undelegated
   * Outbox still holding an amount is released in the same Solana transaction that delegates it.
   * Throws PendingError while a withdrawal is in flight, and after sending `flush` for an amount an
   * earlier `fund_outbox` left without its `withdraw`, so nothing is funded twice.
   */
  async function readyOutbox(outbox: PublicKey, missing: string, delegate: () => TransactionInstruction, flush: () => TransactionInstruction) {
    const state = await outboxState(outbox);
    if (state.kind === "missing") throw new Error(missing);
    if (state.kind === "ready") return;
    if (state.kind === "inFlight") throw new PendingError("An earlier withdrawal is still on its way; try again once it has arrived");
    if (state.kind === "funded") {
      const signature = await send(er, flush());
      await awaitRelease(outbox);
      throw new PendingError(`An earlier withdrawal of ${state.amount} lamports was waiting in the Outbox; it has been paid out, and nothing more was withdrawn`, signature);
    }
    const instructions = [];
    if (state.amount > 0n) instructions.push(releaseOutboxIx(outbox, state.owner));
    instructions.push(delegate());
    const signature = await send(base, ...instructions);
    // The wait starts after the wallet approved and the delegation confirmed.
    const ready = await until(DELEGATION_WAIT_MS, async () => ((await outboxState(outbox)).kind === "ready" ? true : null));
    if (!ready) throw new PendingError("The Outbox was delegated but the rollup has not picked it up yet; try again shortly", signature);
  }

  /**
   * Waits for the Outbox to come back to Solana and for the post-undelegate action to pay it, and
   * sends `release_outbox` itself only if the action has not paid a few seconds later.
   */
  async function awaitRelease(outbox: PublicKey) {
    const back = await until(RELEASE_WAIT_MS, async () => {
      const info = await base.getAccountInfo(outbox);
      return info && info.owner.equals(PROGRAM_ID) ? info : null;
    });
    if (!back) throw new PendingError("The withdrawal was sent and is still on its way to Solana; it may still arrive");
    const unpaid = (info: AccountInfo<Buffer>) => {
      const state = decodeOutbox(info.data);
      return state && lamports(state.amount) > 0n ? state : null;
    };
    if (!unpaid(back)) return;
    const paid = await until(ACTION_WAIT_MS, async () => {
      const info = await base.getAccountInfo(outbox);
      return info && !unpaid(info) ? true : null;
    });
    if (paid) return;
    const state = unpaid((await base.getAccountInfo(outbox))!);
    if (state) await send(base, releaseOutboxIx(outbox, new PublicKey(state.owner)));
  }

  /**
   * Sends `settle_match` and returns the outcome byte from its log, or null when it is unknown:
   * another caller settled the battle first (`AlreadyResolved`), or the log could not be read.
   * `NotSeeded` and any other error are thrown unchanged.
   */
  async function settleOnce(match: Match) {
    let signature: string;
    try {
      signature = await send(er, settleMatchIx(match));
    } catch (err) {
      if (err instanceof ProgramError && err.errorName === "AlreadyResolved") return null;
      throw err;
    }
    const tx = await er.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }).catch(() => null);
    return resolvedOutcome(tx?.meta?.logMessages ?? [], match.pubkey);
  }

  /** The settled match. An unknown outcome comes from the indexer, or stays 0 (pending) until it has the row. */
  async function resolved(match: Match, outcome: number | null): Promise<Match> {
    if (outcome !== null) return { ...match, status: 1, outcome };
    const indexed = await read<Match | null>(`/matches/${match.pubkey}`).catch(() => null);
    return indexed || { ...match, status: 1 };
  }

  /** Polls a new battle until VRF seeds it, then settles it. Returns it still Awaiting if the seed is late. */
  async function settleWhenSeeded(battle: PublicKey): Promise<Match | null> {
    let last: Match | null = null;
    const seeded = await until(SEED_WAIT_MS, async () => {
      const info = await er.getAccountInfo(battle);
      const state = info ? decodeBattle(battle, info.data) : null;
      if (!state) return "closed" as const;
      last = state;
      return state.status === 2 ? state : null;
    });
    if (seeded === null) return last;
    if (seeded === "closed") return last ? resolved(last, null) : null;
    return resolved(seeded, await settleOnce(seeded));
  }

  async function battlegrounds() {
    const rows = await read<GroundRow[]>("/battlegrounds");
    // The queue and match counter change in the rollup; the indexer may lag.
    const live = rows.length ? await er.getMultipleAccountsInfo(rows.map((row) => new PublicKey(row.pubkey))) : [];
    return rows.map((row, i) => {
      const state = live[i] ? decodeBattleground(live[i]!.data) : null;
      return {
        pubkey: row.pubkey,
        battlegroundId: row.battlegroundId,
        name: groundName(row.battlegroundId),
        budget: row.budget,
        stake: row.stake,
        cols: row.cols,
        rows: row.rows,
        queue: state?.queue ?? row.queue ?? [],
        matchSeq: state?.matchSeq ?? row.matchSeq,
      };
    });
  }

  /** Sends lock_army against the battleground as the rollup holds it now. */
  async function sendLock(owner: PublicKey, army: { pubkey: string; battleground: string; units: { behavior: string }[] }) {
    const ground = new PublicKey(army.battleground);
    const groundInfo = await er.getAccountInfo(ground);
    const state = groundInfo ? decodeBattleground(groundInfo.data) : null;
    if (!state) throw new Error("Battleground is missing");
    const behaviors = [...new Set(army.units.map((unit) => unit.behavior))].map((key) => new PublicKey(key));
    // Offer the queued armies of other wallets, in queue order, with their owners' Players so the
    // program can match a funded one and evict an unfunded one.
    const queued = state.queue.map((key) => new PublicKey(key));
    const heads = queued.length ? await er.getMultipleAccountsInfo(queued) : [];
    const candidates: { army: PublicKey; owner: PublicKey }[] = [];
    const owners = new Set<string>();
    for (const [i, info] of heads.entries()) {
      const head = info ? decodeArmyHead(info.data) : null;
      if (!head || head.status !== 1 || head.owner === owner.toBase58()) continue;
      const added = owners.has(head.owner) ? 1 : 2;
      if (LOCK_FIXED_ACCOUNTS + behaviors.length + candidates.length + owners.size + added > LOCK_ACCOUNT_LIMIT) break;
      candidates.push({ army: queued[i], owner: new PublicKey(head.owner) });
      owners.add(head.owner);
    }
    await send(er, computeBudgetIx(), lockArmyIx({
      player: owner,
      battlegroundId: state.battlegroundId,
      army: new PublicKey(army.pubkey),
      behaviors,
      queue: ORACLE_QUEUE,
      seq: state.matchSeq,
      candidates,
    }));
    return matchPda(ground, state.matchSeq);
  }

  return {
    async owner() {
      return me().toBase58();
    },
    async behaviors() {
      const rows = await read<{ pubkey: string; creator: string; body: number[] }[]>("/behaviors");
      return rows.map((row) => {
        const elements = parseBehavior(row.body || []) || [];
        return { pubkey: row.pubkey, creator: row.creator, name: nameBehavior(elements), elements };
      });
    },
    battlegrounds,
    async armies(owner) {
      const indexed = await read<ArmyRow[]>(`/armies?owner=${owner}`);
      const known = await battlegrounds();
      // The indexer learns of a closed army or a new status late; the rollup knows at once.
      const live = indexed.length ? await er.getMultipleAccountsInfo(indexed.map((row) => new PublicKey(row.pubkey))) : [];
      return indexed.flatMap((row, i) => {
        const head = live[i] ? decodeArmyHead(live[i]!.data) : null;
        if (!head) return [];
        return [{
          pubkey: row.pubkey,
          owner: head.owner,
          battleground: head.battleground,
          battlegroundId: known.find((ground) => ground.pubkey === head.battleground)?.battlegroundId ?? 0,
          race: row.race,
          index: row.idx,
          status: head.status,
          units: (row.units || []).map((unit) => ({
            ...unit,
            elements: unit.elements || parseBehavior(unit.body || []) || [],
          })),
        }];
      });
    },
    async createBehavior(elements) {
      await send(er, createBehaviorIx(me(), elements));
    },
    async createArmy(battlegroundId, units, race) {
      const owner = me();
      const existing = await this.armies(owner.toBase58());
      let index = existing.reduce((max, army) => Math.max(max, army.index + 1), 0);
      // The indexer may not list an army created a moment ago: skip indexes taken in the rollup.
      for (;;) {
        const batch = Array.from({ length: 8 }, (_, i) => armyPda(owner, index + i));
        const taken = await er.getMultipleAccountsInfo(batch);
        const free = taken.findIndex((info) => !info || info.data.length === 0);
        if (free >= 0) {
          index += free;
          break;
        }
        index += batch.length;
      }
      await send(er, createArmyIx(
        owner,
        battlegroundId,
        index,
        race,
        units.map((unit) => ({ kind: unit.kind, behavior: new PublicKey(unit.behavior), col: unit.col, row: unit.row })),
      ));
    },
    async lock(army) {
      const owner = me();
      let battle: PublicKey;
      try {
        battle = await sendLock(owner, army);
      } catch (err) {
        // Another lock opened a match between our read of match_seq and ours: read it again once.
        if (!(err instanceof ProgramError && err.errorName === "BadMatch")) throw err;
        battle = await sendLock(owner, army);
      }
      if (!(await ownedInRollup(battle))) return null;
      return settleWhenSeeded(battle);
    },
    async unlock(army) {
      await send(er, unlockArmyIx(me(), army.battlegroundId, new PublicKey(army.pubkey)));
    },
    async closeArmy(army) {
      await send(er, closeArmyIx(me(), new PublicKey(army.pubkey)));
    },
    async player() {
      const owner = me();
      const account = await er.getAccountInfo(playerPda(owner));
      const state = account ? decodePlayer(account.data) : null;
      if (!account || !state) return null;
      const claimed = BigInt(await rent()) + lamports(state.budget) + lamports(state.winnings) + lamports(state.locked);
      const free = BigInt(account.lamports) - claimed;
      const outbox = await outboxState(outboxPda(owner));
      // undelegated: waiting for release_outbox; funded: waiting for its withdraw; inFlight: on its way.
      const pending = outbox.kind === "undelegated" || outbox.kind === "funded" || outbox.kind === "inFlight" ? outbox.amount : 0n;
      return {
        free: (free > 0n ? free : 0n).toString(),
        budget: state.budget,
        winnings: state.winnings,
        locked: state.locked,
        segregate: state.segregate,
        outboxPending: pending.toString(),
        outboxInFlight: outbox.kind === "inFlight",
      };
    },
    async register(depositLamports) {
      const owner = me();
      const player = playerPda(owner);
      const [playerOnBase, outboxOnBase] = await base.getMultipleAccountsInfo([player, outboxPda(owner)]);
      // One transaction: create both accounts and delegate both. A retry after a partial
      // registration sends only the missing delegations and never deposits again: an existing
      // Player is topped up with topUp.
      const instructions = [];
      if (!playerOnBase) instructions.push(registerPlayerIx(owner, depositLamports));
      if (!playerOnBase || playerOnBase.owner.equals(PROGRAM_ID)) instructions.push(delegatePlayerIx(owner));
      const outboxState = outboxOnBase?.owner.equals(PROGRAM_ID) ? decodeOutbox(outboxOnBase.data) : null;
      if (!outboxOnBase || (outboxState && lamports(outboxState.amount) === 0n)) instructions.push(delegateOutboxIx(owner));
      const signature = instructions.length ? await send(base, ...instructions) : undefined;
      if (!(await until(DELEGATION_WAIT_MS, () => ownedInRollup(player)))) {
        throw new PendingError("Registered on Solana; the rollup has not picked up the Player yet", signature);
      }
    },
    async topUp(amount) {
      const owner = me();
      const player = playerPda(owner);
      // Measure the credit against the rollup's copy, so wait until the rollup has it.
      const delegated = await until(DELEGATION_WAIT_MS, () => ownedInRollup(player));
      if (!delegated) throw new Error("The rollup has not picked up the Player yet; register first or try again");
      const before = delegated.lamports;
      const salt = crypto.getRandomValues(new Uint8Array(32));
      const signature = await send(base, lamportsDelegatedTransferIx(owner, player, amount, salt));
      // The rollup credits the Player about a second later.
      const credited = await until(DELEGATION_WAIT_MS, async () => ((await er.getAccountInfo(player))?.lamports ?? 0) > before || null);
      if (!credited) throw new PendingError("The top-up was sent; the rollup has not credited it yet", signature);
    },
    async fundBudget(amount) {
      await send(er, fundBudgetIx(me(), amount));
    },
    async withdraw(amount) {
      const owner = me();
      if (amount <= 0n) throw new Error("Withdraw a positive amount");
      const balance = await this.player();
      if (!balance) throw new Error("Register first");
      const available = lamports(balance.free) + lamports(balance.winnings) + lamports(balance.budget);
      if (amount > available) throw new Error(`You can withdraw at most ${available} lamports`);
      const outbox = outboxPda(owner);
      await readyOutbox(outbox, "Register first", () => delegateOutboxIx(owner), () => withdrawIx(owner));
      await send(er, fundOutboxIx(owner, amount), withdrawIx(owner));
      await awaitRelease(outbox);
    },
    async setSegregation(segregate) {
      await send(er, setSegregationIx(me(), segregate));
    },
    async settle(match) {
      await settleOnce(match);
    },
    async admin() {
      const info = await er.getAccountInfo(configPda());
      const state = info ? decodeConfig(info.data) : null;
      return state ? { admin: state.admin, feeBps: state.feeBps, fees: state.fees } : null;
    },
    async claimFees() {
      const admin = me();
      const config = await this.admin();
      if (!config) throw new Error("Config is missing");
      if (lamports(config.fees) === 0n) throw new Error("There are no fees to claim");
      const outbox = treasuryOutboxPda();
      await readyOutbox(outbox, "The treasury Outbox does not exist: run init_treasury_outbox", () => delegateTreasuryOutboxIx(admin), () => claimFeesIx(admin));
      await send(er, fundTreasuryOutboxIx(admin), claimFeesIx(admin));
      await awaitRelease(outbox);
    },
    async setFee(bps) {
      await send(er, setFeeIx(me(), bps));
    },
    async matches(owner) {
      const all = await read<Match[]>("/matches");
      return all.filter((item) => item.playerA === owner || item.playerB === owner).slice(0, 20);
    },
    async match(pubkey) {
      const indexed = await read<Match | null>(`/matches/${pubkey}`).catch(() => null);
      if (indexed) return indexed;
      // A battle the indexer has not seen yet, still open in the rollup.
      const key = new PublicKey(pubkey);
      const info = await er.getAccountInfo(key);
      return info ? decodeBattle(key, info.data) : null;
    },
  };
}
