// The game's Solana backend. The browser names a ChainAdapter method; the server reads the chain,
// builds each transaction, and pauses the call while the browser's wallet signs it. The RPC URLs
// live only here.
//
//   POST /chain/call {method, owner, args}      starts a call
//   POST /chain/sign {session, tx | refused}     resumes it with the signed transaction
//
// Both answer with the call's next step: {sign: {session, tx}} (an unsigned base64 transaction for
// the wallet), {done: value}, or {error: {name, message, ...}}. Values cross as JSON with bigints
// as {"$bigint": "123"}.
import crypto from "node:crypto";
import { PublicKey, Transaction } from "@solana/web3.js";
import { EPHEMERAL_TEST_QUEUE } from "../src/codec.ts";
import { connectSolana, createSolanaChain } from "./solana.ts";

// Unset, the backend talks to the local stack (scripts/local-stack.mjs): Solana on 8899 and the
// rollup on 7799, with the ephemeral test queue. A deployment sets all three; app/server.js refuses
// to start on Render or with NODE_ENV=production without them.
const LOCAL_RPC = "http://127.0.0.1:8899";
const LOCAL_ER_RPC = "http://127.0.0.1:7799";
// How long a call waits for the wallet to sign before it gives up.
const SIGN_WAIT_MS = 120_000;
const BODY_LIMIT = 64 * 1024;
// Calls running or waiting for a wallet at once. Each costs RPC requests and holds memory up to
// SIGN_WAIT_MS, so past this the server answers 503 instead of starting another.
const MAX_SESSIONS = 256;
// Calls one client address may hold at once, so one client cannot fill MAX_SESSIONS for everyone.
const MAX_SESSIONS_PER_CLIENT = 8;

const METHODS = new Set([
  "behaviors", "battlegrounds", "armies", "createBehavior", "createArmy", "lock", "unlock", "closeArmy",
  "player", "register", "topUp", "fundBudget", "withdraw", "releasePending", "setSegregation", "settle",
  "cancel", "admin", "claimFees", "setFee", "matches", "match",
]);

function withHttp(url) {
  return /^https?:\/\//.test(url) ? url : `http://${url}`;
}

let net = null;
function solana() {
  net ??= connectSolana({
    rpcUrl: process.env.RPC_URL || LOCAL_RPC,
    // The rollup must be the one serving the validator the program was built for. Its WebSocket is the next port.
    erRpcUrl: process.env.ER_RPC_URL || LOCAL_ER_RPC,
    // lock_army runs in the rollup, so the VRF queue is an ephemeral one.
    oracleQueue: new PublicKey(process.env.ORACLE_QUEUE || EPHEMERAL_TEST_QUEUE.toBase58()),
    indexerUrl: withHttp(process.env.INDEXER_URL || "http://127.0.0.1:4714"),
  });
  return net;
}

export const REQUIRED_ENV = ["RPC_URL", "ER_RPC_URL", "ORACLE_QUEUE"];

export const encode = (value) => JSON.stringify(value ?? null, (_, v) => (typeof v === "bigint" ? { $bigint: v.toString() } : v));
export const decode = (text) => JSON.parse(text, (_, v) => (v && typeof v === "object" && typeof v.$bigint === "string" ? BigInt(v.$bigint) : v));

function wireError(err) {
  const { name = "Error", message = String(err), code, errorName, signature, amount } = err ?? {};
  return { name, message, code, errorName, signature, amount };
}

/**
 * A call in progress, acting for `owner`. `events` holds steps the browser has not fetched; `waiter` is the request
 * waiting for the next one; `signed` resolves the transaction the call is waiting on.
 */
const sessions = new Map();

function emit(session, event) {
  if (session.waiter) {
    const resolve = session.waiter;
    session.waiter = null;
    resolve(event);
  } else {
    session.events.push(event);
  }
  if (!event.sign) sessions.delete(session.id);
}

function next(session) {
  if (session.events.length) return Promise.resolve(session.events.shift());
  return new Promise((resolve) => {
    session.waiter = resolve;
  });
}

/**
 * The caller's address. Behind Render's proxy the last X-Forwarded-For entry is the one the proxy
 * added; earlier entries come from the client and prove nothing.
 */
function clientOf(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",").map((part) => part.trim()).filter(Boolean);
  return forwarded.at(-1) || req.socket.remoteAddress || "";
}

function start(method, owner, args, client) {
  const session = { id: crypto.randomUUID(), owner, client, events: [], waiter: null, signed: null };
  sessions.set(session.id, session);
  const signer = {
    owner,
    sign(tx) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          session.signed = null;
          reject(new Error("The wallet did not sign in time; nothing was sent"));
        }, SIGN_WAIT_MS);
        session.signed = { tx, resolve, reject, timer };
        emit(session, { sign: { session: session.id, tx: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64") } });
      });
    },
  };
  const chain = createSolanaChain(signer, solana());
  Promise.resolve()
    .then(() => chain[method](...args))
    // JSON drops an undefined property, so a method that returns nothing still answers {done: null}.
    .then((value) => emit(session, { done: value ?? null }), (err) => emit(session, { error: wireError(err) }));
  return session;
}

function sameInstruction(a, b) {
  return (
    a.programId.equals(b.programId) &&
    a.data.equals(b.data) &&
    a.keys.length === b.keys.length &&
    a.keys.every((key, i) => key.pubkey.equals(b.keys[i].pubkey))
  );
}

/**
 * Checks the browser's copy: signed by the call's wallet, with the server's blockhash, and carrying the
 * server's instructions in order. A wallet may add its own (a compute-budget or guard instruction).
 */
function accept(pending, owner, base64) {
  const signed = Transaction.from(Buffer.from(base64, "base64"));
  if (!signed.feePayer?.equals(owner)) throw new Error("The signed transaction has another fee payer");
  let at = 0;
  for (const ix of signed.instructions) if (at < pending.tx.instructions.length && sameInstruction(ix, pending.tx.instructions[at])) at += 1;
  if (signed.recentBlockhash !== pending.tx.recentBlockhash || at < pending.tx.instructions.length) {
    throw new Error("The signed transaction is not the one the server built");
  }
  if (!signed.verifySignatures()) throw new Error("The transaction is not signed by the wallet");
  return signed;
}

/** Only the game's own page may start a call: a cross-site form or fetch carries another Origin. */
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function body(req) {
  return new Promise((resolve, reject) => {
    let text = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      text += chunk;
      if (text.length > BODY_LIMIT) {
        reject(new Error("request too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(text));
    req.on("error", reject);
  });
}

function reply(res, status, value) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(encode(value));
}

/** Answers /chain/call and /chain/sign; `path` is the part after /chain. */
export async function handleChain(req, res, path) {
  if (req.method !== "POST") return reply(res, 405, { error: { name: "Error", message: "POST only" } });
  if (!sameOrigin(req) || !String(req.headers["content-type"] || "").startsWith("application/json")) {
    return reply(res, 403, { error: { name: "Error", message: "forbidden" } });
  }
  let input;
  try {
    input = decode((await body(req)) || "{}");
  } catch {
    return reply(res, 400, { error: { name: "Error", message: "bad request body" } });
  }
  if (!input || typeof input !== "object") return reply(res, 400, { error: { name: "Error", message: "bad request body" } });
  if (path === "/call") {
    const client = clientOf(req);
    let mine = 0;
    for (const session of sessions.values()) if (session.client === client) mine += 1;
    if (sessions.size >= MAX_SESSIONS || mine >= MAX_SESSIONS_PER_CLIENT) {
      return reply(res, 503, { error: { name: "Error", message: "The server is busy; try again shortly" } });
    }
    if (!METHODS.has(input.method)) return reply(res, 404, { error: { name: "Error", message: `unknown method ${input.method}` } });
    let owner = null;
    try {
      owner = input.owner ? new PublicKey(input.owner) : null;
    } catch {
      return reply(res, 400, { error: { name: "Error", message: "bad owner" } });
    }
    const session = start(input.method, owner, Array.isArray(input.args) ? input.args : [], client);
    return reply(res, 200, await next(session));
  }
  if (path === "/sign") {
    const session = sessions.get(input.session);
    const pending = session?.signed;
    if (!pending) return reply(res, 404, { error: { name: "Error", message: "This call is no longer waiting for a signature" } });
    session.signed = null;
    clearTimeout(pending.timer);
    if (input.refused) {
      pending.reject(new Error(String(input.refused)));
    } else {
      try {
        pending.resolve(accept(pending, session.owner, String(input.tx)));
      } catch (err) {
        pending.reject(err);
      }
    }
    return reply(res, 200, await next(session));
  }
  return reply(res, 404, { error: { name: "Error", message: "not found" } });
}
