import { PROGRAM_ERRORS } from "./codec";
import type { Army, ChainAdapter, Match, PlayerBalance, ProtocolConfig } from "./devChain";

type Who = { owner: string; label: string };

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/local${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(text || response.statusText);
    }
  }
  if (!response.ok) {
    const failure = (data && typeof data === "object" ? data : {}) as { error?: unknown; name?: unknown };
    const message = typeof failure.error === "string" ? failure.error : response.statusText;
    // A program error carries its HorizonError name, as `ProgramError` does on Solana.
    const code = typeof failure.name === "string" ? PROGRAM_ERRORS.findIndex(([name]) => name === failure.name) : -1;
    if (code >= 0) throw Object.assign(new Error(message), { code: 6000 + code, errorName: failure.name as string });
    throw new Error(message);
  }
  return data as T;
}

export type LocalChain = ChainAdapter & { label(): Promise<string> };

export function createLocalChain(): LocalChain {
  let pending: Promise<Who> | null = null;
  function who() {
    if (!pending) {
      pending = request<Who>("GET", "/owner").catch((err) => {
        pending = null;
        throw err;
      });
    }
    return pending;
  }
  return {
    async label() {
      return (await who()).label;
    },
    async owner() {
      return (await who()).owner;
    },
    behaviors() {
      return request("GET", "/behaviors");
    },
    battlegrounds() {
      return request("GET", "/battlegrounds");
    },
    async armies(owner) {
      return request("GET", `/armies?owner=${encodeURIComponent(owner)}`);
    },
    async createBehavior(elements) {
      await request("POST", "/behaviors", { elements });
    },
    async createArmy(battlegroundId, units, race) {
      await request("POST", "/armies", { battlegroundId, units, race });
    },
    lock(army: Army) {
      return request<Match | null>("POST", `/armies/${encodeURIComponent(army.pubkey)}/lock`);
    },
    async unlock(army: Army) {
      await request("POST", `/armies/${encodeURIComponent(army.pubkey)}/unlock`);
    },
    async closeArmy(army: Army) {
      await request("DELETE", `/armies/${encodeURIComponent(army.pubkey)}`);
    },
    player() {
      return request<PlayerBalance | null>("GET", "/player");
    },
    async register(depositLamports: bigint) {
      await request("POST", "/player/register", { lamports: depositLamports.toString() });
    },
    async topUp(lamports: bigint) {
      await request("POST", "/player/top-up", { lamports: lamports.toString() });
    },
    async fundBudget(lamports: bigint) {
      await request("POST", "/player/budget", { lamports: lamports.toString() });
    },
    // Dev mode has no Outbox: the ledger pays a withdrawal or a fee claim at once.
    async withdraw(lamports: bigint) {
      await request("POST", "/player/withdraw", { lamports: lamports.toString() });
    },
    async releasePending() {
      return "none" as const;
    },
    async setSegregation(segregate: boolean) {
      await request("POST", "/player/segregation", { segregate });
    },
    // The ledger settles a battle inside `lock`, so there is never a Seeded battle to settle.
    async settle() {},
    // Nor an Awaiting one to cancel. The UI never offers it in dev mode; a call is a bug, so say so.
    async cancel() {
      throw new Error("Dev mode settles every battle as it opens; there is nothing to cancel");
    },
    admin() {
      return request<ProtocolConfig>("GET", "/config");
    },
    async claimFees() {
      await request("POST", "/config/claim");
    },
    async setFee(bps: number) {
      await request("POST", "/config/fee", { bps });
    },
    matches(owner: string) {
      return request<Match[]>("GET", `/matches?player=${encodeURIComponent(owner)}`);
    },
    match(pubkey: string) {
      return request<Match | null>("GET", `/matches/${encodeURIComponent(pubkey)}`);
    },
  };
}
