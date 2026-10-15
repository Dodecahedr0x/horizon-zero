/**
 * Brings a cluster where horizon_zero is deployed to a playable state on its ephemeral rollup:
 * Config (fee 500 bps, pinned to the rollup's validator), the battlegrounds in content/catalog.json,
 * the treasury Outbox, then the delegation of Config, every battleground and the treasury Outbox.
 * It waits until the rollup returns Config. Every step is skipped when it is already done, so this
 * is safe to run after each deploy.
 *
 *   node app/scripts/bootstrap.mjs --url <solana rpc> --er-url <rollup rpc> --keypair <file>
 *     [--validator <identity>]   default: the rollup's getIdentity
 *     [--fee-bps 500]            used by initialize only
 *     [--espl-rent]              local stack only: create and fund the eSPL rent PDA top-ups need
 *
 * The keypair pays and becomes the admin on the first run, and `initialize` accepts it only if it is
 * the program's upgrade authority: deploy with this keypair (scripts/deploy.mjs and the local stack
 * do). Later runs must use that same admin.
 * Standard behaviors are not created here: behaviors live in the rollup and a Player pays their rent.
 */
import fs from "node:fs";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { initRentPdaIx } from "@magicblock-labs/ephemeral-rollups-sdk";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import {
  BATTLEGROUNDS,
  DELEGATION_PROGRAM_ID,
  PROGRAM_ID,
  battlegroundPda,
  configPda,
  createBattlegroundIx,
  decodeConfig,
  decodeOutbox,
  delegateBattlegroundIx,
  delegateConfigIx,
  delegateTreasuryOutboxIx,
  initTreasuryOutboxIx,
  initializeIx,
  programDataPda,
  treasuryOutboxPda,
} from "../src/codec.ts";

export const FEE_BPS = 500;
// The eSPL program's [b"rent"] PDA funds the temporary account behind each lamportsDelegatedTransferIx
// top-up. MagicBlock runs it on devnet and mainnet; mb-stack ships the program but not the PDA.
const ESPL_PROGRAM_ID = new PublicKey("SPLxh1LVZzEkX99H6rqYizhytLWPZVV296zyYDPagv2");
export const ESPL_RENT_PDA = PublicKey.findProgramAddressSync([Buffer.from("rent")], ESPL_PROGRAM_ID)[0];

export async function send(connection, payer, instructions) {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  const tx = new Transaction({ feePayer: payer.publicKey, recentBlockhash: blockhash }).add(...instructions);
  tx.sign(payer);
  const signature = await connection.sendRawTransaction(tx.serialize());
  const { value } = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
  if (value.err) throw new Error(`${signature} failed: ${JSON.stringify(value.err)}`);
  return signature;
}

/** The identity a rollup signs with: the validator Config pins and every delegation names. */
/**
 * The program's upgrade authority from its ProgramData (UpgradeableLoaderState::ProgramData: tag 3
 * u32, slot u64, then an Option<Pubkey>), or null when it has none or the program is not upgradeable.
 */
export async function upgradeAuthority(base) {
  const info = await base.getAccountInfo(programDataPda());
  if (!info || info.data.length < 45 || info.data.readUInt32LE(0) !== 3 || info.data[12] !== 1) return null;
  return new PublicKey(info.data.subarray(13, 45));
}

export async function rollupIdentity(er) {
  const response = await er._rpcRequest("getIdentity", []);
  if (!response.result?.identity) throw new Error(`the rollup at ${er.rpcEndpoint} did not return its identity`);
  return new PublicKey(response.result.identity);
}

async function waitFor(label, seconds, check) {
  for (const end = Date.now() + seconds * 1000; Date.now() < end;) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${label} after ${seconds}s`);
}

export async function bootstrap(base, er, admin, { validator, feeBps = FEE_BPS, esplRent = false, log = console.log } = {}) {
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 1000) throw new Error(`fee bps must be an integer from 0 to 1000, not ${feeBps}`);
  const program = await base.getAccountInfo(PROGRAM_ID);
  if (!program?.executable) throw new Error(`horizon_zero is not deployed at ${PROGRAM_ID.toBase58()} on this cluster`);
  const owned = async (key) => (await base.getAccountInfo(key))?.owner.equals(PROGRAM_ID) ?? false;

  if (esplRent) {
    if (await base.getAccountInfo(ESPL_RENT_PDA)) {
      log("eSPL rent PDA: already created");
    } else {
      await send(base, admin, [
        initRentPdaIx(admin.publicKey, ESPL_RENT_PDA),
        SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: ESPL_RENT_PDA, lamports: LAMPORTS_PER_SOL }),
      ]);
      log(`eSPL rent PDA: created and funded with 1 SOL (${ESPL_RENT_PDA.toBase58()})`);
    }
  }

  const config = configPda();
  const identity = validator ?? (await rollupIdentity(er));
  const existing = await base.getAccountInfo(config);
  // Every later step is an admin instruction: say so plainly rather than let the program answer NotAdmin.
  let storedAdmin = admin.publicKey.toBase58();
  const asAdmin = (step) => {
    if (storedAdmin !== admin.publicKey.toBase58()) {
      throw new Error(`${step} needs Config's admin ${storedAdmin}; the keypair is ${admin.publicKey.toBase58()}`);
    }
  };
  if (existing) {
    const stored = decodeConfig(existing.data);
    if (!stored) throw new Error(`the account at ${config.toBase58()} is not a Config`);
    storedAdmin = stored.admin;
    log(`config: already initialized, admin ${stored.admin}`);
    if (stored.validator !== identity.toBase58()) {
      throw new Error(`Config pins validator ${stored.validator}, but the rollup is ${identity.toBase58()}`);
    }
  } else {
    // initialize refuses any signer but the upgrade authority (NotUpgradeAuthority): say which key it wants.
    const authority = await upgradeAuthority(base);
    if (!authority) throw new Error(`horizon_zero at ${PROGRAM_ID.toBase58()} is not upgradeable or has no upgrade authority, so nobody can initialize it`);
    if (!authority.equals(admin.publicKey)) {
      throw new Error(`initialize needs the program's upgrade authority ${authority.toBase58()}; the keypair is ${admin.publicKey.toBase58()}`);
    }
    await send(base, admin, [initializeIx(admin.publicKey, feeBps, identity)]);
    log(`config: initialized, admin ${admin.publicKey.toBase58()}, fee ${feeBps} bps, validator ${identity.toBase58()}`);
  }

  for (const ground of BATTLEGROUNDS) {
    if (await base.getAccountInfo(battlegroundPda(ground.id))) {
      log(`${ground.name}: already created`);
      continue;
    }
    asAdmin(`creating ${ground.name}`);
    await send(base, admin, [createBattlegroundIx(admin.publicKey, ground)]);
    log(`${ground.name}: created (${ground.cols}x${ground.rows}, budget ${ground.budget}, stake ${ground.stake})`);
  }

  const treasury = treasuryOutboxPda();
  if (await base.getAccountInfo(treasury)) {
    log("treasury Outbox: already created");
  } else {
    asAdmin("creating the treasury Outbox");
    await send(base, admin, [initTreasuryOutboxIx(admin.publicKey)]);
    log("treasury Outbox: created");
  }

  if (await owned(config)) {
    asAdmin("delegating Config");
    await send(base, admin, [delegateConfigIx(admin.publicKey)]);
    log("config: delegated");
  }
  for (const ground of BATTLEGROUNDS) {
    if (!(await owned(battlegroundPda(ground.id)))) continue;
    asAdmin(`delegating ${ground.name}`);
    await send(base, admin, [delegateBattlegroundIx(admin.publicKey, ground.id)]);
    log(`${ground.name}: delegated`);
  }
  const treasuryInfo = await base.getAccountInfo(treasury);
  if (!treasuryInfo) throw new Error(`the treasury Outbox ${treasury.toBase58()} is missing after its creation`);
  if (treasuryInfo.owner.equals(PROGRAM_ID)) {
    // An unpaid claim must be released first (OutboxBusy); the admin's wallet does that from the app.
    if (BigInt(decodeOutbox(treasuryInfo.data)?.amount ?? "0") === 0n) {
      asAdmin("delegating the treasury Outbox");
      await send(base, admin, [delegateTreasuryOutboxIx(admin.publicKey)]);
      log("treasury Outbox: delegated");
    } else {
      log("treasury Outbox: holds an unreleased claim, not delegated");
    }
  } else if (!treasuryInfo.owner.equals(DELEGATION_PROGRAM_ID)) {
    throw new Error(`treasury Outbox has an unexpected owner ${treasuryInfo.owner.toBase58()}`);
  }

  // The rollup clones a delegated account on first read; ask until Config is there as the program's.
  const inRollup = async (key) => (await er.getAccountInfo(key))?.owner.equals(PROGRAM_ID) ?? false;
  await waitFor("the rollup did not return Config", 60, () => inRollup(config));
  for (const ground of BATTLEGROUNDS) {
    await waitFor(`the rollup did not return ${ground.name}`, 60, () => inRollup(battlegroundPda(ground.id)));
  }
  log(`rollup ${er.rpcEndpoint}: Config and ${BATTLEGROUNDS.length} battlegrounds are live`);
}

export function readKeypair(file) {
  const full = file.replace(/^~(?=$|\/)/, os.homedir());
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(full, "utf8"))));
}

function flag(name, fallback) {
  const args = process.argv.slice(2);
  const at = args.indexOf(name);
  if (at === -1) return fallback;
  const value = args[at + 1];
  if (!value) throw new Error(`${name} needs a value`);
  return value;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const url = flag("--url", process.env.RPC_URL || "http://127.0.0.1:8899");
  const erUrl = flag("--er-url", process.env.ER_RPC_URL || "http://127.0.0.1:7799");
  const admin = readKeypair(flag("--keypair", "~/.config/solana/id.json"));
  const validator = flag("--validator", "");
  await bootstrap(new Connection(url, "confirmed"), new Connection(erUrl, "confirmed"), admin, {
    validator: validator ? new PublicKey(validator) : undefined,
    feeBps: Number(flag("--fee-bps", String(FEE_BPS))),
    esplRent: process.argv.includes("--espl-rent"),
  });
}
