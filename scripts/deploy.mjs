// Deploy or upgrade horizon_zero on devnet or mainnet, then bootstrap it.
//
//   node scripts/deploy.mjs devnet  [--keypair ~/.config/solana/id.json] [--url <rpc>]
//   node scripts/deploy.mjs mainnet --confirm-mainnet [--keypair <path>] [--url <rpc>] [--priority <micro-lamports>]
//   extra flags: --skip-build (reuse target/deploy/horizon_zero.so), --skip-bootstrap,
//                --er-url <rollup rpc> (required unless --skip-bootstrap), --validator <identity>
//
// The program id is the address of target/deploy/horizon_zero-keypair.json, which must be
// Hm19JfKaKCRphRwF7DbxhJWmLpHgMG1SnEnKGRyN9Z7c. The --keypair wallet pays, holds the upgrade
// authority, and becomes the game admin on the first bootstrap. Local testing does not use this
// script: it runs on scripts/local-stack.mjs.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROGRAM_ID = "Hm19JfKaKCRphRwF7DbxhJWmLpHgMG1SnEnKGRyN9Z7c";
// ephemeral_vrf_sdk::consts::DEFAULT_EPHEMERAL_QUEUE: lock_army runs in the rollup, so its oracle
// must call back into the rollup.
const ORACLE_QUEUE = "5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc";
const CLUSTERS = {
  devnet: "https://api.devnet.solana.com",
  mainnet: "https://api.mainnet-beta.solana.com",
};

const argv = process.argv.slice(2);
const cluster = argv[0];
const has = (name) => argv.includes(name);
function value(name, fallback) {
  const at = argv.indexOf(name);
  if (at === -1) return fallback;
  if (!argv[at + 1]) fail(`${name} needs a value`);
  return argv[at + 1];
}

function fail(message) {
  process.stderr.write(`[deploy] ${message}\n`);
  process.exit(1);
}

function run(command, args) {
  process.stdout.write(`[deploy] ${command} ${args.join(" ")}\n`);
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.status !== 0) fail(`${command} failed`);
}

function output(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) fail(`${command} ${args.join(" ")} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

if (!CLUSTERS[cluster]) fail("usage: node scripts/deploy.mjs <devnet|mainnet> [--keypair path] [--url rpc]");
if (cluster === "mainnet" && !has("--confirm-mainnet")) fail("mainnet spends real SOL; pass --confirm-mainnet to go ahead");

const url = value("--url", CLUSTERS[cluster]);
// The rollup Config is pinned to: bootstrap delegates every account to its validator identity.
const erUrl = value("--er-url", "");
if (!erUrl && !has("--skip-bootstrap")) fail("--er-url <rollup rpc> is required: Config pins that rollup's validator for good");
const keypair = value("--keypair", "~/.config/solana/id.json").replace(/^~(?=$|\/)/, os.homedir());
if (!fs.existsSync(keypair)) fail(`wallet keypair not found: ${keypair}`);
const programKeypair = path.join(root, "target/deploy/horizon_zero-keypair.json");
if (!fs.existsSync(programKeypair)) fail(`program keypair not found: ${programKeypair}`);
const programAddress = output("solana-keygen", ["pubkey", programKeypair]);
if (programAddress !== PROGRAM_ID) fail(`program keypair is ${programAddress}, but declare_id! is ${PROGRAM_ID}`);

if (!has("--skip-build")) {
  // Default features only: inline-mock-vrf is for LiteSVM and would break the real VRF callback.
  run("cargo-build-sbf", ["--manifest-path", "programs/horizon-zero/Cargo.toml"]);
}

const payer = output("solana-keygen", ["pubkey", keypair]);
const balance = output("solana", ["balance", payer, "--url", url]);
process.stdout.write(`[deploy] ${cluster} via ${url}, payer ${payer} (${balance})\n`);

const deploy = [
  "program", "deploy", "target/deploy/horizon_zero.so",
  "--program-id", programKeypair,
  "--keypair", keypair,
  "--url", url,
];
const priority = value("--priority", "");
if (priority) deploy.push("--with-compute-unit-price", priority);
run("solana", deploy);

if (!has("--skip-bootstrap")) {
  const validator = value("--validator", "");
  run("node", ["app/scripts/bootstrap.mjs", "--url", url, "--er-url", erUrl, "--keypair", keypair, ...(validator ? ["--validator", validator] : [])]);
}

const rollup = erUrl || "<rollup RPC>";
process.stdout.write(`
[deploy] done. Build the game for this cluster with:
  VITE_DEV_MODE=false
  VITE_RPC_URL=${url}
  VITE_ER_RPC_URL=${rollup}
  VITE_ORACLE_QUEUE=${ORACLE_QUEUE}
and point the indexer at the same rollup (not ${url}) with SOLANA_RPC_URL=${rollup}
`);
