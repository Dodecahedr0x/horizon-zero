import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import type { WalletContextState } from "@solana/wallet-adapter-react";
import {
  BATTLEGROUNDS,
  battlegroundPda,
  closeArmyIx,
  computeBudgetIx,
  createArmyIx,
  createBehaviorIx,
  decodePot,
  fundPotIx,
  lockArmyIx,
  potPda,
  setSegregationIx,
  unlockArmyIx,
  withdrawPotIx,
} from "./codec";
import { parseBehavior, nameBehavior, type ElementSpec } from "./codec";
import type { Army, ChainAdapter, Match } from "./devChain";
import { ORACLE_QUEUE, RPC_URL } from "./network";

const rpc = RPC_URL;
const queue = ORACLE_QUEUE;

async function read<T>(path: string): Promise<T> {
  const response = await fetch(`/api${path}`);
  if (!response.ok) throw new Error(`indexer ${response.status}`);
  return response.json();
}

function groundName(id: number) {
  return BATTLEGROUNDS.find((ground) => ground.id === id)?.name || `Battleground ${id}`;
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

export function createSolanaChain(wallet: WalletContextState): ChainAdapter {
  const connection = new Connection(rpc, "confirmed");
  async function send(tx: Transaction) {
    if (!wallet.publicKey || !wallet.sendTransaction) throw new Error("Connect a wallet");
    tx.feePayer = wallet.publicKey;
    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    const signature = await wallet.sendTransaction(tx, connection);
    await connection.confirmTransaction(signature, "confirmed");
  }
  async function battlegrounds() {
    const rows = await read<GroundRow[]>("/battlegrounds");
    return rows.map((row) => ({
      pubkey: row.pubkey,
      battlegroundId: row.battlegroundId,
      name: groundName(row.battlegroundId),
      budget: row.budget,
      stake: row.stake,
      cols: row.cols,
      rows: row.rows,
      queue: row.queue || [],
      matchSeq: row.matchSeq,
    }));
  }
  return {
    async owner() {
      if (!wallet.publicKey) throw new Error("Connect a wallet");
      return wallet.publicKey.toBase58();
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
      // The indexer learns of a closed army only on its next prune; the chain knows at once.
      const live = indexed.length ? await connection.getMultipleAccountsInfo(indexed.map((row) => new PublicKey(row.pubkey))) : [];
      const rows = indexed.filter((_, i) => live[i] && live[i]!.data.length > 0);
      return rows.map((row) => ({
        pubkey: row.pubkey,
        owner: row.owner,
        battleground: row.battleground,
        battlegroundId: known.find((ground) => ground.pubkey === row.battleground)?.battlegroundId ?? 0,
        race: row.race,
        index: row.idx,
        status: row.status,
        units: (row.units || []).map((unit) => ({
          ...unit,
          elements: unit.elements || parseBehavior(unit.body || []) || [],
        })),
      }));
    },
    async createBehavior(elements) {
      if (!wallet.publicKey) throw new Error("Connect a wallet");
      await send(new Transaction().add(createBehaviorIx(wallet.publicKey, elements)));
    },
    async createArmy(battlegroundId, units, race) {
      if (!wallet.publicKey) throw new Error("Connect a wallet");
      const existing = await this.armies(wallet.publicKey.toBase58());
      const index = existing.reduce((max, army) => Math.max(max, army.index + 1), 0);
      await send(new Transaction().add(createArmyIx(
        wallet.publicKey,
        battlegroundId,
        index,
        race,
        units.map((unit) => ({ kind: unit.kind, behavior: new PublicKey(unit.behavior), col: unit.col, row: unit.row })),
      )));
    },
    async lock(army) {
      if (!wallet.publicKey) throw new Error("Connect a wallet");
      const ground = (await battlegrounds()).find((item) => item.pubkey === army.battleground);
      if (!ground) throw new Error("Battleground is missing");
      const opponents = [];
      for (const key of ground.queue) {
        const row = await read<ArmyRow | null>(`/army/${key}`);
        if (row && row.owner !== wallet.publicKey.toBase58()) opponents.push(row);
      }
      await send(new Transaction().add(
        computeBudgetIx(),
        lockArmyIx({
          player: wallet.publicKey,
          battlegroundId: ground.battlegroundId,
          army: new PublicKey(army.pubkey),
          behaviors: [...new Set(army.units.map((unit) => unit.behavior))].map((key) => new PublicKey(key)),
          queue,
          seq: ground.matchSeq,
          opponents: opponents.map((row) => ({ army: new PublicKey(row.pubkey), owner: new PublicKey(row.owner) })),
        }),
      ));
      const matches = await read<Match[]>("/matches");
      return matches.find((item) => item.armyA === army.pubkey || item.armyB === army.pubkey) || null;
    },
    async unlock(army) {
      if (!wallet.publicKey) throw new Error("Connect a wallet");
      await send(new Transaction().add(unlockArmyIx(wallet.publicKey, army.battlegroundId, new PublicKey(army.pubkey))));
    },
    async closeArmy(army) {
      if (!wallet.publicKey) throw new Error("Connect a wallet");
      await send(new Transaction().add(closeArmyIx(wallet.publicKey, new PublicKey(army.pubkey))));
    },
    async pot(battlegroundId) {
      if (!wallet.publicKey) throw new Error("Connect a wallet");
      const account = await connection.getAccountInfo(potPda(battlegroundPda(battlegroundId), wallet.publicKey));
      return account ? decodePot(account.data) : null;
    },
    async fundPot(battlegroundId, lamports) {
      if (!wallet.publicKey) throw new Error("Connect a wallet");
      await send(new Transaction().add(fundPotIx(wallet.publicKey, battlegroundId, lamports)));
    },
    async withdrawPot(battlegroundId, lamports) {
      if (!wallet.publicKey) throw new Error("Connect a wallet");
      await send(new Transaction().add(withdrawPotIx(wallet.publicKey, battlegroundId, lamports)));
    },
    async setSegregation(battlegroundId, segregate) {
      if (!wallet.publicKey) throw new Error("Connect a wallet");
      await send(new Transaction().add(setSegregationIx(wallet.publicKey, battlegroundId, segregate)));
    },
    async matches(owner) {
      const all = await read<Match[]>("/matches");
      return all.filter((item) => item.playerA === owner || item.playerB === owner).slice(0, 20);
    },
    async match(pubkey) {
      return read<Match | null>(`/matches/${pubkey}`);
    },
  };
}
