/**
 * Brings a cluster where horizon_zero is deployed to a playable state: the config and VRF identity,
 * the three battlegrounds, and the standard behaviors from content/catalog.json.
 * Every step is skipped when its account already exists, so this is safe to run after each deploy.
 *
 *   node app/scripts/bootstrap.mjs --url http://127.0.0.1:8899 --keypair ~/.config/solana/id.json
 *
 * The keypair pays and becomes the admin on the first run. Later runs must use that same admin
 * to add a missing battleground.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { loadCatalog } from "../../content/load.mjs";

export const PROGRAM_ID = new PublicKey("Hm19JfKaKCRphRwF7DbxhJWmLpHgMG1SnEnKGRyN9Z7c");

export const BATTLEGROUNDS = loadCatalog().battlegrounds;

export function sighash(name) {
  return createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

export function pda(seeds) {
  return PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];
}

export function ix(name, keys, rest = Buffer.alloc(0)) {
  return new TransactionInstruction({ programId: PROGRAM_ID, keys, data: Buffer.concat([sighash(name), rest]) });
}

export async function send(connection, payer, instructions) {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  const tx = new Transaction({ feePayer: payer.publicKey, recentBlockhash: blockhash }).add(...instructions);
  tx.sign(payer);
  const signature = await connection.sendRawTransaction(tx.serialize());
  await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
  return signature;
}

export function battlegroundKey(id) {
  return pda([Buffer.from("battleground"), Buffer.from([id])]);
}

export function behaviorKey(body) {
  const hash = createHash("sha256").update(Buffer.from(body)).digest();
  return { key: pda([Buffer.from("behavior"), hash]), hash };
}

export async function bootstrap(connection, admin, { log = console.log } = {}) {
  const exists = async (key) => (await connection.getAccountInfo(key)) !== null;
  const program = await connection.getAccountInfo(PROGRAM_ID);
  if (!program?.executable) throw new Error(`horizon_zero is not deployed at ${PROGRAM_ID.toBase58()} on this cluster`);

  const config = pda([Buffer.from("config")]);
  if (await exists(config)) {
    log("config: already initialized");
  } else {
    await send(connection, admin, [
      ix("initialize", [
        { pubkey: admin.publicKey, isSigner: true, isWritable: true },
        { pubkey: config, isSigner: false, isWritable: true },
        { pubkey: pda([Buffer.from("identity")]), isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ]),
    ]);
    log(`config: initialized, admin ${admin.publicKey.toBase58()}`);
  }

  for (const ground of BATTLEGROUNDS) {
    const key = battlegroundKey(ground.id);
    if (await exists(key)) {
      log(`${ground.name}: already created`);
      continue;
    }
    const args = Buffer.alloc(13);
    args[0] = ground.id;
    args.writeUInt16LE(ground.budget, 1);
    args.writeBigUInt64LE(BigInt(ground.stake), 3);
    args[11] = ground.cols;
    args[12] = ground.rows;
    await send(connection, admin, [
      ix("create_battleground", [
        { pubkey: admin.publicKey, isSigner: true, isWritable: true },
        { pubkey: config, isSigner: false, isWritable: false },
        { pubkey: key, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ], args),
    ]);
    log(`${ground.name}: created (${ground.cols}x${ground.rows}, budget ${ground.budget})`);
  }

  for (const behavior of loadCatalog().behaviors) {
    const { key, hash } = behaviorKey(behavior.body);
    if (await exists(key)) continue;
    const bytes = Buffer.from(behavior.body);
    const len = Buffer.alloc(4);
    len.writeUInt32LE(bytes.length);
    await send(connection, admin, [
      ix("create_behavior", [
        { pubkey: admin.publicKey, isSigner: true, isWritable: true },
        { pubkey: key, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ], Buffer.concat([hash, len, bytes])),
    ]);
    log(`behavior ${behavior.name}: created`);
  }
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
  const admin = readKeypair(flag("--keypair", "~/.config/solana/id.json"));
  await bootstrap(new Connection(url, "confirmed"), admin);
}
