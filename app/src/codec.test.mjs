// Checks the client's instruction builders and decoders against docs/src/accounts.md.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import {
  DELEGATION_PROGRAM_ID,
  EPHEMERAL_VAULT_ID,
  MAGIC_CONTEXT_ID,
  MAGIC_PROGRAM_ID,
  PROGRAM_ID,
  SLOT_HASHES,
  VRF_PROGRAM_ID,
  battlegroundPda,
  claimFeesIx,
  configPda,
  decodeBattle,
  decodeConfig,
  decodeOutbox,
  decodePlayer,
  delegatePlayerIx,
  delegateTreasuryOutboxIx,
  fundOutboxIx,
  fundTreasuryOutboxIx,
  identityPda,
  lockArmyIx,
  matchPda,
  outboxPda,
  playerPda,
  registerPlayerIx,
  releaseOutboxIx,
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

test("fund_outbox then withdraw, and the treasury pair", () => {
  expect(fundOutboxIx(owner, 7n), "fund_outbox", [
    [owner, true, false],
    [playerPda(owner), false, true],
    [outboxPda(owner), false, true],
  ], u64(7));
  expect(withdrawIx(owner), "withdraw", [
    [owner, true, true],
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
    [configPda(), false, false],
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

  const battle = Buffer.alloc(2147);
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
  const decoded = decodeBattle(key(30), battle);
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
});
