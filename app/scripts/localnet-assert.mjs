/**
 * Two wallets lock into Outpost against the local MagicBlock stack (scripts/local-stack.mjs) and its VRF oracle.
 * Asserts the callback stored the battle seed, the Hydra crank settled the battle and paid the pot,
 * and the spent crank was closed.
 */
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { loadCatalog } from "../../content/load.mjs";
import { bootstrap } from "./bootstrap.mjs";

const require = createRequire(import.meta.url);
const { simulate_json } = require("../src/combat-node/horizon_combat.js");

const PROGRAM_ID = new PublicKey("Hm19JfKaKCRphRwF7DbxhJWmLpHgMG1SnEnKGRyN9Z7c");
const VRF_PROGRAM_ID = new PublicKey("Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz");
const HYDRA_ID = new PublicKey("Hydra17i1feui9deaxu6d1TzSQMRNHeBRkDR1Awy7zea");
const SLOT_HASHES = new PublicKey("SysvarS1otHashes111111111111111111111111111");
const STAKE = BigInt(loadCatalog().battlegrounds[0].stake);
const connection = new Connection(process.env.RPC_URL || "http://127.0.0.1:8899", "confirmed");
// The local stack's oracle serves the SDK's test queue.
const queue = new PublicKey(process.env.ORACLE_QUEUE || "GKE6d7iv8kCBrsxr78W3xVdjGLLLJnxsGiuzrsZCGEvb");

function sighash(name) {
  return createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

function pda(seeds) {
  return PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];
}

function crankFund(battle) {
  return pda([Buffer.from("crank-fund"), battle.toBuffer()]);
}

function ix(name, keys, rest = Buffer.alloc(0)) {
  const data = Buffer.concat([sighash(name), rest]);
  return new TransactionInstruction({ programId: PROGRAM_ID, keys, data });
}

async function send(payer, instructions) {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  const tx = new Transaction({ feePayer: payer.publicKey, recentBlockhash: blockhash }).add(
    compute(),
    ...instructions,
  );
  tx.sign(payer);
  const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
  return signature;
}

function compute() {
  const data = Buffer.alloc(5);
  data[0] = 2;
  data.writeUInt32LE(1_400_000, 1);
  return new TransactionInstruction({
    programId: new PublicKey("ComputeBudget111111111111111111111111111111"),
    keys: [],
    data,
  });
}

const admin = Keypair.generate();
const first = Keypair.generate();
const second = Keypair.generate();
for (const player of [admin, first, second]) {
  const signature = await connection.requestAirdrop(player.publicKey, 2_000_000_000);
  await connection.confirmTransaction(signature, "confirmed");
}

// Config, battlegrounds and standard behaviors; skipped when the stack's own bootstrap already ran.
await bootstrap(connection, admin, { log: () => {} });
const identity = pda([Buffer.from("identity")]);
const battleground = pda([Buffer.from("battleground"), Buffer.from([0])]);

function contentFlag() {
  const args = process.argv.slice(2);
  const index = args.indexOf("--content");
  if (index === -1) return process.env.HZ_CONTENT || "";
  const value = args[index + 1];
  if (!value) throw new Error("--content needs a path");
  return value;
}

const flagged = contentFlag();
const catalog = loadCatalog(flagged || undefined);
const march = catalog.behaviors.find((item) => item.name === "March");
if (!march) throw new Error("content catalog has no March");

async function createBehavior(payer, body) {
  const bytes = Buffer.from(body);
  const hash = createHash("sha256").update(bytes).digest();
  const key = pda([Buffer.from("behavior"), hash]);
  if (await connection.getAccountInfo(key)) return key;
  const bodyLen = Buffer.alloc(4);
  bodyLen.writeUInt32LE(bytes.length);
  await send(payer, [
    ix("create_behavior", [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: key, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ], Buffer.concat([hash, bodyLen, bytes])),
  ]);
  return key;
}

const toCreate = flagged ? catalog.behaviors : [march];
let behavior;
for (const item of toCreate) {
  const key = await createBehavior(first, item.body);
  if (item.name === "March") behavior = key;
}

function armyOf(owner, index) {
  const indexBytes = Buffer.alloc(4);
  indexBytes.writeUInt32LE(index);
  return pda([Buffer.from("army"), owner.toBuffer(), indexBytes]);
}

async function createArmy(owner) {
  const army = armyOf(owner.publicKey, 0);
  const rest = Buffer.alloc(4 + 1 + 4 + 35);
  rest.writeUInt32LE(0, 0);
  rest[4] = 0;
  rest.writeUInt32LE(1, 5);
  rest[9] = 0;
  behavior.toBuffer().copy(rest, 10);
  rest[42] = 0;
  rest[43] = 0;
  await send(owner, [
    ix("create_army", [
      { pubkey: owner.publicKey, isSigner: true, isWritable: true },
      { pubkey: battleground, isSigner: false, isWritable: false },
      { pubkey: army, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: behavior, isSigner: false, isWritable: false },
    ], rest),
  ]);
  return army;
}

function potOf(owner) {
  return pda([Buffer.from("pot"), battleground.toBuffer(), owner.toBuffer()]);
}

async function fundPot(owner, lamports) {
  const amount = Buffer.alloc(8);
  amount.writeBigUInt64LE(lamports);
  await send(owner, [
    ix("fund_pot", [
      { pubkey: owner.publicKey, isSigner: true, isWritable: true },
      { pubkey: battleground, isSigner: false, isWritable: false },
      { pubkey: potOf(owner.publicKey), isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ], amount),
  ]);
}

/** The pot's budget and winnings (docs/src/accounts.md). */
async function potBalances(owner) {
  const data = (await connection.getAccountInfo(potOf(owner))).data;
  return { budget: data.readBigUInt64LE(72), winnings: data.readBigUInt64LE(80) };
}

function lockKeys(player, army, seq, opponents) {
  const seqBytes = Buffer.alloc(8);
  seqBytes.writeBigUInt64LE(BigInt(seq));
  const keys = [
    { pubkey: player.publicKey, isSigner: true, isWritable: true },
    { pubkey: battleground, isSigner: false, isWritable: true },
    { pubkey: army, isSigner: false, isWritable: true },
    { pubkey: potOf(player.publicKey), isSigner: false, isWritable: true },
    { pubkey: pda([Buffer.from("match"), battleground.toBuffer(), seqBytes]), isSigner: false, isWritable: true },
    { pubkey: queue, isSigner: false, isWritable: true },
    { pubkey: identity, isSigner: false, isWritable: false },
    { pubkey: VRF_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SLOT_HASHES, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: behavior, isSigner: false, isWritable: false },
  ];
  if (opponents.length > 0) {
    for (const opponent of opponents) {
      keys.push({ pubkey: opponent.army, isSigner: false, isWritable: true });
      keys.push({ pubkey: potOf(opponent.owner), isSigner: false, isWritable: true });
    }
    // The vault that pays for the settlement crank.
    keys.push({ pubkey: crankFund(keys[4].pubkey), isSigner: false, isWritable: true });
  }
  return keys;
}

const armyA = await createArmy(first);
const armyB = await createArmy(second);
// Each player's pot covers exactly one stake.
await fundPot(first, STAKE);
await fundPot(second, STAKE);
await send(first, [ix("lock_army", lockKeys(first, armyA, 0, []))]);
await send(second, [ix("lock_army", lockKeys(second, armyB, 0, [{ army: armyA, owner: first.publicKey }]))]);

// Battle layout (docs/src/accounts.md): 10 snapshot units of 96 bytes per side from offset 188, then status, seed, outcome.
const BATTLE_UNIT = 96;
const BATTLE_STATUS = 188 + BATTLE_UNIT * 20;
const battle = pda([Buffer.from("match"), battleground.toBuffer(), Buffer.alloc(8)]);
let data = null;
for (let attempt = 0; attempt < 60; attempt += 1) {
  const account = await connection.getAccountInfo(battle);
  if (account && account.data[BATTLE_STATUS] === 1) {
    data = account.data;
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
if (!data) throw new Error("the VRF callback and the Hydra crank did not settle the battle");
const fund = crankFund(battle);
const crank = PublicKey.findProgramAddressSync([Buffer.from("crank"), fund.toBuffer(), battle.toBuffer()], HYDRA_ID)[0];
if ((await connection.getAccountInfo(crank))?.lamports) throw new Error("the spent crank was not closed");
if ((await connection.getAccountInfo(fund))?.lamports) throw new Error("the crank vault was not emptied");

const seed = Buffer.from(data.subarray(BATTLE_STATUS + 1, BATTLE_STATUS + 33));
if (seed.equals(Buffer.alloc(32))) throw new Error("callback did not store a seed");

function snapshot(start) {
  const len = data[start + 1];
  return {
    kind: data[start],
    body: [...data.subarray(start + 2, start + 2 + len)],
    col: data[start + 79],
    row: data[start + 80],
    cost: data.readUInt16LE(start + 81),
    hp: data[start + 83],
    atk: data[start + 84],
    range: data[start + 85],
    speed: data[start + 86],
    cast: {
      damage: data[start + 87],
      range: data[start + 88],
      aoe: data[start + 89],
      effect: data[start + 90],
      aim: data[start + 91],
      power: data[start + 92],
      rounds: data[start + 93],
      cooldown: data[start + 94],
    },
    actions: data[start + 95],
  };
}
const replay = JSON.parse(simulate_json(JSON.stringify({
  cols: data[186],
  rows: data[187],
  a: [snapshot(188)],
  b: [snapshot(188 + BATTLE_UNIT * 10)],
  seed: [...seed],
})));
const expected = replay.winner === 0 ? 1 : replay.winner === 1 ? 2 : 3;
if (data[BATTLE_STATUS + 33] !== expected) throw new Error(`outcome ${data[BATTLE_STATUS + 33]} != simulated ${expected}`);

// The payout returns to the pots' budgets: segregation is off by default.
const paid = expected === 1 ? [2n * STAKE, 0n] : expected === 2 ? [0n, 2n * STAKE] : [STAKE, STAKE];
for (const [owner, want] of [[first.publicKey, paid[0]], [second.publicKey, paid[1]]]) {
  const pot = await potBalances(owner);
  if (pot.budget !== want || pot.winnings !== 0n) throw new Error(`pot ${owner.toBase58()} holds ${pot.budget}, expected ${want}`);
}
const battleLamports = BigInt((await connection.getAccountInfo(battle)).lamports);
if (battleLamports >= STAKE) throw new Error("battle still holds a stake");
console.log(`resolved outcome ${expected} seed ${seed.toString("hex")}`);
