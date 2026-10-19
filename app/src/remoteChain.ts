import { Transaction } from "@solana/web3.js";
import type { WalletContextState } from "@solana/wallet-adapter-react";
import type { ChainAdapter } from "./devChain";

/** One step of a server call (app/chain/http.mjs). */
type Step =
  | { sign: { session: string; tx: string } }
  | { done: unknown }
  | { error: { name: string; message: string; code?: number; errorName?: string; signature?: string; amount?: bigint } };

const encode = (value: unknown) => JSON.stringify(value, (_, v) => (typeof v === "bigint" ? { $bigint: v.toString() } : v));
const decode = (text: string) => JSON.parse(text, (_, v) => (v && typeof v === "object" && typeof v.$bigint === "string" ? BigInt(v.$bigint) : v));

async function post(path: string, body: unknown): Promise<Step> {
  let response: Response;
  try {
    response = await fetch(`/chain${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: encode(body) });
  } catch (err) {
    // The server may already have sent the signed copy: the page cannot tell whether it landed.
    if (path === "/sign" && (body as { tx?: string }).tx) {
      throw Object.assign(new Error("The connection dropped after the wallet signed; the transaction may still land, so check before retrying"), { name: "PendingError" });
    }
    throw err;
  }
  const text = await response.text();
  try {
    return decode(text);
  } catch {
    throw new Error(`chain backend ${response.status}`);
  }
}

/** The server's error, with its name and fields kept: `explain` reads PendingError and RecoveredError by name. */
function rebuild(error: Extract<Step, { error: unknown }>["error"]) {
  return Object.assign(new Error(error.message), error);
}

/**
 * The Solana adapter. The game server reads the chain and builds every transaction (see
 * app/chain/solana.ts); the browser only signs them with the wallet. No RPC URL reaches the page.
 */
export function createRemoteChain(wallet: WalletContextState): ChainAdapter {
  function owner() {
    if (!wallet.publicKey) throw new Error("Connect a wallet");
    return wallet.publicKey.toBase58();
  }

  async function call(method: string, args: unknown[]) {
    let step = await post("/call", { method, owner: wallet.publicKey?.toBase58() ?? null, args });
    for (;;) {
      if ("error" in step) throw rebuild(step.error);
      if (!("sign" in step)) return step.done;
      const { session, tx } = step.sign;
      let signed: string;
      try {
        if (!wallet.signTransaction) throw new Error("This wallet cannot sign transactions");
        const done = await wallet.signTransaction(Transaction.from(Buffer.from(tx, "base64")));
        signed = done.serialize().toString("base64");
      } catch (err) {
        // The server ends the call with this error, so the page reads it as it would have before.
        step = await post("/sign", { session, refused: err instanceof Error && err.message ? err.message : "The wallet did not sign" });
        continue;
      }
      step = await post("/sign", { session, tx: signed });
    }
  }

  const remote = (method: keyof ChainAdapter) => (...args: unknown[]) => call(method, args);
  return {
    async owner() {
      return owner();
    },
    behaviors: remote("behaviors"),
    battlegrounds: remote("battlegrounds"),
    armies: remote("armies"),
    createBehavior: remote("createBehavior"),
    createArmy: remote("createArmy"),
    lock: remote("lock"),
    unlock: remote("unlock"),
    closeArmy: remote("closeArmy"),
    player: remote("player"),
    register: remote("register"),
    topUp: remote("topUp"),
    fundBudget: remote("fundBudget"),
    withdraw: remote("withdraw"),
    releasePending: remote("releasePending"),
    setSegregation: remote("setSegregation"),
    settle: remote("settle"),
    cancel: remote("cancel"),
    admin: remote("admin"),
    claimFees: remote("claimFees"),
    setFee: remote("setFee"),
    matches: remote("matches"),
    match: remote("match"),
  } as ChainAdapter;
}
