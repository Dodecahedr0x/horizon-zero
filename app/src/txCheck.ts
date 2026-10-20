import { PublicKey, type Transaction, type TransactionInstruction } from "@solana/web3.js";
import { PROGRAM_ID, playerPda, sighash } from "./codec.ts";

// The game server builds every transaction the wallet signs (app/chain/solana.ts). The page checks
// each one before the wallet sees it, so a compromised or buggy server cannot have the wallet sign
// something other than what the player asked for: another program, another fee payer, a priority
// fee, or another amount.

const COMPUTE_BUDGET_ID = new PublicKey("ComputeBudget111111111111111111111111111111");
/** The eSPL program a top-up goes through (`lamportsDelegatedTransferIx`). */
export const EPHEMERAL_SPL_TOKEN_PROGRAM_ID = new PublicKey("SPLxh1LVZzEkX99H6rqYizhytLWPZVV296zyYDPagv2");
/** eSPL's lamports delegated transfer: tag 20, the amount as a u64, then a 32-byte salt. */
const LAMPORTS_DELEGATED_TRANSFER = 20;
/** The account index of the transfer's destination in `lamportsDelegatedTransferIx`. */
const TRANSFER_DESTINATION = 9;
/** ComputeBudget's SetComputeUnitLimit. Any other compute budget instruction, a price above all, is refused. */
const SET_COMPUTE_UNIT_LIMIT = 2;

const OUTBOX_RECOVERY = ["release_outbox", "withdraw", "delegate_outbox"];
const TREASURY_RECOVERY = ["release_outbox", "claim_fees", "delegate_treasury_outbox"];

/** The horizon-zero instructions each server call may ask the wallet to sign. */
const ALLOWED: Record<string, string[]> = {
  createBehavior: ["create_behavior"],
  createArmy: ["create_army"],
  lock: ["lock_army", "settle_match"],
  unlock: ["unlock_army"],
  closeArmy: ["close_army"],
  register: ["register_player", "delegate_player", "delegate_outbox"],
  topUp: [],
  fundBudget: ["fund_budget"],
  withdraw: ["fund_outbox", ...OUTBOX_RECOVERY],
  releasePending: [...OUTBOX_RECOVERY, ...TREASURY_RECOVERY],
  setSegregation: ["set_segregation"],
  settle: ["settle_match"],
  cancel: ["cancel_match"],
  claimFees: ["fund_treasury_outbox", ...TREASURY_RECOVERY],
  setFee: ["set_fee"],
};

const NAMES = [...new Set(Object.values(ALLOWED).flat())];
const BY_DISCRIMINATOR = new Map(NAMES.map((name) => [Buffer.from(sighash(name)).toString("hex"), name]));

export class UnexpectedTransactionError extends Error {
  override readonly name = "UnexpectedTransactionError";
}

function refuse(why: string): never {
  throw new UnexpectedTransactionError(`The game server asked the wallet to sign an unexpected transaction (${why}); nothing was signed`);
}

function u64(data: Buffer, at: number) {
  if (data.length < at + 8) refuse("a short instruction");
  return data.readBigUInt64LE(at);
}

/** The horizon-zero instruction's name, or a refusal when the call may not sign it. */
function horizonName(ix: TransactionInstruction, allowed: string[]) {
  const name = BY_DISCRIMINATOR.get(ix.data.subarray(0, 8).toString("hex"));
  if (!name || !allowed.includes(name)) refuse(`instruction ${name ?? "unknown"}`);
  return name;
}

/** Checks one argument-carrying instruction against the arguments the page passed. */
function checkArguments(name: string, ix: TransactionInstruction, args: unknown[]) {
  const amount = typeof args[0] === "bigint" ? args[0] : null;
  switch (name) {
    case "register_player":
    case "fund_budget":
    case "fund_outbox":
      if (amount === null || u64(ix.data, 8) !== amount) refuse(`${name} of another amount`);
      return;
    case "set_fee":
      if (ix.data.length !== 10 || ix.data.readUInt16LE(8) !== args[0]) refuse("another fee rate");
      return;
    case "set_segregation":
      if (ix.data.length !== 9 || ix.data[8] !== (args[0] ? 1 : 0)) refuse("another segregation setting");
      return;
  }
}

/**
 * Throws `UnexpectedTransactionError` unless `tx` is one the server call `method(...args)` should
 * have the wallet sign: the wallet pays the fee and is the only signer, every instruction is
 * horizon-zero's (one of the call's own), a SetComputeUnitLimit, or for `topUp` one eSPL transfer
 * of exactly the amount into the wallet's own Player, and every amount matches what the page asked for.
 */
export function checkSigning(tx: Transaction, wallet: PublicKey, method: string, args: unknown[]) {
  const allowed = ALLOWED[method];
  if (!allowed) refuse(`a call (${method}) that never signs`);
  if (!tx.feePayer?.equals(wallet)) refuse("another fee payer");
  const message = tx.compileMessage();
  if (message.header.numRequiredSignatures !== 1) refuse("another signer");
  if (tx.signatures.some((entry) => entry.signature !== null)) refuse("a signature already on it");
  let transfers = 0;
  for (const ix of tx.instructions) {
    if (ix.programId.equals(PROGRAM_ID)) {
      checkArguments(horizonName(ix, allowed), ix, args);
    } else if (ix.programId.equals(COMPUTE_BUDGET_ID)) {
      if (ix.data[0] !== SET_COMPUTE_UNIT_LIMIT || ix.data.length !== 5) refuse("a compute budget instruction other than a unit limit");
    } else if (ix.programId.equals(EPHEMERAL_SPL_TOKEN_PROGRAM_ID) && method === "topUp") {
      transfers += 1;
      if (ix.data[0] !== LAMPORTS_DELEGATED_TRANSFER || ix.data.length !== 41) refuse("an eSPL instruction other than a lamports transfer");
      if (u64(ix.data, 1) !== args[0]) refuse("a top-up of another amount");
      if (!ix.keys[0]?.pubkey.equals(wallet)) refuse("a top-up paid by another account");
      if (!ix.keys[TRANSFER_DESTINATION]?.pubkey.equals(playerPda(wallet))) refuse("a top-up to another account");
    } else {
      refuse(`program ${ix.programId.toBase58()}`);
    }
  }
  if (method === "topUp" && transfers !== 1) refuse("a top-up without exactly one transfer");
}
