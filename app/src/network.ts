import { PublicKey } from "@solana/web3.js";
import { DEFAULT_EPHEMERAL_QUEUE, EPHEMERAL_TEST_QUEUE } from "./codec";

// `vite dev` talks to the local stack (scripts/local-stack.mjs): Solana on 8899 and the rollup on
// 7799. A built bundle uses the cluster named at build time, and devnet only when the build names none.
export const LOCAL_RPC = "http://127.0.0.1:8899";
export const LOCAL_ER_RPC = "http://127.0.0.1:7799";

export const RPC_URL: string = import.meta.env.VITE_RPC_URL || (import.meta.env.DEV ? LOCAL_RPC : "https://api.devnet.solana.com");
// The rollup must be the one serving the validator pinned in Config, so a built bundle has no
// default: it must name it with VITE_ER_RPC_URL. Its WebSocket is the next port, as web3.js derives it.
export const ER_RPC_URL: string = import.meta.env.VITE_ER_RPC_URL || (import.meta.env.DEV ? LOCAL_ER_RPC : "");
// The VRF oracle answers lock_army inside the rollup, so the queue is an ephemeral one.
export const ORACLE_QUEUE = new PublicKey(
  import.meta.env.VITE_ORACLE_QUEUE || (import.meta.env.DEV ? EPHEMERAL_TEST_QUEUE : DEFAULT_EPHEMERAL_QUEUE).toBase58(),
);
