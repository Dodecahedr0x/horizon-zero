// Checks the client's instruction builders and decoders against docs/src/accounts.md.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import test from "node:test";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import {
  ARMY_LEN,
  BATTLEGROUND_LEN,
  PROGRAM_ERRORS,
  STANDARDS,
  armyPda,
  behaviorHash,
  behaviorPda,
  closeArmyIx,
  createArmyIx,
  createBehaviorIx,
  horizonErrorCode,
  decodeArmyHead,
  decodeBattleground,
  delegateOutboxIx,
  encodeBehavior,
  fundBudgetIx,
  programError,
  setSegregationIx,
  unlockArmyIx,
  DELEGATION_PROGRAM_ID,
  EPHEMERAL_VAULT_ID,
  MAGIC_CONTEXT_ID,
  MAGIC_PROGRAM_ID,
  PROGRAM_ID,
  SLOT_HASHES,
  VRF_PROGRAM_ID,
  battlegroundPda,
  claimFeesIx,
  BPF_LOADER_UPGRADEABLE_ID,
  CANCEL_AFTER_SECS,
  cancelMatchIx,
  cancellable,
  programDataPda,
  configPda,
  decodeBattle,
  decodeConfig,
  decodeOutbox,
  decodePlayer,
  createBattlegroundIx,
  delegateBattlegroundIx,
  delegateConfigIx,
  delegatePlayerIx,
  delegateTreasuryOutboxIx,
  initTreasuryOutboxIx,
  initializeIx,
  fundOutboxIx,
  fundTreasuryOutboxIx,
  identityPda,
  lockArmyIx,
  lockOpens,
  matchPda,
  outboxPda,
  playerPda,
  registerPlayerIx,
  releaseOutboxIx,
  resolvedMatch,
  resolvedOutcome,
  setFeeIx,
  settleMatchIx,
  treasuryOutboxPda,
  withdrawIx,
} from "./codec.ts";

const discriminator = (name) => crypto.createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
const key = (n) => new PublicKey(Uint8Array.from({ length: 32 }, (_, i) => (i === 0 ? n : i)));
const owner = key(1);
const pda = (seeds, program) => PublicKey.findProgramAddressSync(seeds, program)[0];

// [pubkey, isSigner, isWritable] for each meta, in order.
function metas(ix) {
  return ix.keys.map((meta) => [meta.pubkey.toBase58(), meta.isSigner, meta.isWritable]);
}

function expect(ix, name, keys, rest = Buffer.alloc(0)) {
  assert.equal(ix.programId.toBase58(), PROGRAM_ID.toBase58());
  assert.deepEqual(ix.data, Buffer.concat([discriminator(name), rest]));
  assert.deepEqual(metas(ix), keys.map(([pubkey, signer, writable]) => [pubkey.toBase58(), signer, writable]));
}

const u64 = (n) => {
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(BigInt(n));
  return out;
};

test("PDAs use the documented seeds", () => {
  assert.equal(playerPda(owner).toBase58(), pda([Buffer.from("player"), owner.toBuffer()], PROGRAM_ID).toBase58());
  assert.equal(outboxPda(owner).toBase58(), pda([Buffer.from("outbox"), owner.toBuffer()], PROGRAM_ID).toBase58());
  assert.equal(treasuryOutboxPda().toBase58(), pda([Buffer.from("outbox"), configPda().toBuffer()], PROGRAM_ID).toBase58());
});

test("register_player and delegate_player follow the program's account order", () => {
  expect(registerPlayerIx(owner, 5n), "register_player", [
    [owner, true, true],
    [playerPda(owner), false, true],
    [outboxPda(owner), false, true],
    [SystemProgram.programId, false, false],
  ], u64(5));
  const player = playerPda(owner);
  expect(delegatePlayerIx(owner), "delegate_player", [
    [owner, true, true],
    [configPda(), false, false],
    [pda([Buffer.from("buffer"), player.toBuffer()], PROGRAM_ID), false, true],
    [pda([Buffer.from("delegation"), player.toBuffer()], DELEGATION_PROGRAM_ID), false, true],
    [pda([Buffer.from("delegation-metadata"), player.toBuffer()], DELEGATION_PROGRAM_ID), false, true],
    [player, false, true],
    [PROGRAM_ID, false, false],
    [DELEGATION_PROGRAM_ID, false, false],
    [SystemProgram.programId, false, false],
  ]);
  const treasury = delegateTreasuryOutboxIx(owner);
  assert.equal(treasury.keys.length, 9);
  assert.equal(treasury.keys[5].pubkey.toBase58(), treasuryOutboxPda().toBase58());
});

test("the admin's Solana instructions follow the program's account order", () => {
  const validator = key(9);
  const fee = Buffer.alloc(2);
  fee.writeUInt16LE(500);
  expect(initializeIx(owner, 500, validator), "initialize", [
    [owner, true, true],
    [configPda(), false, true],
    [identityPda(), false, true],
    [SystemProgram.programId, false, false],
    [PROGRAM_ID, false, false],
    [pda([PROGRAM_ID.toBuffer()], BPF_LOADER_UPGRADEABLE_ID), false, false],
  ], Buffer.concat([fee, validator.toBuffer()]));
  assert.equal(programDataPda().toBase58(), pda([PROGRAM_ID.toBuffer()], new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111")).toBase58());
  const args = Buffer.alloc(13);
  args[0] = 1;
  args.writeUInt16LE(16, 1);
  args.writeBigUInt64LE(50_000_000n, 3);
  args[11] = 10;
  args[12] = 8;
  expect(createBattlegroundIx(owner, { id: 1, budget: 16, stake: 50_000_000, cols: 10, rows: 8 }), "create_battleground", [
    [owner, true, true],
    [configPda(), false, false],
    [battlegroundPda(1), false, true],
    [SystemProgram.programId, false, false],
  ], args);
  expect(initTreasuryOutboxIx(owner), "init_treasury_outbox", [
    [owner, true, true],
    [configPda(), false, false],
    [treasuryOutboxPda(), false, true],
    [SystemProgram.programId, false, false],
  ]);
  const delegatedKeys = (account) => [
    [pda([Buffer.from("buffer"), account.toBuffer()], PROGRAM_ID), false, true],
    [pda([Buffer.from("delegation"), account.toBuffer()], DELEGATION_PROGRAM_ID), false, true],
    [pda([Buffer.from("delegation-metadata"), account.toBuffer()], DELEGATION_PROGRAM_ID), false, true],
    [account, false, true],
    [PROGRAM_ID, false, false],
    [DELEGATION_PROGRAM_ID, false, false],
    [SystemProgram.programId, false, false],
  ];
  expect(delegateConfigIx(owner), "delegate_config", [[owner, true, true], ...delegatedKeys(configPda())]);
  expect(delegateBattlegroundIx(owner, 2), "delegate_battleground", [
    [owner, true, true],
    [configPda(), false, false],
    ...delegatedKeys(battlegroundPda(2)),
  ], Buffer.from([2]));
});

test("fund_outbox then withdraw, and the treasury pair", () => {
  expect(fundOutboxIx(owner, 7n), "fund_outbox", [
    [owner, true, false],
    [playerPda(owner), false, true],
    [outboxPda(owner), false, true],
  ], u64(7));
  expect(withdrawIx(owner), "withdraw", [
    [owner, true, true],
    [playerPda(owner), false, true],
    [outboxPda(owner), false, true],
    [MAGIC_CONTEXT_ID, false, true],
    [MAGIC_PROGRAM_ID, false, false],
  ]);
  expect(fundTreasuryOutboxIx(owner), "fund_treasury_outbox", [
    [owner, true, false],
    [configPda(), false, true],
    [treasuryOutboxPda(), false, true],
  ]);
  expect(claimFeesIx(owner), "claim_fees", [
    [owner, true, true],
    [configPda(), false, true],
    [treasuryOutboxPda(), false, true],
    [MAGIC_CONTEXT_ID, false, true],
    [MAGIC_PROGRAM_ID, false, false],
  ]);
  expect(releaseOutboxIx(outboxPda(owner), owner), "release_outbox", [
    [outboxPda(owner), false, true],
    [owner, false, true],
  ]);
  expect(setFeeIx(owner, 500), "set_fee", [[owner, true, false], [configPda(), false, true]], Buffer.from([0xf4, 0x01]));
});

test("lock_army passes the VRF accounts, then behaviors, candidates and each owner's Player once", () => {
  const army = key(2);
  const behavior = key(3);
  const queue = key(4);
  const rival = key(5);
  const ground = battlegroundPda(1);
  const ix = lockArmyIx({
    player: owner,
    battlegroundId: 1,
    army,
    behaviors: [behavior],
    queue,
    seq: 9,
    candidates: [{ army: key(6), owner: rival }, { army: key(7), owner: rival }],
    opens: true,
  });
  expect(ix, "lock_army", [
    [owner, true, true],
    [playerPda(owner), false, true],
    [configPda(), false, false],
    [ground, false, true],
    [army, false, true],
    [matchPda(ground, 9), false, true],
    [EPHEMERAL_VAULT_ID, false, true],
    [MAGIC_PROGRAM_ID, false, false],
    [queue, false, true],
    [identityPda(), false, false],
    [VRF_PROGRAM_ID, false, false],
    [SLOT_HASHES, false, false],
    [SystemProgram.programId, false, false],
    [behavior, false, false],
    [key(6), false, true],
    [key(7), false, true],
    [playerPda(rival), false, true],
  ]);
  // A lock that can only queue passes the battle read-only.
  const queues = lockArmyIx({ player: owner, battlegroundId: 1, army, behaviors: [behavior], queue, seq: 9, candidates: [], opens: false });
  assert.deepEqual(metas(queues)[5], [matchPda(ground, 9).toBase58(), false, false]);
});

test("a lock opens a match only for a Queued army of another wallet whose owner's Player covers the stake", () => {
  const rival = key(5);
  const player = (budget, who = rival) => {
    const data = Buffer.alloc(68);
    who.toBuffer().copy(data, 8);
    data.writeBigUInt64LE(BigInt(budget), 40);
    return { owner: PROGRAM_ID, data };
  };
  const army = (status, who = rival) => {
    const data = Buffer.alloc(1360);
    who.toBuffer().copy(data, 8);
    data[1358] = status;
    return { owner: PROGRAM_ID, data };
  };
  const opens = (armies, players) => lockOpens({ locker: owner, stake: 10n, armies, players });
  assert.equal(opens([], []), false, "no candidate: the lock queues");
  assert.equal(opens([army(1)], [null]), false, "a missing Player does not match");
  assert.equal(opens([army(1)], [player(9)]), false, "a short budget does not match");
  assert.equal(opens([army(1)], [player(9), player(10)]), true, "one owner whose budget covers the stake is enough");
  assert.equal(opens([army(1)], [{ ...player(10), owner: SystemProgram.programId }]), false, "a Player the program does not own is ignored");
  assert.equal(opens([army(1)], [{ owner: PROGRAM_ID, data: Buffer.alloc(49) }]), false, "an account that is not a Player is ignored");
  assert.equal(opens([army(0)], [player(10)]), false, "an Idle army is not matched");
  assert.equal(opens([army(2)], [player(10)]), false, "a Fighting army is not matched");
  assert.equal(opens([army(1, owner)], [player(10, owner)]), false, "the locker's own army is not matched");
  assert.equal(opens([null, { ...army(1), owner: SystemProgram.programId }], [player(10)]), false, "a missing or foreign army is ignored");
  assert.equal(opens([army(1, key(6))], [player(10)]), false, "the funded Player must be the army owner's");
  assert.equal(opens([army(0), army(1)], [player(10)]), true, "a later Queued candidate still matches");
});

test("settle_match passes the battle, both armies, both Players, Config and the ephemeral accounts", () => {
  const match = { pubkey: key(8).toBase58(), armyA: key(9).toBase58(), armyB: key(10).toBase58(), playerA: key(11).toBase58(), playerB: key(12).toBase58() };
  expect(settleMatchIx(match), "settle_match", [
    [key(8), false, true],
    [key(9), false, true],
    [key(10), false, true],
    [playerPda(key(11)), false, true],
    [playerPda(key(12)), false, true],
    [configPda(), false, true],
    [EPHEMERAL_VAULT_ID, false, true],
    [MAGIC_PROGRAM_ID, false, false],
  ]);
});

test("cancel_match passes the battle, both armies, both Players and the ephemeral accounts", () => {
  const match = { pubkey: key(8).toBase58(), armyA: key(9).toBase58(), armyB: key(10).toBase58(), playerA: key(11).toBase58(), playerB: key(12).toBase58() };
  expect(cancelMatchIx(match), "cancel_match", [
    [key(8), false, true],
    [key(9), false, true],
    [key(10), false, true],
    [playerPda(key(11)), false, true],
    [playerPda(key(12)), false, true],
    [EPHEMERAL_VAULT_ID, false, true],
    [MAGIC_PROGRAM_ID, false, false],
  ]);
});

test("a battle is cancellable only while Awaiting, CANCEL_AFTER_SECS after it opened", () => {
  assert.equal(CANCEL_AFTER_SECS, 600);
  const opened = 1_792_016_933;
  assert.equal(cancellable({ status: 0, openedAt: opened }, opened + 599), false, "too early");
  assert.equal(cancellable({ status: 0, openedAt: opened }, opened + 600), true, "the program's own bound");
  assert.equal(cancellable({ status: 2, openedAt: opened }, opened + 9_999), false, "seeded: settle instead");
  assert.equal(cancellable({ status: 1, openedAt: opened }, opened + 9_999), false, "resolved");
  assert.equal(cancellable({ status: 3, openedAt: opened }, opened + 9_999), false, "already cancelled");
  assert.equal(cancellable({ status: 0, openedAt: null }, opened), false, "unknown open time");
  assert.equal(cancellable({ status: 0 }, opened), false, "no open time");
});

test("decoders read the documented offsets", () => {
  const player = Buffer.alloc(68);
  owner.toBuffer().copy(player, 8);
  player.writeBigUInt64LE(100n, 40);
  player.writeBigUInt64LE(200n, 48);
  player.writeBigUInt64LE(300n, 56);
  player[64] = 1;
  player.writeUInt16LE(2, 65);
  assert.deepEqual(decodePlayer(player), { owner: owner.toBase58(), budget: "100", winnings: "200", locked: "300", segregate: true, fighting: 2 });
  assert.equal(decodePlayer(Buffer.alloc(76)), null);

  const config = Buffer.alloc(83);
  owner.toBuffer().copy(config, 8);
  config.writeUInt16LE(500, 40);
  config.writeBigUInt64LE(42n, 42);
  key(13).toBuffer().copy(config, 50);
  assert.deepEqual(decodeConfig(config), { admin: owner.toBase58(), feeBps: 500, fees: "42", validator: key(13).toBase58() });

  const outbox = Buffer.alloc(49);
  owner.toBuffer().copy(outbox, 8);
  outbox.writeBigUInt64LE(7n, 40);
  assert.deepEqual(decodeOutbox(outbox), { owner: owner.toBase58(), amount: "7" });

  const battle = Buffer.alloc(2155);
  [8, 40, 72, 104, 136].forEach((at, i) => key(20 + i).toBuffer().copy(battle, at));
  battle.writeBigUInt64LE(10_000_000n, 168);
  battle.writeBigUInt64LE(3n, 176);
  battle[184] = 1;
  battle[185] = 0;
  battle[186] = 8;
  battle[187] = 6;
  battle[188] = 4; // units_a[0].kind
  battle[189] = 2; // len
  battle[190] = 1;
  battle[191] = 0;
  battle[188 + 79] = 3; // col
  battle[188 + 80] = 1; // row
  battle.writeUInt16LE(12, 188 + 81);
  battle[188 + 83] = 9; // hp
  battle[188 + 90] = 5; // cast effect
  battle[188 + 95] = 1; // actions
  battle[2108] = 2;
  battle.fill(0xab, 2109, 2141);
  battle[2142] = 1;
  battle.writeUInt16LE(500, 2144);
  battle.writeBigInt64LE(1_792_016_933n, 2146);
  battle[2154] = 253;
  const decoded = decodeBattle(key(30), battle);
  assert.equal(decoded.openedAt, 1_792_016_933);
  assert.equal(decodeBattle(key(30), Buffer.alloc(2147)), null, "the layout before opened_at is not read");
  assert.equal(decoded.battleground, key(20).toBase58());
  assert.equal(decoded.playerB, key(24).toBase58());
  assert.equal(decoded.stake, "10000000");
  assert.equal(decoded.seq, 3);
  assert.equal(decoded.status, 2);
  assert.equal(decoded.seed, "ab".repeat(32));
  assert.equal(decoded.feeBps, 500);
  assert.equal(decoded.unitsB.length, 0);
  assert.deepEqual(decoded.unitsA[0], {
    kind: 4,
    body: [1, 0],
    col: 3,
    row: 1,
    cost: 12,
    hp: 9,
    atk: 0,
    range: 0,
    speed: 0,
    cast: { damage: 0, range: 0, aoe: 0, effect: 5, aim: 0, power: 0, rounds: 0, cooldown: 0 },
    actions: 1,
    race: 1,
  });

  const battleKey = key(30).toBase58();
  assert.equal(resolvedOutcome(["Program log: Instruction: SettleMatch", `Program log: HZ_MATCH_RESOLVED ${battleKey} 2 1000 ${"ab".repeat(32)} ${key(24).toBase58()}`], battleKey), 2);
  assert.equal(resolvedOutcome(["Program log: HZ_PLAYER x"], battleKey), null);
  assert.deepEqual(resolvedMatch([`Program log: HZ_MATCH_RESOLVED ${battleKey} 1 1000000 ${"cd".repeat(32)} ${key(24).toBase58()}`], battleKey), {
    outcome: 1,
    fee: 1_000_000n,
    seed: "cd".repeat(32),
    playerB: key(24).toBase58(),
  });
  assert.equal(resolvedMatch([`Program log: HZ_MATCH_RESOLVED ${key(25).toBase58()} 1 0 00 x`], battleKey), null, "another battle's line");
});

test("delegate_outbox, fund_budget, set_segregation, unlock_army and close_army follow the program", () => {
  const outbox = outboxPda(owner);
  expect(delegateOutboxIx(owner), "delegate_outbox", [
    [owner, true, true],
    [configPda(), false, false],
    [pda([Buffer.from("buffer"), outbox.toBuffer()], PROGRAM_ID), false, true],
    [pda([Buffer.from("delegation"), outbox.toBuffer()], DELEGATION_PROGRAM_ID), false, true],
    [pda([Buffer.from("delegation-metadata"), outbox.toBuffer()], DELEGATION_PROGRAM_ID), false, true],
    [outbox, false, true],
    [PROGRAM_ID, false, false],
    [DELEGATION_PROGRAM_ID, false, false],
    [SystemProgram.programId, false, false],
  ]);
  expect(fundBudgetIx(owner, 9n), "fund_budget", [[owner, true, false], [playerPda(owner), false, true]], u64(9));
  expect(setSegregationIx(owner, true), "set_segregation", [[owner, true, false], [playerPda(owner), false, true]], Buffer.from([1]));
  expect(unlockArmyIx(owner, 2, key(2)), "unlock_army", [[owner, true, true], [battlegroundPda(2), false, true], [key(2), false, true]]);
  expect(closeArmyIx(owner, key(2)), "close_army", [
    [owner, true, false],
    [playerPda(owner), false, true],
    [key(2), false, true],
    [EPHEMERAL_VAULT_ID, false, true],
    [MAGIC_PROGRAM_ID, false, false],
  ]);
});

test("create_behavior and create_army lay out their data and accounts", () => {
  const elements = STANDARDS[0].elements;
  const body = encodeBehavior(elements);
  const length = Buffer.alloc(4);
  length.writeUInt32LE(body.length);
  expect(createBehaviorIx(owner, elements), "create_behavior", [
    [owner, true, false],
    [playerPda(owner), false, true],
    [behaviorPda(body), false, true],
    [EPHEMERAL_VAULT_ID, false, true],
    [MAGIC_PROGRAM_ID, false, false],
    [SystemProgram.programId, false, false],
  ], Buffer.concat([Buffer.from(behaviorHash(body)), length, Buffer.from(body)]));

  const behavior = key(3);
  const rest = Buffer.concat([
    Buffer.from([4, 0, 0, 0]), // index
    Buffer.from([1]), // race
    Buffer.from([1, 0, 0, 0]), // unit count
    Buffer.from([2]), behavior.toBuffer(), Buffer.from([5, 1]), // kind, behavior, col, row
  ]);
  expect(createArmyIx(owner, 0, 4, 1, [{ kind: 2, behavior, col: 5, row: 1 }]), "create_army", [
    [owner, true, false],
    [playerPda(owner), false, true],
    [battlegroundPda(0), false, false],
    [armyPda(owner, 4), false, true],
    [EPHEMERAL_VAULT_ID, false, true],
    [MAGIC_PROGRAM_ID, false, false],
    [SystemProgram.programId, false, false],
    [behavior, false, false],
  ], rest);
});

test("battleground and army decoders read the documented offsets, and every decoder checks the length", () => {
  const ground = Buffer.alloc(BATTLEGROUND_LEN);
  ground[40] = 2;
  ground.writeBigUInt64LE(10_000_000n, 43);
  ground[54] = 2;
  key(40).toBuffer().copy(ground, 55);
  key(41).toBuffer().copy(ground, 87);
  ground.writeBigUInt64LE(17n, 567);
  assert.deepEqual(decodeBattleground(ground), { battlegroundId: 2, stake: "10000000", queue: [key(40).toBase58(), key(41).toBase58()], matchSeq: 17 });

  const army = Buffer.alloc(ARMY_LEN);
  owner.toBuffer().copy(army, 8);
  key(42).toBuffer().copy(army, 40);
  army[1358] = 1;
  assert.deepEqual(decodeArmyHead(army), { owner: owner.toBase58(), battleground: key(42).toBase58(), status: 1 });

  for (const decode of [decodePlayer, decodeConfig, decodeOutbox, decodeBattleground, decodeArmyHead]) assert.equal(decode(Buffer.alloc(10)), null);
  assert.equal(decodeBattle(key(1), Buffer.alloc(2146)), null);
});

test("the error map follows HorizonError in error.rs", () => {
  const source = fs.readFileSync(new URL("../../programs/horizon-zero/src/error.rs", import.meta.url), "utf8");
  const variants = [...source.matchAll(/#\[msg\("([^"]*)"\)\]\s*(\w+),/g)].map((match) => [match[2], match[1]]);
  assert.ok(variants.length > 0);
  assert.deepEqual(PROGRAM_ERRORS.map((entry) => [...entry]), variants);
  const outboxBusy = 6000 + variants.findIndex(([name]) => name === "OutboxBusy");
  assert.equal(programError(outboxBusy).name, "OutboxBusy");
  assert.equal(programError(5999), null);
  const enumBody = /pub enum HorizonError \{([^}]*)\}/.exec(source)[1];
  const allVariants = [...enumBody.matchAll(/^\s*(\w+),\s*$/gm)].map((match) => match[1]);
  assert.equal(PROGRAM_ERRORS.length, allVariants.length);

  const hex = outboxBusy.toString(16);
  assert.equal(horizonErrorCode([`Program ${PROGRAM_ID.toBase58()} invoke [1]`, `Program ${PROGRAM_ID.toBase58()} failed: custom program error: 0x${hex}`]), outboxBusy);
  assert.equal(horizonErrorCode([]), null);
  assert.equal(horizonErrorCode(["Program log: insufficient funds"]), null);
});

test("a custom code from another program is not read as a HorizonError", () => {
  // A failing compute-budget instruction.
  const budget = "ComputeBudget111111111111111111111111111111";
  assert.equal(horizonErrorCode([`Program ${budget} invoke [1]`, `Program ${budget} failed: custom program error: 0x1770`]), null);
  // A CPI from this program failed in the system program: the innermost failure is not ours.
  const system = SystemProgram.programId.toBase58();
  const logs = [
    `Program ${PROGRAM_ID.toBase58()} invoke [1]`,
    `Program ${system} invoke [2]`,
    `Program ${system} failed: custom program error: 0x1`,
    `Program ${PROGRAM_ID.toBase58()} failed: custom program error: 0x1`,
  ];
  assert.equal(horizonErrorCode(logs), null);
});

