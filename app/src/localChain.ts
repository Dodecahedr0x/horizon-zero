import type { Army, ChainAdapter, Match, Pot } from "./devChain";

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
    const message = data && typeof data === "object" && "error" in data && typeof (data as { error: unknown }).error === "string"
      ? (data as { error: string }).error
      : response.statusText;
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
    pot(battlegroundId: number) {
      return request<Pot | null>("GET", `/pots/${battlegroundId}`);
    },
    async fundPot(battlegroundId: number, lamports: bigint) {
      await request("POST", `/pots/${battlegroundId}/fund`, { lamports: lamports.toString() });
    },
    async withdrawPot(battlegroundId: number, lamports: bigint) {
      await request("POST", `/pots/${battlegroundId}/withdraw`, { lamports: lamports.toString() });
    },
    async setSegregation(battlegroundId: number, segregate: boolean) {
      await request("POST", `/pots/${battlegroundId}/segregation`, { segregate });
    },
    matches(owner: string) {
      return request<Match[]>("GET", `/matches?player=${encodeURIComponent(owner)}`);
    },
    match(pubkey: string) {
      return request<Match | null>("GET", `/matches/${encodeURIComponent(pubkey)}`);
    },
  };
}
