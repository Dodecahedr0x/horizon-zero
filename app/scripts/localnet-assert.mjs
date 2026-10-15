/**
 * `pnpm localnet --check`: plays one battle on the local stack (scripts/local-stack.mjs) through the
 * rollup and cashes out, asserting every balance on the way.
 *
 *  1. Two wallets register on Solana, delegating their Player and Outbox in the same transaction.
 *  2. Each tops its Player up with 0.05 SOL (lamportsDelegatedTransferIx) and funds a 0.02 SOL budget.
 *     On Solana the top-up sits in an eSPL lamports PDA until the rollup commits it down; the
 *     delegation program then moves it to the validator's fees vault, which is checked.
 *  3. Each creates a behavior and an army on Outpost in the rollup; both lock; the rollup's VRF oracle
 *     seeds the battle; settle_match pays the winner and the fee (or releases both stakes on a draw).
 *  4. The winner withdraws 0.01 SOL (fund_outbox + withdraw); the post-undelegate action pays it on Solana.
 *     The same bundle commits the Player: its Solana copy becomes the rollup's balance. The
 *     validator identity pays exactly its base fees plus what the commits raised on Solana (the
 *     Player's raise and the Outbox's amount), money its fees vault took in from the top-ups.
 *  5. The admin claims the fee (fund_treasury_outbox + claim_fees) and receives it on Solana, with
 *     Config committed and the identity checked the same way.
 *  At the end the validator (identity + fees vault) must not be out of pocket beyond its base fees.
 *  BOOKS lines print the Solana lamports of every account involved after each step.
 *  6. Both Outboxes are delegated again, and the indexer (when INDEXER_URL is set) shows the settled battle.
 *
 * FEE lines record what each step cost the wallet. With `--probe` (off by default, about 40 s
 * longer) the script also checks and prints, as PROBE lines, what the rollup's RPC answers: blockhash
 * validity, the WebSocket subscriptions, getProgramAccounts, getMultipleAccounts, getTransaction,
 * getBlockTime and the account shapes. docs/plans/2026-10-14-outbox-spike-result.md keeps that evidence.
 *
 *   node app/scripts/localnet-assert.mjs [--probe]     (pnpm localnet --check runs it; pass --probe there too)
 *
 * cancel_match is not played here: it needs a battle left unseeded for CANCEL_AFTER_SECS (600 s) of
 * rollup clock, which this check cannot shorten. The LiteSVM suite covers it with a warped clock.
 *
 * Env: RPC_URL (Solana), ER_RPC_URL (rollup), ORACLE_QUEUE, ADMIN_KEYPAIR (the bootstrap admin), INDEXER_URL.
 */
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { deriveLamportsPda, deriveRentPda, lamportsDelegatedTransferIx, validatorFeesVaultPdaFromValidator } from "@magicblock-labs/ephemeral-rollups-sdk";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SendTransactionError, Transaction } from "@solana/web3.js";
import {
  BATTLEGROUNDS,
  DELEGATION_PROGRAM_ID,
  EPHEMERAL_TEST_QUEUE,
  PROGRAM_ID,
  RACES,
  STANDARDS,
  armyPda,
  battlegroundPda,
  behaviorPda,
  claimFeesIx,
  closeArmyIx,
  computeBudgetIx,
  configPda,
  createArmyIx,
  createBehaviorIx,
  decodeBattle,
  decodeBattleground,
  decodeConfig,
  decodeOutbox,
  decodePlayer,
  encodeBehavior,
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
  resolvedMatch,
  settleMatchIx,
  treasuryOutboxPda,
  withdrawIx,
} from "../src/codec.ts";
import { readKeypair } from "./bootstrap.mjs";

const require = createRequire(import.meta.url);
const { simulate_json } = require("../src/combat-node/horizon_combat.js");

const base = new Connection(process.env.RPC_URL || "http://127.0.0.1:8899", "confirmed");
const er = new Connection(process.env.ER_RPC_URL || "http://127.0.0.1:7799", "confirmed");
const queue = new PublicKey(process.env.ORACLE_QUEUE || EPHEMERAL_TEST_QUEUE.toBase58());
const admin = readKeypair(process.env.ADMIN_KEYPAIR || "target/localnet/admin.json");
const indexerUrl = process.env.INDEXER_URL || "";

const SOL = BigInt(LAMPORTS_PER_SOL);
const TOP_UP = SOL / 20n; // 0.05 SOL
const BUDGET = SOL / 50n; // 0.02 SOL
const WITHDRAW = SOL / 100n; // 0.01 SOL
const OUTPOST = BATTLEGROUNDS.find((ground) => ground.id === 0);
const STAKE = BigInt(OUTPOST.stake);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sol = (lamports) => `${(Number(lamports) / LAMPORTS_PER_SOL).toFixed(9)} SOL`;
const say = (...parts) => console.log("[check]", ...parts);
const probing = process.argv.includes("--probe");
const probe = (...parts) => probing && console.log("PROBE", ...parts);
const fee = (...parts) => console.log("FEE", ...parts);

function check(condition, message) {
  if (!condition) throw new Error(`check failed: ${message}`);
}

async function until(label, seconds, read) {
  for (const end = Date.now() + seconds * 1000; ;) {
    const value = await read().catch(() => null);
    if (value !== null && value !== undefined && value !== false) return value;
    if (Date.now() >= end) throw new Error(`${label}: nothing after ${seconds}s`);
    await sleep(500);
  }
}

// What the rollup said about blockhash validity while a transaction was not found yet. The client's
// confirm() declares a transaction expired after two such "invalid" polls, so a false here for a
// fresh blockhash would be a bug.
const blockhashChecks = { base: { valid: 0, invalid: 0 }, er: { valid: 0, invalid: 0 } };

/**
 * Sends and confirms the way the app's confirm() does: polls isBlockhashValid and
 * getSignatureStatuses with searchTransactionHistory. Returns the signature and its logs.
 */
async function send(connection, label, signers, ...instructions) {
  const which = connection === er ? "er" : "base";
  const { blockhash } = await connection.getLatestBlockhash();
  const tx = new Transaction({ feePayer: signers[0].publicKey, recentBlockhash: blockhash }).add(...instructions);
  tx.sign(...signers);
  let signature;
  try {
    signature = await connection.sendRawTransaction(tx.serialize());
  } catch (err) {
    const logs = err instanceof SendTransactionError ? await err.getLogs(connection).catch(() => err.logs) : err.logs;
    for (const line of logs ?? []) console.log(`    ${line}`);
    throw new Error(`${label} (${which}) was refused: ${err.message}`);
  }
  const status = await until(`${label} confirmation`, 60, async () => {
    const valid = (await connection.isBlockhashValid(blockhash)).value;
    const found = (await connection.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0];
    if (!found) blockhashChecks[which][valid ? "valid" : "invalid"] += 1;
    if (found && (found.err || found.confirmationStatus === "confirmed" || found.confirmationStatus === "finalized")) return found;
    return null;
  });
  const info = await until(`${label} getTransaction`, 20, () =>
    connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }));
  const logs = info.meta?.logMessages ?? [];
  if (status.err) {
    for (const line of logs) console.log(`    ${line}`);
    throw new Error(`${label} (${which}) failed: ${JSON.stringify(status.err)} ${signature}`);
  }
  say(`${label} (${which}) ${signature} fee ${info.meta?.fee}`);
  return { signature, logs, info };
}

async function balance(key) {
  return BigInt(await base.getBalance(key, "confirmed"));
}

async function erPlayer(owner) {
  const info = await er.getAccountInfo(playerPda(owner));
  check(info && info.owner.equals(PROGRAM_ID), `the rollup holds ${owner.toBase58()}'s Player`);
  return { lamports: BigInt(info.lamports), ...decodePlayer(info.data) };
}

/**
 * Base fees `payer` paid in transactions after `slot`, read from its signatures. The identity sends
 * the commits, undelegations and post-undelegate actions, so this is what it may lose to them.
 */
async function feesPaidSince(payer, slot) {
  let total = 0n;
  let count = 0;
  for (const { signature, slot: at } of await base.getSignaturesForAddress(payer, { limit: 200 }, "confirmed")) {
    if (at <= slot) continue;
    const tx = await base.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    if (!tx?.meta || !tx.transaction.message.staticAccountKeys[0].equals(payer)) continue;
    total += BigInt(tx.meta.fee);
    count += 1;
  }
  return { total, count };
}

/**
 * Waits until Solana's copy of a delegated `account` matches the rollup's lamports and data: the
 * commit landed. Returns both copies.
 */
async function awaitCommitted(account, label) {
  return until(`${label}: Solana's copy matches the rollup's`, 60, async () => {
    const [onBase, inEr] = await Promise.all([base.getAccountInfo(account, "confirmed"), er.getAccountInfo(account)]);
    if (!onBase || !inEr || !onBase.owner.equals(DELEGATION_PROGRAM_ID)) return null;
    return onBase.lamports === inEr.lamports && Buffer.compare(onBase.data, inEr.data) === 0 ? { onBase, inEr } : null;
  });
}

/** The rollup identity's and its delegation-program fees vault's Solana balances. */
async function validatorBalance() {
  const [id, vault] = await base.getMultipleAccountsInfo([identity, feesVault], "confirmed");
  return { identity: BigInt(id.lamports), vault: BigInt(vault?.lamports ?? 0) };
}

/**
 * The validator's books across a withdrawal or claim. A top-up's lamports reach Solana in the
 * validator's fees vault (the eSPL lamports PDA is committed down and the delegation program's
 * finalize sends the decrease there). A commit that raises a delegated account's Solana balance is
 * paid by the identity. So across a cash-out the identity pays exactly its base fees plus `raised`:
 * the Player or Config commit's raise plus the Outbox's amount. Nothing else may leave it.
 */
async function cashOutCheck(label, before, slot, raised) {
  // Let the last base transactions of the bundle (finalize, action) land.
  await sleep(3000);
  const after = await validatorBalance();
  const paid = await feesPaidSince(identity, slot);
  const loss = before.identity - after.identity;
  console.log(`VALIDATOR ${label} identity_loss=${loss} base_fees=${paid.total} (${paid.count} txs) committed_raise=${raised} fees_vault_gain=${after.vault - before.vault}`);
  check(loss === paid.total + raised, `${label}: the identity lost ${loss}, not its ${paid.total} of base fees plus the ${raised} its commits raised on Solana`);
  await books(`after ${label}`);
  return { loss, fees: paid.total };
}

/**
 * Lamports on Solana of every account money moves through, printed as one BOOKS line per step with
 * the change since the last step. `validator` is the identity plus its fees vault in the delegation
 * program; `identity_fees` is what the identity paid in base fees since the last step.
 */
const tracked = new Map();
let booksLast = null;
let identityFeesTotal = 0n;
async function books(step) {
  const names = [...tracked.keys()];
  const infos = await base.getMultipleAccountsInfo(names.map((name) => tracked.get(name)), "confirmed");
  const slot = await base.getSlot("confirmed");
  const now = Object.fromEntries(names.map((name, i) => [name, BigInt(infos[i]?.lamports ?? 0)]));
  now.validator = now.identity + now.fees_vault;
  const fees = booksLast ? (await feesPaidSince(identity, booksLast.slot)).total : 0n;
  identityFeesTotal += fees;
  const parts = Object.entries(now).map(([name, value]) => {
    const delta = booksLast ? value - (booksLast.now[name] ?? 0n) : 0n;
    return `${name}=${value}${delta ? `(${delta > 0n ? "+" : ""}${delta})` : ""}`;
  });
  console.log(`BOOKS ${step} | ${parts.join(" ")} | identity_fees=${fees}`);
  booksLast = { slot, now };
  return now;
}

async function inRollup(key) {
  return (await er.getAccountInfo(key))?.owner.equals(PROGRAM_ID) ? true : null;
}

/** Waits for an Outbox to come back to Solana and for its amount to be paid; returns the paying transaction. */
async function awaitRelease(outbox, owner, label) {
  const released = await until(`${label}: Outbox back on Solana and paid`, 60, async () => {
    const info = await base.getAccountInfo(outbox);
    if (!info || !info.owner.equals(PROGRAM_ID)) return null;
    return BigInt(decodeOutbox(info.data).amount) === 0n ? info : null;
  });
  check(decodeOutbox(released.data).owner === owner.toBase58(), `${label}: the Outbox still pays ${owner.toBase58()}`);
  // The base transaction that ran release_outbox: the post-undelegate action, or nobody.
  const signatures = await base.getSignaturesForAddress(outbox, { limit: 10 });
  for (const { signature } of signatures) {
    const tx = await base.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    const logs = tx?.meta?.logMessages ?? [];
    if (!logs.some((line) => line.includes("HZ_RELEASE"))) continue;
    const payer = tx.transaction.message.staticAccountKeys[0].toBase58();
    const undelegated = logs.some((line) => line.includes("Instruction: ProcessUndelegation"));
    probe(`${label}: release_outbox ran in ${signature}, fee payer ${payer}, same tx as ProcessUndelegation: ${undelegated}`);
    for (const line of logs.filter((line) => /HZ_RELEASE|ReleaseOutbox|ProcessUndelegation/.test(line))) console.log(`    ${line}`);
    return { signature, payer, undelegated };
  }
  throw new Error(`${label}: no base transaction logged HZ_RELEASE`);
}

// ---------------------------------------------------------------------------------------------

const identityKey = (await er._rpcRequest("getIdentity", []).catch(() => null))?.result?.identity;
check(identityKey, `the rollup at ${er.rpcEndpoint} returns its identity (getIdentity)`);
const identity = new PublicKey(identityKey);
const feesVault = validatorFeesVaultPdaFromValidator(identity);
const configInfo = await base.getAccountInfo(configPda());
check(configInfo, "Config exists on Solana: run the bootstrap (scripts/local-stack.mjs does)");
const configOnBase = decodeConfig(configInfo.data);
check(configOnBase, "the account at the Config address is a Config");
check(configOnBase.validator === identity.toBase58(), "Config pins the rollup's identity");
check(configOnBase.admin === admin.publicKey.toBase58(), "ADMIN_KEYPAIR is Config's admin");
say(`rollup identity ${identity.toBase58()}, admin ${admin.publicKey.toBase58()}`);
tracked.set("identity", identity);
tracked.set("fees_vault", feesVault);
tracked.set("espl_rent", deriveRentPda()[0]);
tracked.set("config", configPda());
tracked.set("treasury", treasuryOutboxPda());

// Subscriptions the indexer depends on, opened before anything happens in the rollup.
const notified = { logs: 0, program: 0 };
const logsSub = probing ? er.onLogs(PROGRAM_ID, () => (notified.logs += 1), "confirmed") : null;
const programSub = probing ? er.onProgramAccountChange(PROGRAM_ID, () => (notified.program += 1), "confirmed") : null;

// The app's confirm() treats a blockhash the RPC calls invalid as a sign of expiry.
for (const [name, connection] of probing ? [["base", base], ["rollup", er]] : []) {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  const now = (await connection.isBlockhashValid(blockhash)).value;
  await sleep(10_000);
  const later = (await connection.isBlockhashValid(blockhash)).value;
  const height = await connection.getBlockHeight();
  probe(`isBlockhashValid on the ${name} for a fresh blockhash: ${now}, 10 s later ${later} (height ${height}, last valid ${lastValidBlockHeight})`);
  check(now && later, `the ${name} calls a fresh blockhash valid`);
}

const wallets = [Keypair.generate(), Keypair.generate()];
for (const wallet of wallets) {
  await base.confirmTransaction(await base.requestAirdrop(wallet.publicKey, 2 * LAMPORTS_PER_SOL), "confirmed");
}
const [first, second] = wallets;
for (const [i, wallet] of wallets.entries()) {
  tracked.set(`player${i}`, playerPda(wallet.publicKey));
  tracked.set(`outbox${i}`, outboxPda(wallet.publicKey));
}
const startBooks = await books("start");

// 1. Register: Player + Outbox created and delegated in one Solana transaction, as the app does.
for (const wallet of wallets) {
  const owner = wallet.publicKey;
  const before = await balance(owner);
  const { info } = await send(base, "register", [wallet], registerPlayerIx(owner, 0n), delegatePlayerIx(owner), delegateOutboxIx(owner));
  fee(`register wallet_delta=${before - (await balance(owner))} tx_fee=${info.meta.fee} (Player and Outbox rent, delegation record and metadata rent for both)`);
  await until("the rollup picks up the Player", 60, () => inRollup(playerPda(owner)));
  await until("the rollup picks up the Outbox", 60, () => inRollup(outboxPda(owner)));
  await books(`register ${owner.toBase58().slice(0, 6)}`);
}
say("both Players and Outboxes are live in the rollup");

// 2. Top up 0.05 SOL each through the eSPL program, then fund a 0.02 SOL budget.
for (const [i, wallet] of wallets.entries()) {
  const owner = wallet.publicKey;
  const playerBefore = (await erPlayer(owner)).lamports;
  const walletBefore = await balance(owner);
  const salt = randomBytes(32);
  tracked.set(`espl${i}`, deriveLamportsPda(owner, playerPda(owner), salt)[0]);
  const { info } = await send(base, "top-up", [wallet], lamportsDelegatedTransferIx(owner, playerPda(owner), TOP_UP, salt));
  await books(`top-up ${i} sent`);
  const walletDelta = walletBefore - (await balance(owner));
  fee(`top-up wallet_delta=${walletDelta} amount=${TOP_UP} overhead=${walletDelta - TOP_UP} tx_fee=${info.meta.fee}`);
  const credited = await until("the rollup credits the top-up", 60, async () => {
    const now = (await erPlayer(owner)).lamports;
    return now > playerBefore ? now : null;
  });
  check(credited - playerBefore === TOP_UP, `top-up credited ${credited - playerBefore}, expected ${TOP_UP}`);
  await books(`top-up ${i} credited in the rollup`);
  await send(er, "fund_budget", [wallet], fundBudgetIx(owner, BUDGET));
  check(BigInt((await erPlayer(owner)).budget) === BUDGET, "budget is 0.02 SOL");
}
say(`both Players hold ${sol(TOP_UP)} more in the rollup, ${sol(BUDGET)} of it as budget`);
// The rollup commits the drained eSPL lamports PDAs back to Solana on its own schedule; finalize
// sends their decrease, the top-ups, to the validator's fees vault.
{
  const vaultBefore = (await validatorBalance()).vault;
  await until("the eSPL lamports PDAs settle on Solana", 120, async () => {
    const infos = await base.getMultipleAccountsInfo([tracked.get("espl0"), tracked.get("espl1")], "confirmed");
    return infos.every((info) => !info || info.lamports === 0) ? true : null;
  });
  const settled = await books("eSPL PDAs settled");
  check(settled.fees_vault - vaultBefore >= 2n * TOP_UP, `the fees vault received the top-ups: +${settled.fees_vault - vaultBefore}, at least ${2n * TOP_UP}`);
  say(`the top-ups are in the validator's fees vault on Solana (+${settled.fees_vault - vaultBefore})`);
}

// 3. A behavior and an army each, then the battle.
const race = RACES[0];
const kinds = [...race.units].sort((a, b) => b.cost - a.cost);
function armyUnits(behavior) {
  const units = [];
  let left = OUTPOST.budget;
  for (const unit of kinds) {
    while (unit.cost <= left && units.length < 10) {
      units.push({ kind: unit.id, behavior, col: units.length % OUTPOST.cols, row: Math.floor(units.length / OUTPOST.cols) });
      left -= unit.cost;
    }
  }
  return units;
}
const armies = [];
for (const [i, wallet] of wallets.entries()) {
  const owner = wallet.publicKey;
  const standard = STANDARDS[i];
  const behavior = behaviorPda(encodeBehavior(standard.elements));
  if (!(await er.getAccountInfo(behavior))?.data.length) {
    await send(er, `create_behavior ${standard.name}`, [wallet], createBehaviorIx(owner, standard.elements));
  }
  const ephemeral = await er.getAccountInfo(behavior);
  probe(`behavior ${behavior.toBase58()} owner=${ephemeral.owner.toBase58()} lamports=${ephemeral.lamports} len=${ephemeral.data.length}`);
  await send(er, "create_army", [wallet], createArmyIx(owner, OUTPOST.id, 0, race.id, armyUnits(behavior)));
  armies.push({ owner, army: armyPda(owner, 0), behavior });
}

const ground = battlegroundPda(OUTPOST.id);
const groundState = async () => decodeBattleground((await er.getAccountInfo(ground)).data);
const beforeLock = await Promise.all(wallets.map((wallet) => erPlayer(wallet.publicKey)));
const lock = (index, candidates, seq) =>
  lockArmyIx({ player: armies[index].owner, battlegroundId: OUTPOST.id, army: armies[index].army, behaviors: [armies[index].behavior], queue, seq, candidates, opens: candidates.length > 0 });
let seq = (await groundState()).matchSeq;
await send(er, "lock_army (queues)", [first], computeBudgetIx(), lock(0, [], seq));
check((await groundState()).queue.includes(armies[0].army.toBase58()), "the first army is queued");
seq = (await groundState()).matchSeq;
const { logs: lockLogs } = await send(er, "lock_army (matches)", [second], computeBudgetIx(), lock(1, [{ army: armies[0].army, owner: first.publicKey }], seq));
check(lockLogs.some((line) => line.includes("HZ_MATCH_OPEN")), "lock_army opened a match");
const battle = matchPda(ground, seq);
const opened = await er.getAccountInfo(battle);
probe(`battle ${battle.toBase58()} owner=${opened.owner.toBase58()} lamports=${opened.lamports} len=${opened.data.length}`);
const battleRent = beforeLock[1].lamports - (await erPlayer(second.publicKey)).lamports;
probe(`lock_army took ${battleRent} lamports of battle rent from the locker's Player`);

const seeded = await until("the VRF oracle seeds the battle", 60, async () => {
  const info = await er.getAccountInfo(battle);
  const state = info ? decodeBattle(battle, info.data) : null;
  return state?.status === 2 ? state : null;
});
say(`seeded ${seeded.seed}`);
const nowUnix = Math.floor(Date.now() / 1000);
check(seeded.openedAt > 0 && Math.abs(seeded.openedAt - nowUnix) < 600, `the battle records when it opened (opened_at ${seeded.openedAt}, now ${nowUnix})`);

// Replay the battle off-chain to know the winner before the program says it.
const strip = ({ race: _race, ...unit }) => unit;
const replay = JSON.parse(simulate_json(JSON.stringify({
  cols: seeded.cols,
  rows: seeded.rows,
  a: seeded.unitsA.map(strip),
  b: seeded.unitsB.map(strip),
  seed: [...Buffer.from(seeded.seed, "hex")],
})));
const expected = replay.winner === 0 ? 1 : replay.winner === 1 ? 2 : 3;

const configBefore = await er.getAccountInfo(configPda());
const { signature: settleSignature, logs: settleLogs } = await send(er, "settle_match", [second], computeBudgetIx(), settleMatchIx(seeded));
const resolved = resolvedMatch(settleLogs, battle.toBase58());
check(resolved, "settle_match logged HZ_MATCH_RESOLVED for the battle");
const { outcome, fee: fees } = resolved;
check(outcome === expected, `outcome ${outcome}, replay says ${expected}`);
const afterClose = await er.getAccountInfo(battle);
check(afterClose === null || afterClose.data.length === 0, "settle_match closed the battle");
const afterSettle = await Promise.all(wallets.map((wallet) => erPlayer(wallet.publicKey)));
const configAfter = await er.getAccountInfo(configPda());
const configFees = BigInt(decodeConfig(configAfter.data).fees);
say(`outcome ${outcome} (1 A wins, 2 B wins, 3 draw), fee ${fees}`);

// Relative to before the lock: the locker (B) got its battle rent back at the close.
for (const [i, player] of afterSettle.entries()) {
  check(BigInt(player.locked) === 0n && player.fighting === 0, `Player ${i} has nothing locked or fighting`);
}
if (outcome === 3) {
  check(fees === 0n, "a draw charges no fee");
  for (const [i, player] of afterSettle.entries()) {
    check(player.lamports === beforeLock[i].lamports, `draw: Player ${i} lamports unchanged`);
    check(BigInt(player.budget) === BUDGET, `draw: Player ${i} budget back to ${BUDGET}`);
  }
} else {
  const winner = outcome === 1 ? 0 : 1;
  const loser = 1 - winner;
  const expectedFee = (2n * STAKE * BigInt(seeded.feeBps)) / 10_000n;
  check(fees === expectedFee, `fee ${fees}, expected ${expectedFee}`);
  check(afterSettle[winner].lamports - beforeLock[winner].lamports === STAKE - fees, "the winner's Player gained stake - fee");
  check(beforeLock[loser].lamports - afterSettle[loser].lamports === STAKE, "the loser's Player lost the stake");
  check(BigInt(afterSettle[winner].budget) === BUDGET + STAKE - fees, "the winner's budget grew by stake - fee");
  check(BigInt(afterSettle[loser].budget) === BUDGET - STAKE, "the loser's budget lost the stake");
  check(BigInt(configAfter.lamports) - BigInt(configBefore.lamports) === fees, "Config holds the fee in lamports");
}
check(configFees >= fees, "config.fees counts the fee");
say(`settled; config.fees ${configFees}`);
await books("settle");

// close_army: the Player signs as sponsor by its seeds, and gets the army's rent back.
{
  const owner = first.publicKey;
  const before = (await erPlayer(owner)).lamports;
  await send(er, "close_army", [first], closeArmyIx(owner, armies[0].army));
  const closed = await er.getAccountInfo(armies[0].army);
  check(!closed || closed.data.length === 0, "close_army closed the army");
  const refund = (await erPlayer(owner)).lamports - before;
  probe(`close_army refunded ${refund} lamports to the Player; army now ${closed ? `${closed.owner.toBase58()}/${closed.data.length}` : "missing"}`);
  check(refund > 0n, "close_army refunded the army's rent");
}

// RPC calls the indexer depends on, against the rollup.
if (probing) {
const programAccounts = await er.getProgramAccounts(PROGRAM_ID);
const sizes = {};
for (const { account } of programAccounts) sizes[account.data.length] = (sizes[account.data.length] ?? 0) + 1;
probe(`getProgramAccounts on the rollup: ${programAccounts.length} accounts by size ${JSON.stringify(sizes)}`);
check(programAccounts.some(({ pubkey }) => pubkey.equals(armies[1].army)), "getProgramAccounts lists an ephemeral army");
check(programAccounts.some(({ pubkey }) => pubkey.equals(playerPda(first.publicKey))), "getProgramAccounts lists a delegated Player");
const multiple = await er.getMultipleAccountsInfo([armies[1].army, playerPda(first.publicKey), ground, battle]);
probe(`getMultipleAccounts on the rollup: ${multiple.map((info) => (info ? `${info.owner.toBase58().slice(0, 6)}…/${info.data.length}` : "null")).join(", ")}`);
const settleTx = await er.getTransaction(settleSignature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
probe(`getTransaction on the rollup: logMessages ${settleTx?.meta?.logMessages?.length ?? "missing"}, slot ${settleTx?.slot}`);
{
  // How long after a transaction lands the rollup can name its slot's time.
  const asked = Date.now();
  const first = await er.getBlockTime(settleTx.slot).catch((err) => `error ${err.message}`);
  let answered = null;
  while (answered === null && Date.now() - asked < 20_000) {
    answered = await er.getBlockTime(settleTx.slot).catch(() => null);
    if (answered === null) await sleep(100);
  }
  probe(`getBlockTime(${settleTx.slot}) on the rollup: first ${first}; ${answered} after ${Date.now() - asked} ms`);
}
await sleep(5000);
const later = (await er.getSignatureStatuses([settleSignature], { searchTransactionHistory: true })).value[0];
probe(`getSignatureStatuses(searchTransactionHistory) 5s later on the rollup: ${JSON.stringify(later)}`);
probe(`getBlockTime(${settleTx.slot}) 5s later on the rollup: ${await er.getBlockTime(settleTx.slot).catch((err) => `error ${err.message}`)}`);
const recent = await er.getSlot("confirmed");
probe(`getBlockTime(${recent}) (current slot) on the rollup: ${await er.getBlockTime(recent).catch((err) => `error ${err.message}`)}`);
probe(`logsSubscribe notifications ${notified.logs}, programSubscribe notifications ${notified.program}`);
check(notified.logs > 0 && notified.program > 0, "the rollup's WebSocket sends logs and program notifications");
}

// 4. The winner (or the first wallet on a draw) withdraws 0.01 SOL.
const cashing = outcome === 2 ? second : first;
{
  const owner = cashing.publicKey;
  const outbox = outboxPda(owner);
  const walletBefore = await balance(owner);
  const playerBefore = (await erPlayer(owner)).lamports;
  const playerOnBaseBefore = BigInt((await base.getAccountInfo(playerPda(owner), "confirmed")).lamports);
  await books("before withdraw");
  const validatorBefore = await validatorBalance();
  const slotBefore = await base.getSlot("confirmed");
  await send(er, "fund_outbox + withdraw", [cashing], fundOutboxIx(owner, WITHDRAW), withdrawIx(owner));
  const release = await awaitRelease(outbox, owner, "withdraw");
  // The Player was committed in the same bundle: Solana's copy holds the rollup's lower balance.
  const { onBase: playerOnBase } = await awaitCommitted(playerPda(owner), "withdraw");
  const committed = decodePlayer(playerOnBase.data);
  const live = await erPlayer(owner);
  check(BigInt(playerOnBase.lamports) === live.lamports && committed.budget === live.budget && committed.winnings === live.winnings,
    "the Player's Solana copy carries the committed balance");
  console.log(`COMMIT withdraw player_on_solana before=${playerOnBaseBefore} after=${playerOnBase.lamports} rollup=${live.lamports}`);
  const raised = BigInt(playerOnBase.lamports) - playerOnBaseBefore + WITHDRAW;
  const identityLoss = await cashOutCheck("withdraw", validatorBefore, slotBefore, raised);
  say(`withdraw: identity paid ${identityLoss.loss} = ${identityLoss.fees} of base fees + ${raised} committed; the Player on Solana is ${playerOnBase.lamports}`);
  check(release.payer === identity.toBase58() && release.undelegated, "the post-undelegate action ran release_outbox with the undelegation");
  const walletDelta = (await balance(owner)) - walletBefore;
  fee(`withdraw wallet_delta=+${walletDelta} amount=${WITHDRAW} beyond_amount=${walletDelta - WITHDRAW} (delegation record and metadata rent refund, minus what the rollup charged)`);
  check(walletDelta >= WITHDRAW, `the wallet rose by ${walletDelta}, at least ${WITHDRAW}`);
  check(playerBefore - (await erPlayer(owner)).lamports === WITHDRAW, "the Player paid exactly the withdrawal in the rollup");
  say(`withdrew ${sol(WITHDRAW)} to ${owner.toBase58()}`);
}

// 5. The admin claims the fee.
if (configFees > 0n) {
  const treasury = treasuryOutboxPda();
  const adminBefore = await balance(admin.publicKey);
  const configOnBaseBefore = BigInt((await base.getAccountInfo(configPda(), "confirmed")).lamports);
  await books("before claim");
  const validatorBefore = await validatorBalance();
  const slotBefore = await base.getSlot("confirmed");
  await send(er, "fund_treasury_outbox + claim_fees", [admin], fundTreasuryOutboxIx(admin.publicKey), claimFeesIx(admin.publicKey));
  const release = await awaitRelease(treasury, admin.publicKey, "claim");
  // Config was committed in the same bundle: Solana's copy shows the fees gone.
  const { onBase: configOnBase, inEr: configInEr } = await awaitCommitted(configPda(), "claim");
  check(decodeConfig(configOnBase.data).fees === "0" && configOnBase.lamports === configInEr.lamports, "Config's Solana copy carries the committed claim");
  console.log(`COMMIT claim config_on_solana before=${configOnBaseBefore} after=${configOnBase.lamports} rollup=${configInEr.lamports}`);
  const raised = BigInt(configOnBase.lamports) - configOnBaseBefore + configFees;
  const identityLoss = await cashOutCheck("claim", validatorBefore, slotBefore, raised);
  say(`claim: identity paid ${identityLoss.loss} = ${identityLoss.fees} of base fees + ${raised} committed; Config on Solana is ${configOnBase.lamports}`);
  check(release.payer === identity.toBase58() && release.undelegated, "the post-undelegate action ran release_outbox for the claim");
  const adminDelta = (await balance(admin.publicKey)) - adminBefore;
  fee(`claim admin_delta=+${adminDelta} fees=${configFees} beyond_fees=${adminDelta - configFees}`);
  check(adminDelta >= configFees, `the admin rose by ${adminDelta}, at least the fees ${configFees}`);
  check(BigInt(decodeConfig((await er.getAccountInfo(configPda())).data).fees) === 0n, "config.fees is 0 after the claim");
  say(`claimed ${sol(configFees)} of fees`);
} else {
  say("draw: no fee to claim");
}

// 6. Delegate both Outboxes again, as the app does before the next withdrawal or claim.
{
  const owner = cashing.publicKey;
  const before = await balance(owner);
  await send(base, "delegate_outbox", [cashing], delegateOutboxIx(owner));
  fee(`delegate_outbox wallet_delta=${before - (await balance(owner))}`);
  await until("the rollup picks up the Outbox again", 60, () => inRollup(outboxPda(owner)));
  if ((await base.getAccountInfo(treasuryOutboxPda())).owner.equals(PROGRAM_ID)) {
    await send(base, "delegate_treasury_outbox", [admin], delegateTreasuryOutboxIx(admin.publicKey));
  }
  check((await base.getAccountInfo(treasuryOutboxPda())).owner.equals(DELEGATION_PROGRAM_ID), "the treasury Outbox is delegated");
  await until("the rollup picks up the treasury Outbox again", 60, () => inRollup(treasuryOutboxPda()));
  say("both Outboxes are delegated again");
}

if (indexerUrl) {
  const row = await until("the indexer has the settled battle", 60, async () => {
    const response = await fetch(`${indexerUrl}/matches/${battle.toBase58()}`);
    if (!response.ok) return null;
    const json = await response.json();
    return json?.status === 1 ? json : null;
  });
  check(row.outcome === outcome, `indexer outcome ${row.outcome}, expected ${outcome}`);
  check(BigInt(row.fee) === fees && row.feeBps === seeded.feeBps, `indexer fee ${row.fee} at ${row.feeBps} bps`);
  check(row.openAt === seeded.openedAt && row.resolvedAt !== null, `the indexer's open time ${row.openAt} is the battle's opened_at ${seeded.openedAt}, and it has a resolve time`);
  const players = await (await fetch(`${indexerUrl}/battlegrounds`)).json();
  probe(`indexer /matches/${battle.toBase58()}: ${JSON.stringify({ ...row, unitsA: undefined, unitsB: undefined })}; /battlegrounds ${players.length} rows`);
}

probe(`blockhash validity while a signature was still unknown: ${JSON.stringify(blockhashChecks)}`);
if (logsSub !== null) await er.removeOnLogsListener(logsSub);
if (programSub !== null) await er.removeProgramAccountChangeListener(programSub);
{
  // Over the whole run the validator (identity + fees vault) took in the top-ups and paid out only
  // what was cashed out, plus its base fees: it is never out of pocket.
  const end = await books("end");
  const net = end.validator - startBooks.validator;
  console.log(`VALIDATOR run net=${net} identity_base_fees=${identityFeesTotal}`);
  check(net + identityFeesTotal >= 0n, `the validator is out of pocket by ${-(net + identityFeesTotal)} beyond its base fees`);
}
say(`passed: outcome ${outcome}, fee ${fees}, battle ${battle.toBase58()}`);
process.exit(0);
