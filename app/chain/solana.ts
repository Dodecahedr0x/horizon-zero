import { lamportsDelegatedTransferIx } from "@magicblock-labs/ephemeral-rollups-sdk";
import { Connection, PublicKey, Transaction, type AccountInfo, type TransactionInstruction } from "@solana/web3.js";
import {
  BATTLEGROUNDS,
  DELEGATION_PROGRAM_ID,
  PLAYER_LEN,
  PROGRAM_ID,
  armyPda,
  cancelMatchIx,
  claimFeesIx,
  closeArmyIx,
  computeBudgetIx,
  configPda,
  createArmyIx,
  createBehaviorIx,
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
  horizonErrorCode,
  lockArmyIx,
  lockOpens,
  MATCH_WINDOW,
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
} from "../src/codec.ts";
import type { ChainAdapter, Match } from "../src/devChain.ts";

const POLL_MS = 500;
// How long to wait for a confirmation, for the rollup to see a delegation, for a VRF seed, for an
// Outbox to come back to Solana, and then for its post-undelegate action to pay.
const CONFIRM_WAIT_MS = 60_000;
const DELEGATION_WAIT_MS = 60_000;
const SEED_WAIT_MS = 60_000;
const RELEASE_WAIT_MS = 30_000;
const ACTION_WAIT_MS = 5_000;
// How many army indexes past the indexer's highest createArmy checks in the rollup.
const ARMY_INDEX_PROBE = 64;

/** A program error, named from `HorizonError`. */
export class ProgramError extends Error {
  override readonly name = "ProgramError";
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
 * An earlier withdrawal or claim was still waiting in the Outbox. The call paid it out and did not
 * start the new one: withdraw again if that was meant.
 */
export class RecoveredError extends Error {
  override readonly name = "RecoveredError";
  readonly amount: bigint;
  constructor(amount: bigint) {
    super(`An earlier withdrawal of ${amount} lamports was waiting and has been paid out; nothing more was withdrawn. Withdraw again if you meant to.`);
    this.amount = amount;
  }
}

/**
 * The work was sent but has not finished: a transaction not confirmed yet, or a top-up, delegation
 * or withdrawal still on its way. It may still land; check the balance before trying again.
 */
export class PendingError extends Error {
  override readonly name = "PendingError";
  readonly signature?: string;
  constructor(message: string, signature?: string) {
    super(message);
    this.signature = signature;
  }
}

/** Where the server reaches Solana, the rollup and the indexer, and the VRF queue lock_army asks. */
export type ChainConfig = { rpcUrl: string; erRpcUrl: string; oracleQueue: PublicKey; indexerUrl: string };

/**
 * The wallet a call acts for. The server builds every transaction with `owner` as the fee payer;
 * `sign` hands it to the browser and resolves with the wallet's signed copy. `owner` is null for a
 * read made before a wallet connects.
 */
export type Signer = { owner: PublicKey | null; sign(tx: Transaction): Promise<Transaction> };

function groundName(id: number) {
  return BATTLEGROUNDS.find((ground) => ground.id === id)?.name || `Battleground ${id}`;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function lamports(value: string | undefined) {
  return BigInt(value ?? "0");
}

/** A ProgramError when the logs show one of this program's codes (see `horizonErrorCode`), else null. */
function programFailure(logs: readonly string[] | undefined, signature?: string) {
  const code = horizonErrorCode(logs ?? []);
  const known = code === null ? null : programError(code);
  return known ? new ProgramError(known.code, known.name, known.message, signature) : null;
}

/**
 * A lock that passed the battle with the wrong access for what the program did: writable when it
 * only queued (the rollup refuses the write, `InvalidWritableAccount`), or read-only when it opened
 * a match (creating the battle escalates its privilege).
 */
function queueRace(err: unknown) {
  const source = err as { message?: string; logs?: string[]; transactionLogs?: string[] };
  const text = [source?.message ?? "", ...(source?.logs ?? source?.transactionLogs ?? [])].join("\n");
  // The local rollup's preflight words them "Transaction loads a writable account that cannot be
  // written" and "Cross-program invocation with unauthorized signer or writable account".
  return /InvalidWritableAccount|writable account that cannot be written|PrivilegeEscalation|unauthorized signer or writable account/i.test(text);
}

/**
 * Polls `check`, a read, until it returns a value; returns null after `ms`. A read that throws is
 * logged with console.debug and tried again until the deadline: RPC and network failures are
 * transient, and a read that keeps failing ends as a timeout.
 */
async function until<T>(ms: number, check: () => Promise<T | null>) {
  for (const end = Date.now() + ms; ;) {
    try {
      const value = await check();
      if (value !== null) return value;
    } catch (err) {
      console.debug("poll read failed; retrying", err);
    }
    if (Date.now() >= end) return null;
    await sleep(POLL_MS);
  }
}

/** An indexer match row: its `openAt` is the battle's `opened_at` (or, failing that, when it was first seen). */
type IndexedMatch = Match & { openAt?: number | null };

function fromIndexer(row: IndexedMatch): Match {
  return { ...row, openedAt: row.openedAt ?? row.openAt ?? null };
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
 * `withdraw` never ran. `inFlight`: delegated on Solana, and the delegation program's in the rollup:
 * a withdrawal being committed and undelegated. `unseen`: delegated on Solana, and the rollup has
 * no copy yet.
 */
type OutboxState =
  | { kind: "missing" }
  | { kind: "undelegated"; amount: bigint; owner: PublicKey }
  | { kind: "ready" }
  | { kind: "funded"; amount: bigint }
  | { kind: "inFlight"; amount: bigint }
  | { kind: "unseen" };

/** One of the two Outboxes and the instructions that delegate, fund and flush it. */
type OutboxTarget = {
  outbox: PublicKey;
  missing: string;
  delegate: () => TransactionInstruction;
  flush: () => TransactionInstruction;
};

/** The server's connections, kept for the life of the process and shared by every call. */
export type SolanaNet = {
  base: Connection;
  er: Connection;
  oracleQueue: PublicKey;
  read<T>(path: string): Promise<T>;
  rent(): Promise<number>;
};

export function connectSolana(config: ChainConfig): SolanaNet {
  const base = new Connection(config.rpcUrl, "confirmed");
  const indexer = config.indexerUrl.endsWith("/") ? config.indexerUrl : `${config.indexerUrl}/`;
  let playerRent: Promise<number> | null = null;
  return {
    base,
    er: new Connection(config.erRpcUrl, "confirmed"),
    oracleQueue: config.oracleQueue,
    async read<T>(path: string): Promise<T> {
      const response = await fetch(new URL(path.slice(1), indexer));
      if (!response.ok) throw new Error(`indexer ${response.status}`);
      return response.json();
    },
    rent() {
      playerRent ??= base.getMinimumBalanceForRentExemption(PLAYER_LEN).catch((err) => {
        playerRent = null;
        throw err;
      });
      return playerRent;
    },
  };
}

/**
 * Solana holds the Player, the Outbox and their delegations; the rollup holds the live Player,
 * Config, battlegrounds, armies, behaviors and battles. Each transaction goes to one of the two
 * connections, with that connection's blockhash, signed by the wallet. Made for one call.
 */
export function createSolanaChain(wallet: Signer, net: SolanaNet): ChainAdapter {
  const { base, er, read, rent } = net;

  function me() {
    if (!wallet.owner) throw new Error("Connect a wallet");
    return wallet.owner;
  }

  /**
   * Polls the signature's status, which works the same on Solana and in the rollup. Returns once
   * it is confirmed; throws the program error if it failed; throws PendingError if it is still
   * unknown at the deadline.
   */
  async function confirm(connection: Connection, signature: string, blockhash: string) {
    // "Expired" needs two polls in a row where the blockhash was already invalid and a status read
    // made after that check still found nothing, so a transaction that landed is never declared dead.
    let expiredPolls = 0;
    const status = await until(CONFIRM_WAIT_MS, async () => {
      let valid: boolean | null = null;
      try {
        valid = (await connection.isBlockhashValid(blockhash)).value;
      } catch {
        valid = null; // unsupported or failed: keep polling
      }
      let found;
      try {
        found = (await connection.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0];
      } catch (err) {
        expiredPolls = 0;
        throw err;
      }
      if (found && (found.err || found.confirmationStatus === "confirmed" || found.confirmationStatus === "finalized")) return found;
      expiredPolls = !found && valid === false ? expiredPolls + 1 : 0;
      return expiredPolls >= 2 ? ("expired" as const) : null;
    });
    if (!status) throw new PendingError(`Transaction ${signature} was sent but is not confirmed yet; it may still land`, signature);
    if (status === "expired") throw new Error(`Transaction ${signature} expired before it landed; nothing changed`);
    if (status.err) {
      // Attribute the code by the logs only; without them the error stays raw.
      const tx = await connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }).catch(() => null);
      throw programFailure(tx?.meta?.logMessages ?? undefined, signature) ?? new Error(`Transaction ${signature} failed: ${JSON.stringify(status.err)}`);
    }
  }

  async function send(connection: Connection, ...instructions: TransactionInstruction[]): Promise<string> {
    const payer = me();
    for (let attempt = 0; ; attempt += 1) {
      const tx = new Transaction().add(...instructions);
      tx.feePayer = payer;
      const { blockhash } = await connection.getLatestBlockhash();
      tx.recentBlockhash = blockhash;
      let signature: string;
      try {
        // The wallet only signs; the server sends, so a rollup transaction never goes to Solana.
        const signed = await wallet.sign(tx);
        signature = await connection.sendRawTransaction(signed.serialize());
      } catch (err) {
        // A rollup blockhash can expire while the wallet waits for approval: sign again once.
        if (attempt === 0 && /blockhash not found/i.test((err as Error)?.message ?? "")) continue;
        const source = err as { logs?: string[]; transactionLogs?: string[] };
        throw programFailure(source.logs ?? source.transactionLogs) ?? err;
      }
      await confirm(connection, signature, blockhash);
      return signature;
    }
  }

  function playerTarget(owner: PublicKey): OutboxTarget {
    return { outbox: outboxPda(owner), missing: "Register first", delegate: () => delegateOutboxIx(owner), flush: () => withdrawIx(owner) };
  }

  function treasuryTarget(admin: PublicKey): OutboxTarget {
    return {
      outbox: treasuryOutboxPda(),
      missing: "The treasury Outbox does not exist: run init_treasury_outbox",
      delegate: () => delegateTreasuryOutboxIx(admin),
      flush: () => claimFeesIx(admin),
    };
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
    if (!inRollup) return { kind: "unseen" };
    const amount = lamports(decodeOutbox(inRollup.data)?.amount);
    if (!inRollup.owner.equals(PROGRAM_ID)) return { kind: "inFlight", amount };
    return amount > 0n ? { kind: "funded", amount } : { kind: "ready" };
  }

  /**
   * Pays out an amount an earlier withdrawal or claim left in the Outbox: `release_outbox` alone
   * on Solana for an undelegated Outbox, or `flush` (withdraw or claim_fees) alone in the rollup
   * for a funded one, then the release. Returns the amount paid, 0 when there was none.
   */
  async function recover(target: OutboxTarget, state: OutboxState) {
    if (state.kind === "undelegated" && state.amount > 0n) {
      await send(base, releaseOutboxIx(target.outbox, state.owner));
      return state.amount;
    }
    if (state.kind === "funded") {
      await send(er, target.flush());
      await awaitRelease(target.outbox);
      return state.amount;
    }
    return 0n;
  }

  async function releasePending(target: OutboxTarget) {
    const state = await outboxState(target.outbox);
    if (state.kind === "missing") throw new Error(target.missing);
    if (state.kind === "inFlight" || state.kind === "unseen") return "inFlight" as const;
    return (await recover(target, state)) > 0n ? ("paid" as const) : ("none" as const);
  }

  /**
   * Classifies the Outbox before a new withdrawal or claim. An earlier amount is paid out instead,
   * with RecoveredError, so a retry never funds twice; a withdrawal in flight or a delegation the
   * rollup has not picked up is PendingError. Returns the state when a new one may start: `ready`,
   * or `undelegated` with nothing in it.
   */
  async function classify(target: OutboxTarget) {
    const state = await outboxState(target.outbox);
    if (state.kind === "missing") throw new Error(target.missing);
    if (state.kind === "inFlight") throw new PendingError("An earlier withdrawal is still on its way to the wallet; try again once it has arrived");
    if (state.kind === "unseen") throw new PendingError("The rollup has not picked up the Outbox yet; try again shortly");
    const recovered = await recover(target, state);
    if (recovered > 0n) throw new RecoveredError(recovered);
    return state;
  }

  /** Delegates an empty, undelegated Outbox and waits for the rollup to hold it. */
  async function delegateOutbox(target: OutboxTarget, state: OutboxState) {
    if (state.kind === "ready") return;
    const signature = await send(base, target.delegate());
    // The wait starts after the wallet approved and the delegation confirmed.
    const ready = await until(DELEGATION_WAIT_MS, async () => ((await outboxState(target.outbox)).kind === "ready" ? true : null));
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
    let latest = back;
    if (!unpaid(latest)) return;
    const paid = await until(ACTION_WAIT_MS, async () => {
      const info = await base.getAccountInfo(outbox);
      if (info) latest = info;
      return info && !unpaid(info) ? true : null;
    });
    const state = paid ? null : unpaid(latest);
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
    const indexed = await read<IndexedMatch | null>(`/matches/${match.pubkey}`).catch(() => null);
    return indexed ? fromIndexer(indexed) : { ...match, status: 1 };
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
  async function sendLock(owner: PublicKey, army: { pubkey: string; battleground: string }) {
    const ground = new PublicKey(army.battleground);
    const groundInfo = await er.getAccountInfo(ground);
    const state = groundInfo ? decodeBattleground(groundInfo.data) : null;
    if (!state) throw new Error("Battleground is missing");
    // The program requires the queue's first MATCH_WINDOW entries, with their owners' Players, and
    // picks among them: a lock offers exactly those, the wallet's own queued armies included. A
    // legacy transaction holds lock_army's accounts plus eight armies and eight Players.
    const queued = state.queue.slice(0, MATCH_WINDOW).map((key) => new PublicKey(key));
    const heads = queued.length ? await er.getMultipleAccountsInfo(queued) : [];
    const candidates: { army: PublicKey; owner: PublicKey }[] = [];
    const candidateInfos: (AccountInfo<Buffer> | null)[] = [];
    const owners = new Set<string>();
    for (const [i, info] of heads.entries()) {
      const head = info ? decodeArmyHead(info.data) : null;
      if (!head) throw new Error("A queued army is missing from the rollup; try again");
      candidates.push({ army: queued[i], owner: new PublicKey(head.owner) });
      candidateInfos.push(info);
      if (head.owner !== owner.toBase58()) owners.add(head.owner);
    }
    // The program matches a candidate whose owner's budget covers the stake. Only then does the
    // lock create the battle, and only then may the battle be passed writable (see lockArmyIx).
    const ownerKeys = [...owners].map((key) => playerPda(new PublicKey(key)));
    const players = ownerKeys.length ? await er.getMultipleAccountsInfo(ownerKeys) : [];
    const opens = lockOpens({ locker: owner, stake: lamports(state.stake), armies: candidateInfos, players });
    await send(er, computeBudgetIx(), lockArmyIx({
      player: owner,
      battlegroundId: state.battlegroundId,
      army: new PublicKey(army.pubkey),
      queue: net.oracleQueue,
      seq: state.matchSeq,
      candidates,
      opens,
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
      const indexed = await read<ArmyRow[]>(`/armies?owner=${new PublicKey(owner).toBase58()}`);
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
      for (let probed = 0; ; probed += 8) {
        if (probed >= ARMY_INDEX_PROBE) throw new Error(`Army indexes ${index - probed} to ${index - 1} are all taken in the rollup; the indexer is far behind, try again later`);
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
        // The queue changed between our read and the lock: another lock opened a match first
        // (BadMatch), or a candidate's budget changed so the lock matched or queued against what we
        // passed the battle as. Read the queue again and send once more.
        if (!(err instanceof ProgramError && err.errorName === "BadMatch") && !queueRace(err)) throw err;
        try {
          battle = await sendLock(owner, army);
        } catch (again) {
          if (queueRace(again)) throw new Error("The queue changed while you locked; try again");
          throw again;
        }
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
      const delegatingOutbox = !outboxOnBase || (outboxState !== null && lamports(outboxState.amount) === 0n);
      if (delegatingOutbox) instructions.push(delegateOutboxIx(owner));
      const signature = instructions.length ? await send(base, ...instructions) : undefined;
      // Wait for the Outbox too when it is, or now becomes, delegated. One left undelegated with an
      // unpaid amount stays on Solana until releasePending or withdraw pays it.
      const outbox = outboxPda(owner);
      const waitOutbox = delegatingOutbox || !!outboxOnBase?.owner.equals(DELEGATION_PROGRAM_ID);
      const picked = await until(DELEGATION_WAIT_MS, async () =>
        (await ownedInRollup(player)) && (!waitOutbox || (await ownedInRollup(outbox))) ? true : null);
      if (!picked) throw new PendingError("Registered on Solana; the rollup has not picked up the Player and Outbox yet", signature);
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
      const target = playerTarget(owner);
      const state = await classify(target);
      if (amount <= 0n) throw new Error("Withdraw a positive amount");
      const balance = await this.player();
      if (!balance) throw new Error("Register first");
      const available = lamports(balance.free) + lamports(balance.winnings) + lamports(balance.budget);
      if (amount > available) throw new Error(`You can withdraw at most ${available} lamports`);
      await delegateOutbox(target, state);
      await send(er, fundOutboxIx(owner, amount), withdrawIx(owner));
      await awaitRelease(target.outbox);
    },
    async releasePending(which = "player") {
      return releasePending(which === "player" ? playerTarget(me()) : treasuryTarget(me()));
    },
    async setSegregation(segregate) {
      await send(er, setSegregationIx(me(), segregate));
    },
    async settle(match) {
      await settleOnce(match);
    },
    async cancel(match) {
      // Read the battle as the rollup holds it: the indexer's row may lag a seed that just landed.
      const key = new PublicKey(match.pubkey);
      const info = await er.getAccountInfo(key);
      const live = info ? decodeBattle(key, info.data) : null;
      if (!live) throw new Error("This battle is no longer open: it was settled or cancelled already");
      if (live.status === 2) throw new Error("The seed has landed: settle this battle instead");
      await send(er, cancelMatchIx(live));
    },
    async admin() {
      const info = await er.getAccountInfo(configPda());
      const state = info ? decodeConfig(info.data) : null;
      return state ? { admin: state.admin, feeBps: state.feeBps, fees: state.fees } : null;
    },
    async claimFees() {
      const admin = me();
      const target = treasuryTarget(admin);
      const state = await classify(target);
      const config = await this.admin();
      if (!config) throw new Error("Config is missing");
      if (lamports(config.fees) === 0n) throw new Error("There are no fees to claim");
      await delegateOutbox(target, state);
      await send(er, fundTreasuryOutboxIx(admin), claimFeesIx(admin));
      await awaitRelease(target.outbox);
    },
    async setFee(bps) {
      await send(er, setFeeIx(me(), bps));
    },
    async matches(owner) {
      const mine = await read<IndexedMatch[]>(`/matches?player=${new PublicKey(owner).toBase58()}&limit=20`);
      return mine.map(fromIndexer);
    },
    async match(pubkey) {
      const key = new PublicKey(pubkey);
      const indexed = await read<IndexedMatch | null>(`/matches/${key.toBase58()}`).catch(() => null);
      if (indexed) return fromIndexer(indexed);
      // A battle the indexer has not seen yet, still open in the rollup.
      const info = await er.getAccountInfo(key);
      return info ? decodeBattle(key, info.data) : null;
    },
  };
}
