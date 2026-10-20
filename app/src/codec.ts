import { sha256 } from "@noble/hashes/sha2";
import {
  DELEGATION_PROGRAM_ID,
  EPHEMERAL_VAULT_ID,
  MAGIC_CONTEXT_ID,
  MAGIC_PROGRAM_ID,
  delegateBufferPdaFromDelegatedAccountAndOwnerProgram,
  delegationMetadataPdaFromDelegatedAccount,
  delegationRecordPdaFromDelegatedAccount,
} from "@magicblock-labs/ephemeral-rollups-sdk";
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

export const PROGRAM_ID = new PublicKey("zeroDcScmnx7TSvWvnKBa81Gcq34T1QSRWH182YdqRg");
export const VRF_PROGRAM_ID = new PublicKey("Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz");
// The VRF queues whose oracles call back into the rollup. ephemeral_vrf_sdk::consts::DEFAULT_EPHEMERAL_QUEUE
// is served by MagicBlock; DEFAULT_EPHEMERAL_TEST_QUEUE by the local stack's second vrf-oracle.
export const DEFAULT_EPHEMERAL_QUEUE = new PublicKey("5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc");
export const EPHEMERAL_TEST_QUEUE = new PublicKey("Sc9MJUngNbQXSXGP3F67KvKwVnhaYn6kcioxXNVowYT");
export const SLOT_HASHES = new PublicKey("SysvarS1otHashes111111111111111111111111111");
export const BPF_LOADER_UPGRADEABLE_ID = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
/** The program's `CANCEL_AFTER_SECS`: how long a battle waits for its VRF seed before anyone may cancel it. */
export const CANCEL_AFTER_SECS = 600;
export { DELEGATION_PROGRAM_ID, EPHEMERAL_VAULT_ID, MAGIC_CONTEXT_ID, MAGIC_PROGRAM_ID };

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

/** One per wallet: its lamports are the owner's balance on every battleground. */
export function playerPda(owner: PublicKey) {
  return PublicKey.findProgramAddressSync([Buffer.from("player"), owner.toBuffer()], PROGRAM_ID)[0];
}

/** One per wallet: the one-shot account a withdrawal leaves the rollup through. */
export function outboxPda(owner: PublicKey) {
  return PublicKey.findProgramAddressSync([Buffer.from("outbox"), owner.toBuffer()], PROGRAM_ID)[0];
}

export function configPda() {
  return PublicKey.findProgramAddressSync([Buffer.from("config")], PROGRAM_ID)[0];
}

/** The Outbox that pays claimed fees to the admin. */
export function treasuryOutboxPda() {
  return outboxPda(configPda());
}

export function matchPda(battleground: PublicKey, seq: number) {
  const seqBytes = Buffer.alloc(8);
  seqBytes.writeBigUInt64LE(BigInt(seq));
  return PublicKey.findProgramAddressSync([Buffer.from("match"), battleground.toBuffer(), seqBytes], PROGRAM_ID)[0];
}

export function identityPda() {
  return PublicKey.findProgramAddressSync([Buffer.from("identity")], PROGRAM_ID)[0];
}

/** The program's ProgramData `[program_id]` under the upgradeable loader; it records the upgrade authority. */
export function programDataPda() {
  return PublicKey.findProgramAddressSync([PROGRAM_ID.toBuffer()], BPF_LOADER_UPGRADEABLE_ID)[0];
}

export const PLAYER_LEN = 68;
export const CONFIG_LEN = 83;
export const OUTBOX_LEN = 49;
export const BATTLEGROUND_LEN = 576;
export const ARMY_LEN = 1360;
export const BATTLE_LEN = 2155;

function view(data: Uint8Array) {
  return new DataView(data.buffer, data.byteOffset, data.byteLength);
}

function key(data: Uint8Array, at: number) {
  return new PublicKey(data.subarray(at, at + 32));
}

/** `Player`: owner 8, budget 40, winnings 48, locked 56, segregate 64, fighting 65, bump 67. Lamports as decimal strings. */
export function decodePlayer(data: Uint8Array) {
  if (data.length !== PLAYER_LEN) return null;
  const v = view(data);
  return {
    owner: key(data, 8).toBase58(),
    budget: v.getBigUint64(40, true).toString(),
    winnings: v.getBigUint64(48, true).toString(),
    locked: v.getBigUint64(56, true).toString(),
    segregate: data[64] !== 0,
    fighting: v.getUint16(65, true),
  };
}

/** `Config`: admin 8, fee_bps 40, fees 42, pending_admin 50 (all zeros: none), bump 82. */
export function decodeConfig(data: Uint8Array) {
  if (data.length !== CONFIG_LEN) return null;
  const v = view(data);
  return {
    admin: key(data, 8).toBase58(),
    feeBps: v.getUint16(40, true),
    fees: v.getBigUint64(42, true).toString(),
    pendingAdmin: data.subarray(50, 82).some((byte) => byte !== 0) ? key(data, 50).toBase58() : null,
  };
}

/** `Outbox`: owner 8, amount 40, bump 48. */
export function decodeOutbox(data: Uint8Array) {
  if (data.length !== OUTBOX_LEN) return null;
  return { owner: key(data, 8).toBase58(), amount: view(data).getBigUint64(40, true).toString() };
}

/** The `Battleground` fields the client reads live: stake 43, queue_len 54, queue 55, match_seq 567. */
export function decodeBattleground(data: Uint8Array) {
  if (data.length !== BATTLEGROUND_LEN) return null;
  const v = view(data);
  const queueLen = Math.min(data[54], 16);
  return {
    battlegroundId: data[40],
    stake: v.getBigUint64(43, true).toString(),
    queue: Array.from({ length: queueLen }, (_, i) => key(data, 55 + i * 32).toBase58()),
    matchSeq: Number(v.getBigUint64(567, true)),
  };
}

/** The `Army` fields the client reads live: owner 8, battleground 40, status 1358. */
export function decodeArmyHead(data: Uint8Array) {
  if (data.length !== ARMY_LEN) return null;
  return { owner: key(data, 8).toBase58(), battleground: key(data, 40).toBase58(), status: data[1358] };
}

function hex(bytes: Uint8Array) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// A 96-byte battle snapshot unit: kind, len, body (77), col, row, cost u16, hp, atk, range, speed,
// the eight cast bytes, actions.
function snapshotUnit(data: Uint8Array, at: number, race: number) {
  const len = Math.min(data[at + 1], 77);
  const c = at + 87;
  return {
    kind: data[at],
    body: [...data.subarray(at + 2, at + 2 + len)],
    col: data[at + 79],
    row: data[at + 80],
    cost: view(data).getUint16(at + 81, true),
    hp: data[at + 83],
    atk: data[at + 84],
    range: data[at + 85],
    speed: data[at + 86],
    cast: { damage: data[c], range: data[c + 1], aoe: data[c + 2], effect: data[c + 3], aim: data[c + 4], power: data[c + 5], rounds: data[c + 6], cooldown: data[c + 7] },
    actions: data[at + 95],
    race,
  };
}

/**
 * `Battle`, shaped like the indexer's match rows. `status` 0 Awaiting, 2 Seeded; `seed` is hex.
 * `openedAt` is the Clock unix time `lock_army` opened it (offset 2146), which `cancel_match` waits from.
 */
export function decodeBattle(pubkey: PublicKey, data: Uint8Array) {
  if (data.length !== BATTLE_LEN) return null;
  const v = view(data);
  const countA = Math.min(data[184], 10);
  const countB = Math.min(data[185], 10);
  const raceA = data[2142];
  const raceB = data[2143];
  return {
    pubkey: pubkey.toBase58(),
    battleground: key(data, 8).toBase58(),
    armyA: key(data, 40).toBase58(),
    armyB: key(data, 72).toBase58(),
    playerA: key(data, 104).toBase58(),
    playerB: key(data, 136).toBase58(),
    stake: v.getBigUint64(168, true).toString(),
    seq: Number(v.getBigUint64(176, true)),
    cols: data[186],
    rows: data[187],
    unitsA: Array.from({ length: countA }, (_, i) => snapshotUnit(data, 188 + i * 96, raceA)),
    unitsB: Array.from({ length: countB }, (_, i) => snapshotUnit(data, 1148 + i * 96, raceB)),
    status: data[2108],
    seed: hex(data.subarray(2109, 2141)),
    outcome: data[2141],
    feeBps: v.getUint16(2144, true),
    openedAt: Number(v.getBigInt64(2146, true)),
  };
}

/**
 * `HZ_MATCH_RESOLVED <battle> <outcome> <fee> <seed> <player_b>` for `battle`, if a log line has it:
 * the outcome byte (1 A, 2 B, 3 draw), the fee in lamports, the seed in hex and side B's wallet.
 */
export function resolvedMatch(logs: readonly string[], battle: string) {
  for (const line of logs) {
    const at = line.indexOf("HZ_MATCH_RESOLVED ");
    if (at < 0) continue;
    const [name, pubkey, outcome, fee, seed, playerB] = line.slice(at).split(" ");
    if (name === "HZ_MATCH_RESOLVED" && pubkey === battle) return { outcome: Number(outcome), fee: BigInt(fee), seed, playerB };
  }
  return null;
}

/** Whether `cancel_match` may end `match` at unix time `now`: Awaiting, and `CANCEL_AFTER_SECS` after it opened. */
export function cancellable(match: { status: number; openedAt?: number | null }, now: number) {
  return match.status === 0 && typeof match.openedAt === "number" && match.openedAt > 0 && now >= match.openedAt + CANCEL_AFTER_SECS;
}

/** The outcome byte of `resolvedMatch`, or null. */
export function resolvedOutcome(logs: readonly string[], battle: string) {
  return resolvedMatch(logs, battle)?.outcome ?? null;
}

// HorizonError in programs/horizon-zero/src/error.rs, in order: Anchor numbers them from 6000.
export const PROGRAM_ERRORS: readonly (readonly [name: string, message: string])[] = [
  ["InvalidBehavior", "Behavior body is not valid"],
  ["HashMismatch", "Behavior hash does not match the body"],
  ["MissingBehavior", "Behavior account is missing or does not match the unit"],
  ["BudgetExceeded", "Army cost exceeds the battleground budget"],
  ["TooManyUnits", "An army can have at most 10 units"],
  ["BadRace", "Race is not in the catalog"],
  ["BadStatus", "Army cannot be changed in its current status"],
  ["NotAdmin", "Config admin signature is required"],
  ["OwnArmy", "You cannot match your own army"],
  ["NoStake", "Account does not hold the stake"],
  ["AlreadyResolved", "Match is already resolved"],
  ["BadPda", "Account is not the expected PDA"],
  ["NotOwner", "Signer does not own this army"],
  ["WrongBattleground", "Army is not in this battleground"],
  ["BadUnit", "Unit kind is not in the catalog"],
  ["QueueFull", "Battleground queue is full"],
  ["MissingAccount", "A required account is missing"],
  ["BadMatch", "Match account was not the next battleground match PDA"],
  ["VrfRequest", "VRF request failed"],
  ["BadQueue", "Oracle queue is not the one the program is built for"],
  ["BadGrid", "Battleground grid is not playable"],
  ["BadPosition", "Unit position is outside the starting zone"],
  ["DuplicatePosition", "Two units in one army cannot share a tile"],
  ["FeeTooHigh", "Fee rate is above the cap"],
  ["BudgetTooLow", "Player budget does not cover the battleground stake"],
  ["PlayerBusy", "Player battle count would overflow"],
  ["BalanceShort", "Player holds less than the amount asked for"],
  ["RentShort", "Player free balance does not cover the account rent"],
  ["OutboxBusy", "Outbox still holds an unreleased withdrawal"],
  ["AlreadyExists", "Account already exists"],
  ["NotSeeded", "Battle has no VRF seed yet"],
  ["NothingToWithdraw", "There is nothing to withdraw"],
  ["NotPendingAdmin", "Signer is not the proposed admin"],
  ["NotUpgradeAuthority", "Only the program's upgrade authority may initialize"],
  ["TooEarly", "Battle cannot be cancelled before its wait is over"],
  ["AlreadySeeded", "Battle is seeded: settle it instead"],
];

/** The program error for an Anchor custom code, or null for any other code. */
export function programError(code: number) {
  const entry = PROGRAM_ERRORS[code - 6000];
  return entry ? { code, name: entry[0], message: entry[1] } : null;
}

/**
 * The custom error code in a failed transaction's logs, only when this program raised it: the
 * innermost `Program <id> failed: custom program error` line must name this program. Null for
 * anything else, such as a code from the compute-budget, system or VRF program, or no such line.
 */
export function horizonErrorCode(logs: readonly string[]) {
  for (const line of logs) {
    const match = /Program (\w+) failed: custom program error: 0x([0-9a-f]+)/i.exec(line);
    if (match) return match[1] === PROGRAM_ID.toBase58() ? Number.parseInt(match[2], 16) : null;
  }
  return null;
}

function data(name: string, rest: Uint8Array = new Uint8Array()) {
  const out = new Uint8Array(8 + rest.length);
  out.set(sighash(name), 0);
  out.set(rest, 8);
  return Buffer.from(out);
}

type Meta = { pubkey: PublicKey; isSigner: boolean; isWritable: boolean };

function signer(pubkey: PublicKey, isWritable = true): Meta {
  return { pubkey, isSigner: true, isWritable };
}

function writable(pubkey: PublicKey): Meta {
  return { pubkey, isSigner: false, isWritable: true };
}

function readonly(pubkey: PublicKey): Meta {
  return { pubkey, isSigner: false, isWritable: false };
}

function ix(name: string, keys: Meta[], rest?: Uint8Array) {
  return new TransactionInstruction({ programId: PROGRAM_ID, keys, data: data(name, rest) });
}

function u64(value: bigint) {
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(value);
  return out;
}

/** `EphAccounts`: what creating or closing an ephemeral account needs after the account itself. */
function ephemeral(): Meta[] {
  return [writable(EPHEMERAL_VAULT_ID), readonly(MAGIC_PROGRAM_ID)];
}

/** `MagicAccounts`: what scheduling the Outbox's commit-and-undelegate needs. */
function magic(): Meta[] {
  return [writable(MAGIC_CONTEXT_ID), readonly(MAGIC_PROGRAM_ID)];
}

/**
 * `#[delegate]`'s order for one delegated account: its buffer, delegation record and metadata, the
 * account, then this program, the delegation program and the system program.
 */
function delegated(account: PublicKey): { head: Meta[]; tail: Meta[] } {
  return {
    head: [
      writable(delegateBufferPdaFromDelegatedAccountAndOwnerProgram(account, PROGRAM_ID)),
      writable(delegationRecordPdaFromDelegatedAccount(account)),
      writable(delegationMetadataPdaFromDelegatedAccount(account)),
      writable(account),
    ],
    tail: [readonly(PROGRAM_ID), readonly(DELEGATION_PROGRAM_ID), readonly(SystemProgram.programId)],
  };
}

function delegateIx(name: string, signerKey: PublicKey, account: PublicKey, withConfig: boolean) {
  const { head, tail } = delegated(account);
  return ix(name, [signer(signerKey), ...(withConfig ? [readonly(configPda())] : []), ...head, ...tail]);
}

/**
 * Solana, once. The signer becomes the admin and must be the program's upgrade authority (the
 * program checks ProgramData). The rollup validator is built into the program (`HZ_VALIDATOR`).
 */
export function initializeIx(admin: PublicKey, feeBps: number) {
  const rest = new Uint8Array(2);
  new DataView(rest.buffer).setUint16(0, feeBps, true);
  return ix(
    "initialize",
    [
      signer(admin),
      writable(configPda()),
      writable(identityPda()),
      readonly(SystemProgram.programId),
      readonly(PROGRAM_ID),
      readonly(programDataPda()),
    ],
    rest,
  );
}

/** Solana, admin. */
export function createBattlegroundIx(
  admin: PublicKey,
  ground: { id: number; budget: number; stake: number | bigint; cols: number; rows: number },
) {
  const rest = Buffer.alloc(13);
  rest[0] = ground.id;
  rest.writeUInt16LE(ground.budget, 1);
  rest.writeBigUInt64LE(BigInt(ground.stake), 3);
  rest[11] = ground.cols;
  rest[12] = ground.rows;
  return ix(
    "create_battleground",
    [signer(admin), readonly(configPda()), writable(battlegroundPda(ground.id)), readonly(SystemProgram.programId)],
    rest,
  );
}

/** Solana, admin, once. Creates the treasury Outbox `[b"outbox", config]`. */
export function initTreasuryOutboxIx(admin: PublicKey) {
  return ix("init_treasury_outbox", [signer(admin), readonly(configPda()), writable(treasuryOutboxPda()), readonly(SystemProgram.programId)]);
}

/** Solana, admin. Delegates Config to the rollup validator. */
export function delegateConfigIx(admin: PublicKey) {
  const { head, tail } = delegated(configPda());
  return ix("delegate_config", [signer(admin), ...head, ...tail]);
}

/** Solana, admin. */
export function delegateBattlegroundIx(admin: PublicKey, battlegroundId: number) {
  const { head, tail } = delegated(battlegroundPda(battlegroundId));
  return ix("delegate_battleground", [signer(admin), readonly(configPda()), ...head, ...tail], Uint8Array.of(battlegroundId));
}

/** Solana. Creates the wallet's Player and Outbox and moves `deposit` into the Player's free lamports. */
export function registerPlayerIx(owner: PublicKey, deposit: bigint) {
  return ix(
    "register_player",
    [signer(owner), writable(playerPda(owner)), writable(outboxPda(owner)), readonly(SystemProgram.programId)],
    u64(deposit),
  );
}

/** Solana. Delegates the wallet's Player to the rollup validator. */
export function delegatePlayerIx(owner: PublicKey) {
  return delegateIx("delegate_player", owner, playerPda(owner), false);
}

/** Solana. Delegates the wallet's empty Outbox again before a withdrawal. */
export function delegateOutboxIx(owner: PublicKey) {
  return delegateIx("delegate_outbox", owner, outboxPda(owner), false);
}

/** Solana, admin. Delegates the empty treasury Outbox again before a claim. */
export function delegateTreasuryOutboxIx(admin: PublicKey) {
  return delegateIx("delegate_treasury_outbox", admin, treasuryOutboxPda(), true);
}

/** Rollup. Moves free lamports into the budget. */
export function fundBudgetIx(owner: PublicKey, lamports: bigint) {
  return ix("fund_budget", [signer(owner, false), writable(playerPda(owner))], u64(lamports));
}

/** Rollup. Off, a won payout goes back into the budget; on, it is set aside as winnings. */
export function setSegregationIx(owner: PublicKey, segregate: boolean) {
  return ix("set_segregation", [signer(owner, false), writable(playerPda(owner))], Uint8Array.of(segregate ? 1 : 0));
}

/** Rollup. Moves `lamports` from the Player (free, then winnings, then budget) into the Outbox. `withdrawIx` follows in the same transaction. */
export function fundOutboxIx(owner: PublicKey, lamports: bigint) {
  return ix("fund_outbox", [signer(owner, false), writable(playerPda(owner)), writable(outboxPda(owner))], u64(lamports));
}

/**
 * Rollup. Schedules one bundle: a commit of the owner's Player (it stays delegated) and the funded
 * Outbox's commit-and-undelegate; `release_outbox` then pays the wallet on Solana.
 */
export function withdrawIx(owner: PublicKey) {
  return ix("withdraw", [signer(owner), writable(playerPda(owner)), writable(outboxPda(owner)), ...magic()]);
}

/** Solana, permissionless. Pays an undelegated Outbox's amount to its recorded owner. */
export function releaseOutboxIx(outbox: PublicKey, owner: PublicKey) {
  return ix("release_outbox", [writable(outbox), writable(owner)]);
}

/** Rollup, admin. */
export function setFeeIx(admin: PublicKey, bps: number) {
  const rest = new Uint8Array(2);
  new DataView(rest.buffer).setUint16(0, bps, true);
  return ix("set_fee", [signer(admin, false), writable(configPda())], rest);
}

/** Rollup, admin. Proposes `newAdmin`, who takes over with `acceptAdminIx`; `PublicKey.default` withdraws the proposal. */
export function setAdminIx(admin: PublicKey, newAdmin: PublicKey) {
  return ix("set_admin", [signer(admin, false), writable(configPda())], newAdmin.toBytes());
}

/** Rollup, signed by the proposed admin. Makes it Config's admin and commits Config to Solana. */
export function acceptAdminIx(newAdmin: PublicKey) {
  return ix("accept_admin", [signer(newAdmin), writable(configPda()), ...magic()]);
}

/** Rollup, admin. Moves every claimable fee into the treasury Outbox. `claimFeesIx` follows in the same transaction. */
export function fundTreasuryOutboxIx(admin: PublicKey) {
  return ix("fund_treasury_outbox", [signer(admin, false), writable(configPda()), writable(treasuryOutboxPda())]);
}

/** Rollup, admin. `withdrawIx` for the treasury Outbox: commits Config with it. */
export function claimFeesIx(admin: PublicKey) {
  return ix("claim_fees", [signer(admin), writable(configPda()), writable(treasuryOutboxPda()), ...magic()]);
}

/** Rollup, permissionless. Pays out a Seeded battle and closes it. */
export function settleMatchIx(match: { pubkey: string; armyA: string; armyB: string; playerA: string; playerB: string }) {
  return ix("settle_match", [
    writable(new PublicKey(match.pubkey)),
    writable(new PublicKey(match.armyA)),
    writable(new PublicKey(match.armyB)),
    writable(playerPda(new PublicKey(match.playerA))),
    writable(playerPda(new PublicKey(match.playerB))),
    writable(configPda()),
    ...ephemeral(),
  ]);
}

/**
 * Rollup, permissionless. Ends an Awaiting battle `CANCEL_AFTER_SECS` after it opened: both stakes
 * go back to their budgets, both armies become Idle, and the battle's rent goes to side B's Player.
 */
export function cancelMatchIx(match: { pubkey: string; armyA: string; armyB: string; playerA: string; playerB: string }) {
  return ix("cancel_match", [
    writable(new PublicKey(match.pubkey)),
    writable(new PublicKey(match.armyA)),
    writable(new PublicKey(match.armyB)),
    writable(playerPda(new PublicKey(match.playerA))),
    writable(playerPda(new PublicKey(match.playerB))),
    ...ephemeral(),
  ]);
}

export function createBehaviorIx(creator: PublicKey, elements: ElementSpec[]) {
  const body = encodeBehavior(elements);
  if (!body) throw new Error("Behavior body is not valid");
  const hash = behaviorHash(body);
  const rest = new Uint8Array(36 + body.length);
  rest.set(hash, 0);
  new DataView(rest.buffer).setUint32(32, body.length, true);
  rest.set(body, 36);
  return ix(
    "create_behavior",
    [signer(creator, false), writable(playerPda(creator)), writable(behaviorPda(body)), ...ephemeral(), readonly(SystemProgram.programId)],
    rest,
  );
}

export function createArmyIx(
  owner: PublicKey,
  battlegroundId: number,
  index: number,
  race: number,
  units: { kind: number; behavior: PublicKey; col: number; row: number }[],
) {
  const rest = new Uint8Array(4 + 1 + 4 + units.length * 35);
  const v = new DataView(rest.buffer);
  v.setUint32(0, index, true);
  rest[4] = race;
  v.setUint32(5, units.length, true);
  units.forEach((unit, i) => {
    const at = 9 + i * 35;
    rest[at] = unit.kind;
    rest.set(unit.behavior.toBytes(), at + 1);
    rest[at + 33] = unit.col;
    rest[at + 34] = unit.row;
  });
  return ix(
    "create_army",
    [
      signer(owner, false),
      writable(playerPda(owner)),
      readonly(battlegroundPda(battlegroundId)),
      writable(armyPda(owner, index)),
      ...ephemeral(),
      readonly(SystemProgram.programId),
      ...units.map((unit) => readonly(unit.behavior)),
    ],
    rest,
  );
}

/** How many queue entries, from the front, `lock_army` requires and may match (`MATCH_WINDOW`). */
export const MATCH_WINDOW = 8;

/**
 * Rollup. `candidates` are the first `MATCH_WINDOW` queue entries, the locker's own armies
 * included; the program refuses a lock that leaves one out (`MissingAccount`). Each is passed
 * writable, with its owner's Player once unless the locker owns it. The program matches a candidate
 * whose owner's budget covers the stake and evicts one whose owner's Player shows less. `opens` says a candidate's owner covers the stake, so
 * the lock opens a battle: only then is the battle passed writable. The rollup refuses a transaction
 * that passes writable an account it neither holds nor creates, so a lock that queues passes it read-only.
 */
export function lockArmyIx(args: {
  player: PublicKey;
  battlegroundId: number;
  army: PublicKey;
  queue: PublicKey;
  seq: number;
  candidates: { army: PublicKey; owner: PublicKey }[];
  opens: boolean;
}) {
  const battleground = battlegroundPda(args.battlegroundId);
  const keys = [
    signer(args.player),
    writable(playerPda(args.player)),
    readonly(configPda()),
    writable(battleground),
    writable(args.army),
    args.opens ? writable(matchPda(battleground, args.seq)) : readonly(matchPda(battleground, args.seq)),
    ...ephemeral(),
    writable(args.queue),
    readonly(identityPda()),
    readonly(VRF_PROGRAM_ID),
    readonly(SLOT_HASHES),
    readonly(SystemProgram.programId),
  ];
  for (const candidate of args.candidates) keys.push(writable(candidate.army));
  for (const owner of new Set(args.candidates.map((candidate) => candidate.owner.toBase58()))) {
    if (owner !== args.player.toBase58()) keys.push(writable(playerPda(new PublicKey(owner))));
  }
  return ix("lock_army", keys);
}

type Fetched = { owner: PublicKey; data: Uint8Array } | null;

/**
 * Whether a `lock_army` offering these candidates opens a match, and so must pass the battle
 * writable (see `lockArmyIx`). It mirrors the program's `queued_opponents`: a candidate counts only
 * when its army, owned by this program, is Queued and not the locker's own, and its owner's Player,
 * owned by this program, has a budget that covers the stake. `armies` are the candidate armies and
 * `players` their owners' Player accounts as the rollup returned them, null when missing.
 */
export function lockOpens(args: { locker: PublicKey; stake: bigint; armies: readonly Fetched[]; players: readonly Fetched[] }) {
  const budgets = new Map<string, bigint>();
  for (const info of args.players) {
    const player = info && info.owner.equals(PROGRAM_ID) ? decodePlayer(info.data) : null;
    if (player) budgets.set(player.owner, BigInt(player.budget));
  }
  const locker = args.locker.toBase58();
  return args.armies.some((info) => {
    const army = info && info.owner.equals(PROGRAM_ID) ? decodeArmyHead(info.data) : null;
    if (!army || army.status !== 1 || army.owner === locker) return false;
    const budget = budgets.get(army.owner);
    return budget !== undefined && budget >= args.stake;
  });
}

export function unlockArmyIx(player: PublicKey, battlegroundId: number, army: PublicKey) {
  return ix("unlock_army", [signer(player, false), writable(battlegroundPda(battlegroundId)), writable(army)]);
}

export function closeArmyIx(owner: PublicKey, army: PublicKey) {
  return ix("close_army", [signer(owner, false), writable(playerPda(owner)), writable(army), ...ephemeral()]);
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
