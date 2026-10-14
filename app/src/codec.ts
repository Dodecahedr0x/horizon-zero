import { sha256 } from "@noble/hashes/sha2";
import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import catalogFile from "../../content/catalog.json" with { type: "json" };
import {
  EXTREMA,
  MOVE_KINDS,
  SIDES,
  STATS,
  VERBS,
  describeCast,
  describeBehavior as describeElements,
  encodeBehavior as encodeElements,
  clipBehaviorName as clipName,
  interpretCatalog,
  nameBehavior as nameElements,
  parseBehavior as parseElements,
  standardName as nameFor,
} from "../../content/interpret.mjs";

export { EXTREMA, MOVE_KINDS, SIDES, STATS, VERBS, describeCast };
export { MAX_BEHAVIOR_NAME_LEN, clipBehaviorName } from "../../content/interpret.mjs";

export const PROGRAM_ID = new PublicKey("Hm19JfKaKCRphRwF7DbxhJWmLpHgMG1SnEnKGRyN9Z7c");
export const VRF_PROGRAM_ID = new PublicKey("Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz");
export const DEFAULT_QUEUE = new PublicKey("Cuj97ggrhhidhbu39TijNVqE74xvKJ69gDervRUXAxGh");
export const SLOT_HASHES = new PublicKey("SysvarS1otHashes111111111111111111111111111");

export type CastSpec = { damage: number; range: number; aoe: number; effect: number; aim: number; power: number; rounds: number; cooldown: number };
export type UnitSpec = {
  id: number;
  name: string;
  cost: number;
  hp: number;
  atk: number;
  range: number;
  speed: number;
  actions: number;
  color: string;
  cast: CastSpec;
};
export type RaceSpec = { id: number; name: string; slug: string; units: readonly UnitSpec[] };

const catalog = interpretCatalog(catalogFile);

export const RACES: readonly RaceSpec[] = catalog.races;

export function raceById(id: number) {
  return RACES.find((race) => race.id === id);
}

export function unitSpec(raceId: number, kind: number) {
  return raceById(raceId)?.units.find((unit) => unit.id === kind);
}

export function unitArtPaths(raceId: number, kind: number) {
  const race = raceById(raceId) || raceById(0);
  const spec = unitSpec(race?.id ?? 0, kind);
  const name = spec?.name.toLowerCase();
  if (!race || !name) return [];
  return [`/assets/units/${race.slug}/${name}/${name}.approved.glb`];
}

export type MovementSpec = { kind: number; extremum: number; stat: number; side: number; stop: number };
export type ActionSpec = { verb: number; extremum: number; stat: number; side: number };
export type ElementSpec = { movement: MovementSpec | null; actions: ActionSpec[] };

export const STANDARDS: { name: string; elements: ElementSpec[] }[] = catalog.behaviors;

export function encodeBehavior(elements: ElementSpec[]) {
  return encodeElements(elements);
}

export function parseBehavior(body: number[]): ElementSpec[] | null {
  return parseElements(body);
}

export function standardName(elements: ElementSpec[]) {
  return nameFor(elements, STANDARDS);
}

/** The full, readable description of every element. */
export function describeBehavior(elements: ElementSpec[]) {
  return describeElements(elements, STANDARDS);
}

/** A short name, at most `MAX_BEHAVIOR_NAME_LEN` characters: the standard's name or a summary. */
export function nameBehavior(elements: ElementSpec[]) {
  return nameElements(elements, STANDARDS);
}

/** What the UI calls a behavior: its stored name, capped, or a generated one. */
export function behaviorLabel(behavior: { name?: string; elements: ElementSpec[] }) {
  return behavior.name ? clipName(behavior.name) : nameBehavior(behavior.elements);
}

export const ZONE_DEPTH = 2;

// Ids, budgets, stakes and grids come from content/catalog.json, as for the studio and bootstrap.
export const BATTLEGROUNDS = catalog.battlegrounds;

export function behaviorHash(body: number[]) {
  return sha256(Uint8Array.from(body));
}

export function sighash(name: string) {
  return sha256(new TextEncoder().encode(`global:${name}`)).slice(0, 8);
}

export function behaviorPda(body: number[]) {
  return PublicKey.findProgramAddressSync([Buffer.from("behavior"), Buffer.from(behaviorHash(body))], PROGRAM_ID)[0];
}

export function armyPda(owner: PublicKey, index: number) {
  const indexBytes = Buffer.alloc(4);
  indexBytes.writeUInt32LE(index);
  return PublicKey.findProgramAddressSync([Buffer.from("army"), owner.toBuffer(), indexBytes], PROGRAM_ID)[0];
}

export function battlegroundPda(id: number) {
  return PublicKey.findProgramAddressSync([Buffer.from("battleground"), Buffer.from([id])], PROGRAM_ID)[0];
}

/** A player's stake budget on one battleground. Every army they lock there stakes from it. */
export function potPda(battleground: PublicKey, owner: PublicKey) {
  return PublicKey.findProgramAddressSync([Buffer.from("pot"), battleground.toBuffer(), owner.toBuffer()], PROGRAM_ID)[0];
}

/** The `Pot` account: discriminator, owner, battleground, budget, winnings, segregate, fighting, bump. */
export function decodePot(data: Uint8Array) {
  if (data.length < 92) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    budget: view.getBigUint64(72, true).toString(),
    winnings: view.getBigUint64(80, true).toString(),
    segregate: data[88] !== 0,
  };
}

export function matchPda(battleground: PublicKey, seq: number) {
  const seqBytes = Buffer.alloc(8);
  seqBytes.writeBigUInt64LE(BigInt(seq));
  return PublicKey.findProgramAddressSync([Buffer.from("match"), battleground.toBuffer(), seqBytes], PROGRAM_ID)[0];
}

/** The vault the matching player funds to pay for the battle's settlement crank. */
export function crankFundPda(battle: PublicKey) {
  return PublicKey.findProgramAddressSync([Buffer.from("crank-fund"), battle.toBuffer()], PROGRAM_ID)[0];
}

export function identityPda() {
  return PublicKey.findProgramAddressSync([Buffer.from("identity")], PROGRAM_ID)[0];
}

function data(name: string, rest: Uint8Array = new Uint8Array()) {
  const out = new Uint8Array(8 + rest.length);
  out.set(sighash(name), 0);
  out.set(rest, 8);
  return Buffer.from(out);
}

export function createBehaviorIx(creator: PublicKey, elements: ElementSpec[]) {
  const body = encodeBehavior(elements);
  if (!body) throw new Error("Behavior body is not valid");
  const hash = behaviorHash(body);
  const rest = new Uint8Array(36 + body.length);
  rest.set(hash, 0);
  new DataView(rest.buffer).setUint32(32, body.length, true);
  rest.set(body, 36);
  const behavior = behaviorPda(body);
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: creator, isSigner: true, isWritable: true },
      { pubkey: behavior, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: data("create_behavior", rest),
  });
}

export function createArmyIx(
  owner: PublicKey,
  battlegroundId: number,
  index: number,
  race: number,
  units: { kind: number; behavior: PublicKey; col: number; row: number }[],
) {
  const rest = new Uint8Array(4 + 1 + 4 + units.length * 35);
  const view = new DataView(rest.buffer);
  view.setUint32(0, index, true);
  rest[4] = race;
  view.setUint32(5, units.length, true);
  units.forEach((unit, i) => {
    const at = 9 + i * 35;
    rest[at] = unit.kind;
    rest.set(unit.behavior.toBytes(), at + 1);
    rest[at + 33] = unit.col;
    rest[at + 34] = unit.row;
  });
  const behaviors = units.map((unit) => unit.behavior);
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: battlegroundPda(battlegroundId), isSigner: false, isWritable: false },
      { pubkey: armyPda(owner, index), isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ...behaviors.map((pubkey) => ({ pubkey, isSigner: false, isWritable: false })),
    ],
    data: data("create_army", rest),
  });
}

export function lockArmyIx(args: {
  player: PublicKey;
  battlegroundId: number;
  army: PublicKey;
  behaviors: PublicKey[];
  queue: PublicKey;
  seq: number;
  opponents: { army: PublicKey; owner: PublicKey }[];
}) {
  const battleground = battlegroundPda(args.battlegroundId);
  const battle = matchPda(battleground, args.seq);
  const keys = [
    { pubkey: args.player, isSigner: true, isWritable: true },
    { pubkey: battleground, isSigner: false, isWritable: true },
    { pubkey: args.army, isSigner: false, isWritable: true },
    { pubkey: potPda(battleground, args.player), isSigner: false, isWritable: true },
    { pubkey: battle, isSigner: false, isWritable: true },
    { pubkey: args.queue, isSigner: false, isWritable: true },
    { pubkey: identityPda(), isSigner: false, isWritable: false },
    { pubkey: VRF_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SLOT_HASHES, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ...args.behaviors.map((pubkey) => ({ pubkey, isSigner: false, isWritable: false })),
  ];
  if (args.opponents.length > 0) {
    // Each queued army, then each of their owners' pots once; the program skips armies whose pot
    // is missing or under one stake.
    for (const opponent of args.opponents) keys.push({ pubkey: opponent.army, isSigner: false, isWritable: true });
    for (const owner of new Set(args.opponents.map((opponent) => opponent.owner.toBase58()))) {
      keys.push({ pubkey: potPda(battleground, new PublicKey(owner)), isSigner: false, isWritable: true });
    }
    keys.push({ pubkey: crankFundPda(battle), isSigner: false, isWritable: true });
  }
  return new TransactionInstruction({ programId: PROGRAM_ID, keys, data: data("lock_army") });
}

export function unlockArmyIx(player: PublicKey, battlegroundId: number, army: PublicKey) {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: player, isSigner: true, isWritable: true },
      { pubkey: battlegroundPda(battlegroundId), isSigner: false, isWritable: true },
      { pubkey: army, isSigner: false, isWritable: true },
    ],
    data: data("unlock_army"),
  });
}

function u64(value: bigint) {
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(value);
  return out;
}

export function fundPotIx(owner: PublicKey, battlegroundId: number, lamports: bigint) {
  const battleground = battlegroundPda(battlegroundId);
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: battleground, isSigner: false, isWritable: false },
      { pubkey: potPda(battleground, owner), isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: data("fund_pot", u64(lamports)),
  });
}

function ownPotIx(owner: PublicKey, battlegroundId: number, name: string, rest: Uint8Array) {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: potPda(battlegroundPda(battlegroundId), owner), isSigner: false, isWritable: true },
    ],
    data: data(name, rest),
  });
}

/** Takes from the winnings first, then from the budget. */
export function withdrawPotIx(owner: PublicKey, battlegroundId: number, lamports: bigint) {
  return ownPotIx(owner, battlegroundId, "withdraw_pot", u64(lamports));
}

export function setSegregationIx(owner: PublicKey, battlegroundId: number, segregate: boolean) {
  return ownPotIx(owner, battlegroundId, "set_segregation", Uint8Array.of(segregate ? 1 : 0));
}

export function closeArmyIx(owner: PublicKey, army: PublicKey) {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: army, isSigner: false, isWritable: true },
    ],
    data: data("close_army"),
  });
}

export function computeBudgetIx(units = 1_400_000) {
  const body = Buffer.alloc(5);
  body[0] = 2;
  body.writeUInt32LE(units, 1);
  return new TransactionInstruction({
    programId: new PublicKey("ComputeBudget111111111111111111111111111111"),
    keys: [],
    data: body,
  });
}
