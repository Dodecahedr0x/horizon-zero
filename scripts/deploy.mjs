// Deploy or upgrade horizon_zero on devnet or mainnet, then bootstrap it.
//
//   node scripts/deploy.mjs devnet  [--keypair ~/.config/solana/id.json] [--url <rpc>]
//   node scripts/deploy.mjs mainnet --confirm-mainnet [--keypair <path>] [--url <rpc>] [--priority <micro-lamports>]
//   required:    --er-url <rollup rpc> and --validator <its identity>: the identity must be what the
//                rollup's getIdentity returns. It is built into the program as HZ_VALIDATOR, and every
//                delegation goes to it.
//   extra flags: --skip-build (reuse target/deploy/horizon_zero.so, only if it is the default-features
//                build this script recorded for that same validator), --skip-bootstrap
//
// The program id is the address of target/deploy/horizon_zero-keypair.json, which must be
// Hm19JfKaKCRphRwF7DbxhJWmLpHgMG1SnEnKGRyN9Z7c. The --keypair wallet pays, holds the upgrade
// authority, and becomes the game admin on the first bootstrap: `initialize` accepts only the
// upgrade authority, so the deploy and the bootstrap use that one keypair. An upgrade by another
// wallet is refused before anything is sent. Local testing does not use this script: it runs on
// scripts/local-stack.mjs.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertDefaultBuild, buildDefault } from "./program-build.mjs";

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
// The program is built for one rollup: every delegation goes to its validator identity. A wrong
// rollup is caught before anything is built or any SOL is spent: the operator names the identity
// they expect, and it must be the one the rollup reports.
const erUrl = value("--er-url", "");
if (!erUrl) fail("--er-url <rollup rpc> is required: the program is built for that rollup's validator");
let validator = "";
{
  let identity;
  try {
    const response = await fetch(erUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getIdentity" }),
    });
    identity = (await response.json()).result?.identity;
  } catch (err) {
    fail(`getIdentity on ${erUrl} failed: ${err.message}`);
  }
  if (!identity) fail(`the rollup at ${erUrl} did not return its identity`);
  process.stdout.write(`[deploy] rollup ${erUrl} identity ${identity}\n`);
  validator = value("--validator", "");
  if (!validator) fail(`pass --validator ${identity} to confirm: the build delegates every account to it`);
  if (validator !== identity) fail(`--validator ${validator} is not the identity ${identity} that ${erUrl} reports`);
}
const keypair = value("--keypair", "~/.config/solana/id.json").replace(/^~(?=$|\/)/, os.homedir());
if (!fs.existsSync(keypair)) fail(`wallet keypair not found: ${keypair}`);
const programKeypair = path.join(root, "target/deploy/horizon_zero-keypair.json");
if (!fs.existsSync(programKeypair)) fail(`program keypair not found: ${programKeypair}`);
const programAddress = output("solana-keygen", ["pubkey", programKeypair]);
if (programAddress !== PROGRAM_ID) fail(`program keypair is ${programAddress}, but declare_id! is ${PROGRAM_ID}`);

// Default features only: inline-mock-vrf and inline-mock-magic are for LiteSVM; they would break
// the real VRF callback and skip the rollup's ephemeral accounts and delegation. A reused .so must
// be the default build recorded next to it (a LiteSVM mock build overwrites the same file).
try {
  const keys = { validator, oracleQueue: ORACLE_QUEUE };
  if (has("--skip-build")) assertDefaultBuild(root, keys);
  else buildDefault(root, keys, (line) => process.stdout.write(`[deploy] ${line}\n`));
} catch (err) {
  fail(has("--skip-build") ? `${err.message}; drop --skip-build` : err.message);
}

const payer = output("solana-keygen", ["pubkey", keypair]);
const balance = output("solana", ["balance", payer, "--url", url]);
process.stdout.write(`[deploy] ${cluster} via ${url}, payer ${payer} (${balance})\n`);

// An upgrade needs the upgrade authority, and the bootstrap's initialize needs it as the admin. Ask
// the RPC whether the program account exists first: only a confirmed "no account" skips the check,
// and any RPC failure stops here rather than deploying blind.
let existing;
try {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: [PROGRAM_ID, { encoding: "base64" }] }),
  });
  const json = await response.json();
  if (json.error || !json.result) throw new Error(JSON.stringify(json.error ?? json));
  existing = json.result.value;
} catch (err) {
  fail(`getAccountInfo ${PROGRAM_ID} on ${url} failed: ${err.message}`);
}
if (existing) {
  const shown = spawnSync("solana", ["program", "show", PROGRAM_ID, "--url", url, "--output", "json"], { cwd: root, encoding: "utf8" });
  if (shown.status !== 0) fail(`solana program show ${PROGRAM_ID} failed: ${(shown.stderr || shown.stdout).trim()}`);
  let authority = null;
  try {
    authority = JSON.parse(shown.stdout).authority ?? null;
  } catch {
    fail(`could not read the upgrade authority from solana program show: ${shown.stdout.trim()}`);
  }
  if (authority !== payer) fail(`${PROGRAM_ID} is deployed with upgrade authority ${authority ?? "none"}, not ${payer}; deploy and bootstrap with that keypair`);
}

const deploy = [
  "program", "deploy", "target/deploy/horizon_zero.so",
  "--program-id", programKeypair,
  "--keypair", keypair,
  "--upgrade-authority", keypair,
  "--url", url,
];
const priority = value("--priority", "");
if (priority) deploy.push("--with-compute-unit-price", priority);
run("solana", deploy);

if (!has("--skip-bootstrap")) {
  run("node", ["app/scripts/bootstrap.mjs", "--url", url, "--er-url", erUrl, "--keypair", keypair, "--validator", validator]);
}

const rollup = erUrl;
process.stdout.write(`
[deploy] done. Build the game with VITE_DEV_MODE=false and run its server for this cluster with:
  RPC_URL=${url}
  ER_RPC_URL=${rollup}
  ORACLE_QUEUE=${ORACLE_QUEUE}
and point the indexer at the same rollup (not ${url}) with SOLANA_RPC_URL=${rollup}
`);
