import { lamportsDelegatedTransferIx } from "@magicblock-labs/ephemeral-rollups-sdk";
import { Connection, PublicKey, Transaction, type TransactionInstruction } from "@solana/web3.js";
import type { WalletContextState } from "@solana/wallet-adapter-react";
import {
  BATTLEGROUNDS,
  DELEGATION_PROGRAM_ID,
  PLAYER_LEN,
  PROGRAM_ID,
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
  lockArmyIx,
  matchPda,
  outboxPda,
  playerPda,
  registerPlayerIx,
  releaseOutboxIx,
  resolvedOutcome,
  setFeeIx,
  setSegregationIx,
  settleMatchIx,
  treasuryOutboxPda,
  unlockArmyIx,
  withdrawIx,
} from "./codec";
import { parseBehavior, nameBehavior, type ElementSpec } from "./codec";
import type { ChainAdapter, Match } from "./devChain";
import { ER_RPC_URL, ORACLE_QUEUE, RPC_URL } from "./network";

const queue = ORACLE_QUEUE;
const POLL_MS = 500;
// How long to wait for the rollup to see a delegation, for a VRF seed, and for an Outbox release.
const DELEGATION_WAIT_MS = 60_000;
const SEED_WAIT_MS = 60_000;
const RELEASE_WAIT_MS = 30_000;
// A legacy transaction fits about 33 distinct accounts. lock_army's fixed accounts, the program and
// the compute-budget program take 15; behaviors, candidates and their Players share the rest.
const LOCK_ACCOUNT_LIMIT = 32;
const LOCK_FIXED_ACCOUNTS = 15;

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

  async function send(connection: Connection, ...instructions: TransactionInstruction[]) {
    const payer = me();
    const tx = new Transaction().add(...instructions);
    tx.feePayer = payer;
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    let signature: string;
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
    const result = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
    if (result.value.err) throw new Error(`Transaction ${signature} failed: ${JSON.stringify(result.value.err)}`);
    return signature;
  }

  /** Polls `check` until it returns a value, or returns null after `ms`. */
  async function until<T>(ms: number, check: () => Promise<T | null>) {
    for (const end = Date.now() + ms; ;) {
      const value = await check();
      if (value !== null) return value;
      if (Date.now() >= end) return null;
      await sleep(POLL_MS);
    }
  }

  async function ownedInRollup(account: PublicKey) {
    const info = await er.getAccountInfo(account);
    return info && info.owner.equals(PROGRAM_ID) ? info : null;
  }

  /**
   * Gets an Outbox ready to fund in the rollup: delegated, empty and visible there. An undelegated
   * Outbox still holding an amount is released first (the post-undelegate action normally did that);
   * an undelegated one is delegated again; a delegated one funded without its `withdraw` is flushed
   * with `flush` and then delegated again.
   */
  async function readyOutbox(outbox: PublicKey, delegate: () => TransactionInstruction, flush: () => TransactionInstruction) {
    let delegating = false;
    const ready = await until(DELEGATION_WAIT_MS, async () => {
      const onBase = await base.getAccountInfo(outbox);
      if (!onBase) throw new Error("Register first");
      if (onBase.owner.equals(PROGRAM_ID)) {
        if (delegating) return null;
        const state = decodeOutbox(onBase.data);
        const instructions = [];
        if (state && lamports(state.amount) > 0n) instructions.push(releaseOutboxIx(outbox, new PublicKey(state.owner)));
        instructions.push(delegate());
        await send(base, ...instructions);
        delegating = true;
        return null;
      }
      if (!onBase.owner.equals(DELEGATION_PROGRAM_ID)) throw new Error("The Outbox has an unexpected owner");
      const inRollup = await ownedInRollup(outbox);
      if (!inRollup) return null;
      const state = decodeOutbox(inRollup.data);
      if (state && lamports(state.amount) > 0n) {
        await send(er, flush());
        delegating = false;
        return null;
      }
      return true;
    });
    if (!ready) throw new Error("The Outbox did not reach the rollup in time; try again");
  }

  /** Waits for the release on Solana, and sends `release_outbox` itself if the action did not pay. */
  async function awaitRelease(outbox: PublicKey) {
    const onBase = await until(RELEASE_WAIT_MS, async () => {
      const info = await base.getAccountInfo(outbox);
      return info && info.owner.equals(PROGRAM_ID) ? info : null;
    });
    const state = onBase && decodeOutbox(onBase.data);
    if (state && lamports(state.amount) > 0n) await send(base, releaseOutboxIx(outbox, new PublicKey(state.owner)));
  }

  /**
   * Sends `settle_match` and returns the outcome byte from its log, or null if another caller
   * settled the battle first. A battle that is not Seeded yet throws.
   */
  async function settleOnce(match: Match) {
    try {
      const signature = await send(er, settleMatchIx(match));
      const tx = await er.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      return resolvedOutcome(tx?.meta?.logMessages ?? [], match.pubkey) ?? 0;
    } catch (err) {
      // AlreadyResolved: someone else's settlement closed the battle.
      const info = await er.getAccountInfo(new PublicKey(match.pubkey));
      if (!info || info.data.length === 0) return null;
      const state = decodeBattle(new PublicKey(match.pubkey), info.data);
      if (state?.status === 0) throw new Error("The battle is still waiting for its random seed");
      throw err;
    }
  }

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
          owner: row.owner,
          battleground: row.battleground,
          battlegroundId: known.find((ground) => ground.pubkey === row.battleground)?.battlegroundId ?? 0,
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
      const index = existing.reduce((max, army) => Math.max(max, army.index + 1), 0);
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
        queue,
        seq: state.matchSeq,
        candidates,
      }));
      const battle = matchPda(ground, state.matchSeq);
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
      const outbox = outboxPda(owner);
      const [account, outboxOnBase] = await Promise.all([er.getAccountInfo(playerPda(owner)), base.getAccountInfo(outbox)]);
      const state = account ? decodePlayer(account.data) : null;
      if (!account || !state) return null;
      playerRent ??= base.getMinimumBalanceForRentExemption(PLAYER_LEN);
      const claimed = BigInt(await playerRent) + lamports(state.budget) + lamports(state.winnings) + lamports(state.locked);
      const free = BigInt(account.lamports) - claimed;
      // An undelegated Outbox's amount is waiting for release_outbox; a delegated one's was funded
      // in the rollup and is waiting for its withdraw.
      let pending = "0";
      if (outboxOnBase?.owner.equals(PROGRAM_ID)) pending = decodeOutbox(outboxOnBase.data)?.amount ?? "0";
      else if (outboxOnBase) {
        const inRollup = await ownedInRollup(outbox);
        pending = (inRollup && decodeOutbox(inRollup.data)?.amount) || "0";
      }
      return {
        free: (free > 0n ? free : 0n).toString(),
        budget: state.budget,
        winnings: state.winnings,
        locked: state.locked,
        segregate: state.segregate,
        outboxPending: pending,
      };
    },
    async register(depositLamports) {
      const owner = me();
      const player = playerPda(owner);
      const [playerOnBase, outboxOnBase] = await base.getMultipleAccountsInfo([player, outboxPda(owner)]);
      // One transaction: create both accounts and delegate both. A retry after a partial
      // registration sends only what is missing.
      const instructions = [];
      if (!playerOnBase) instructions.push(registerPlayerIx(owner, depositLamports));
      if (!playerOnBase || playerOnBase.owner.equals(PROGRAM_ID)) instructions.push(delegatePlayerIx(owner));
      const outboxState = outboxOnBase?.owner.equals(PROGRAM_ID) ? decodeOutbox(outboxOnBase.data) : null;
      if (!outboxOnBase || (outboxState && lamports(outboxState.amount) === 0n)) instructions.push(delegateOutboxIx(owner));
      if (instructions.length) await send(base, ...instructions);
      if (playerOnBase && depositLamports > 0n) await this.topUp(depositLamports);
      if (!(await until(DELEGATION_WAIT_MS, () => ownedInRollup(player)))) throw new Error("The rollup has not picked up the Player yet; try again");
    },
    async topUp(amount) {
      const owner = me();
      const player = playerPda(owner);
      const before = (await er.getAccountInfo(player))?.lamports ?? 0;
      const salt = crypto.getRandomValues(new Uint8Array(32));
      await send(base, lamportsDelegatedTransferIx(owner, player, amount, salt));
      // The rollup credits the Player about a second later.
      await until(DELEGATION_WAIT_MS, async () => ((await er.getAccountInfo(player))?.lamports ?? 0) > before || null);
    },
    async fundBudget(amount) {
      await send(er, fundBudgetIx(me(), amount));
    },
    async withdraw(amount) {
      const owner = me();
      const outbox = outboxPda(owner);
      await readyOutbox(outbox, () => delegateOutboxIx(owner), () => withdrawIx(owner));
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
      const outbox = treasuryOutboxPda();
      await readyOutbox(outbox, () => delegateTreasuryOutboxIx(admin), () => claimFeesIx(admin));
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
