/**
 * A minimal Hydra cranker for the local stack (scripts/local-stack.mjs), where no MagicBlock
 * cranker runs. It polls every crank owned by the Hydra program and, once a crank is due, sends
 * `SetComputeUnitLimit` (when the crank asks for one), `Trigger`, and the crank's scheduled
 * instructions in one transaction. Devnet and mainnet cranks are run by Hydra's own crankers.
 *
 *   node app/scripts/hydra-cranker.mjs --url <rpc> --keypair <file>
 */
import fs from "node:fs";
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";

export const HYDRA_ID = new PublicKey("Hydra17i1feui9deaxu6d1TzSQMRNHeBRkDR1Awy7zea");
const INSTRUCTIONS_SYSVAR = new PublicKey("Sysvar1nstructions1111111111111111111111111");
const COMPUTE_BUDGET = new PublicKey("ComputeBudget111111111111111111111111111111");
const HEADER = 120;
const POLL_MS = 1000;
// A crank whose transaction fails is retried after this long instead of on every poll.
const RETRY_MS = 10_000;

function flag(name, fallback) {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : fallback;
}

/** The scheduled instructions stored after a crank's header, in instructions-sysvar form. */
export function scheduledInstructions(data) {
  const out = [];
  let at = HEADER;
  while (at < data.length) {
    const count = data.readUInt16LE(at);
    const keys = [];
    for (let index = 0; index < count; index += 1) {
      const meta = at + 2 + index * 33;
      keys.push({ pubkey: new PublicKey(data.subarray(meta + 1, meta + 33)), isSigner: false, isWritable: (data[meta] & 2) !== 0 });
    }
    const programAt = at + 2 + count * 33;
    const len = data.readUInt16LE(programAt + 32);
    out.push(new TransactionInstruction({
      programId: new PublicKey(data.subarray(programAt, programAt + 32)),
      keys,
      data: Buffer.from(data.subarray(programAt + 34, programAt + 34 + len)),
    }));
    at = programAt + 34 + len;
  }
  return out;
}

function crankTransaction(crank, data, cranker) {
  const cuLimit = data.readUInt32LE(115);
  const tx = new Transaction();
  if (cuLimit > 0) {
    const limit = Buffer.alloc(5);
    limit[0] = 2;
    limit.writeUInt32LE(cuLimit, 1);
    tx.add(new TransactionInstruction({ programId: COMPUTE_BUDGET, keys: [], data: limit }));
  }
  tx.add(new TransactionInstruction({
    programId: HYDRA_ID,
    keys: [
      { pubkey: crank, isSigner: false, isWritable: true },
      { pubkey: cranker.publicKey, isSigner: true, isWritable: true },
      { pubkey: INSTRUCTIONS_SYSVAR, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  }));
  tx.add(...scheduledInstructions(data));
  return tx;
}

async function main() {
  const connection = new Connection(flag("--url", "http://127.0.0.1:8899"), "confirmed");
  const cranker = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(flag("--keypair"), "utf8"))));
  const failed = new Map();
  console.log(`hydra-cranker ${cranker.publicKey.toBase58()} watching ${HYDRA_ID.toBase58()}`);
  for (;;) {
    try {
      const slot = await connection.getSlot();
      for (const { pubkey, account } of await connection.getProgramAccounts(HYDRA_ID)) {
        const data = account.data;
        if (data.length <= HEADER) continue;
        const due = data.readBigUInt64LE(64) <= BigInt(slot);
        const remaining = data.readBigUInt64LE(80);
        const key = pubkey.toBase58();
        if (!due || remaining === 0n || Date.now() - (failed.get(key) || 0) < RETRY_MS) continue;
        const tx = crankTransaction(pubkey, data, cranker);
        try {
          const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
          tx.recentBlockhash = blockhash;
          tx.feePayer = cranker.publicKey;
          tx.sign(cranker);
          const signature = await connection.sendRawTransaction(tx.serialize());
          await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
          console.log(`cranked ${key} ${signature}`);
        } catch (err) {
          failed.set(key, Date.now());
          console.error(`crank ${key} failed: ${err.message || err}`);
        }
      }
    } catch (err) {
      console.error(`poll failed: ${err.message || err}`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
