import { PublicKey } from "@solana/web3.js";
import { DEFAULT_QUEUE } from "./codec";

// `vite dev` talks to the local stack (scripts/local-stack.mjs). A built bundle uses the cluster
// named at build time, and devnet only when the build names none.
export const LOCAL_RPC = "http://127.0.0.1:8899";
// ephemeral_vrf_sdk::consts::DEFAULT_TEST_QUEUE: the queue the local vrf-oracle serves.
export const LOCAL_QUEUE = new PublicKey("GKE6d7iv8kCBrsxr78W3xVdjGLLLJnxsGiuzrsZCGEvb");

export const RPC_URL: string = import.meta.env.VITE_RPC_URL || (import.meta.env.DEV ? LOCAL_RPC : "https://api.devnet.solana.com");
export const ORACLE_QUEUE = new PublicKey(
  import.meta.env.VITE_ORACLE_QUEUE || (import.meta.env.DEV ? LOCAL_QUEUE : DEFAULT_QUEUE).toBase58(),
);
