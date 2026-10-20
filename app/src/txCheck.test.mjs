// Checks what the page lets the wallet sign for each server call (app/src/txCheck.ts).
import assert from "node:assert/strict";
import test from "node:test";
import { lamportsDelegatedTransferIx } from "@magicblock-labs/ephemeral-rollups-sdk";
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import {
  computeBudgetIx,
  delegateOutboxIx,
  delegatePlayerIx,
  fundBudgetIx,
  fundOutboxIx,
  playerPda,
  registerPlayerIx,
  setFeeIx,
  setSegregationIx,
  withdrawIx,
} from "./codec.ts";
import { checkSigning, UnexpectedTransactionError } from "./txCheck.ts";

const wallet = Keypair.generate().publicKey;
const stranger = Keypair.generate().publicKey;
const BLOCKHASH = new PublicKey(new Uint8Array(32).fill(7)).toBase58();

function txOf(...instructions) {
  const tx = new Transaction().add(...instructions);
  tx.feePayer = wallet;
  tx.recentBlockhash = BLOCKHASH;
  // As the server sends it: serialized unsigned, then read back by the page.
  return Transaction.from(tx.serialize({ requireAllSignatures: false, verifySignatures: false }));
}

const ok = (tx, method, args) => assert.doesNotThrow(() => checkSigning(tx, wallet, method, args));
const refused = (tx, method, args, why) =>
  assert.throws(() => checkSigning(tx, wallet, method, args), (err) => err instanceof UnexpectedTransactionError && why.test(err.message));

test("the call's own instructions with the page's amounts pass", () => {
  ok(txOf(registerPlayerIx(wallet, 5n), delegatePlayerIx(wallet), delegateOutboxIx(wallet)), "register", [5n]);
  ok(txOf(fundBudgetIx(wallet, 9n)), "fundBudget", [9n]);
  ok(txOf(fundOutboxIx(wallet, 4n), withdrawIx(wallet)), "withdraw", [4n]);
  ok(txOf(setFeeIx(wallet, 250)), "setFee", [250]);
  ok(txOf(setSegregationIx(wallet, true)), "setSegregation", [true]);
  ok(txOf(lamportsDelegatedTransferIx(wallet, playerPda(wallet), 3n, new Uint8Array(32).fill(1))), "topUp", [3n]);
});

test("another amount is refused", () => {
  refused(txOf(registerPlayerIx(wallet, 6n)), "register", [5n], /register_player of another amount/);
  refused(txOf(fundBudgetIx(wallet, 10n)), "fundBudget", [9n], /another amount/);
  refused(txOf(fundOutboxIx(wallet, 5n), withdrawIx(wallet)), "withdraw", [4n], /another amount/);
  refused(txOf(setFeeIx(wallet, 251)), "setFee", [250], /another fee rate/);
  refused(txOf(setSegregationIx(wallet, false)), "setSegregation", [true], /segregation/);
  refused(txOf(lamportsDelegatedTransferIx(wallet, playerPda(wallet), 4n, new Uint8Array(32))), "topUp", [3n], /another amount/);
});

test("an instruction another call would send is refused", () => {
  refused(txOf(fundOutboxIx(wallet, 9n)), "fundBudget", [9n], /instruction fund_outbox/);
  refused(txOf(fundBudgetIx(wallet, 9n)), "topUp", [9n], /instruction fund_budget/);
  refused(txOf(fundBudgetIx(wallet, 9n)), "matches", [], /never signs/);
});

test("another program, payer, signer, or a priority fee is refused", () => {
  refused(txOf(fundBudgetIx(wallet, 9n), SystemProgram.transfer({ fromPubkey: wallet, toPubkey: stranger, lamports: 1 })), "fundBudget", [9n], /program 11111111111111111111111111111111/);
  refused(txOf(computeBudgetIx(), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000_000_000 })), "lock", [], /compute budget/);
  const paid = txOf(fundBudgetIx(wallet, 9n));
  paid.feePayer = stranger;
  refused(paid, "fundBudget", [9n], /fee payer/);
  refused(txOf(fundBudgetIx(stranger, 9n)), "fundBudget", [9n], /another signer/);
  refused(txOf(lamportsDelegatedTransferIx(wallet, playerPda(stranger), 3n, new Uint8Array(32))), "topUp", [3n], /to another account/);
  refused(txOf(lamportsDelegatedTransferIx(wallet, playerPda(wallet), 3n, new Uint8Array(32)), lamportsDelegatedTransferIx(wallet, playerPda(wallet), 3n, new Uint8Array(32).fill(2))), "topUp", [3n], /exactly one/);
  refused(txOf(lamportsDelegatedTransferIx(wallet, playerPda(wallet), 3n, new Uint8Array(32))), "fundBudget", [3n], /program SPLxh/);
});

test("a transaction that already carries a signature is refused", () => {
  const tx = txOf(fundBudgetIx(wallet, 9n));
  tx.signatures[0].signature = Buffer.alloc(64, 1);
  refused(tx, "fundBudget", [9n], /signature already/);
});
