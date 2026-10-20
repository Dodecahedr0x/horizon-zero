// Local Solana + MagicBlock ephemeral rollup for Horizon Zero, as one foreground process.
//
//   node scripts/local-stack.mjs              build, boot, bootstrap, index, then keep running (Ctrl-C stops all)
//   node scripts/local-stack.mjs --check      the same, then play, settle and cash out one battle and exit
//   node scripts/local-stack.mjs --check --probe   also record what the rollup's RPC answers (slower)
//   node scripts/local-stack.mjs --no-build   reuse target/deploy/horizon_zero.so, only if it is the
//                                             default-features build this script or deploy.mjs recorded
//   node scripts/local-stack.mjs --no-indexer do not start the indexer
//
// mb-stack (npm @magicblock-labs/ephemeral-validator) runs the base validator with the delegation,
// VRF and eSPL programs and the VRF queues preloaded, the ephemeral rollup, and the query-filtering
// front. horizon_zero is loaded into the base validator at genesis as an upgradeable program whose
// upgrade authority is the bootstrap admin (target/localnet/admin.json): `initialize` accepts only
// the upgrade authority. mb-stack passes its extra arguments to solana-test-validator, so this is
// `--upgradeable-program <id> <so> <admin>`. The rollup clones it on first use. vrf-oracle from the same
// package watches the rollup and answers the ephemeral test queue, where lock_army asks for its seed.
// The program is built for the local rollup's identity (LOCAL_VALIDATOR, as HZ_VALIDATOR). The
// bootstrap creates and funds the eSPL rent PDA top-ups need, initializes Config, and delegates
// Config, the battlegrounds and the treasury Outbox to that identity.
// The ledger is reset on every start, so the indexer gets a fresh database under target/localnet.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { indexerListenPort } from "./indexer-port.mjs";
import { SO, assertDefaultBuild, buildDefault } from "./program-build.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const work = path.join(root, "target/localnet");
const args = new Set(process.argv.slice(2));

export const PROGRAM_ID = "Hm19JfKaKCRphRwF7DbxhJWmLpHgMG1SnEnKGRyN9Z7c";
// ephemeral_vrf_sdk::consts::DEFAULT_EPHEMERAL_TEST_QUEUE, served by the vrf-oracle that watches the rollup.
export const EPHEMERAL_TEST_QUEUE = "Sc9MJUngNbQXSXGP3F67KvKwVnhaYn6kcioxXNVowYT";
// The identity mb-stack's ephemeral validator signs with. The local build delegates to it.
export const LOCAL_VALIDATOR = "mAGicPQYBMvcYveUZA5F5UNNwyHvfYh5xkLS2Fr1mev";
const MB_PACKAGE = "@magicblock-labs/ephemeral-validator@0.14.10";

const port = (name, fallback) => Number(process.env[name] || fallback);
const BASE = port("MB_STACK_BASE_PORT", 8899);
const ER = port("MB_STACK_ER_PORT", 7799);
const PUBLIC = port("MB_STACK_PUBLIC_PORT", 6699);
// solana-test-validator's own gossip (8000), dynamic and faucet (9900) ports collide with any other
// local validator, so this stack keeps them out of the way.
const GOSSIP = port("HZ_LOCAL_GOSSIP_PORT", 18000);
const DYNAMIC = process.env.HZ_LOCAL_DYNAMIC_PORTS || "18100-18200";
const FAUCET = port("HZ_LOCAL_FAUCET_PORT", 19900);
const BASE_URL = `http://127.0.0.1:${BASE}`;
const ER_URL = `http://127.0.0.1:${ER}`;
const INDEXER_PORT = indexerListenPort();
const INDEXER_URL = `http://127.0.0.1:${INDEXER_PORT}`;

const children = [];
let stopping = false;

function log(message) {
  process.stdout.write(`[local] ${message}\n`);
}

function need(command, hint) {
  const found = spawnSync("sh", ["-c", `command -v ${command}`], { encoding: "utf8" });
  if (found.status !== 0) {
    process.stderr.write(`[local] ${command} is not on PATH. ${hint}\n`);
    process.exit(1);
  }
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, { cwd: root, stdio: "inherit", ...options });
  if (result.status !== 0) throw new Error(`${command} ${commandArgs.join(" ")} failed`);
  return result;
}

function start(name, command, commandArgs, file, options = {}) {
  const out = fs.openSync(path.join(work, file), "w");
  const child = spawn(command, commandArgs, { cwd: root, detached: true, stdio: ["ignore", out, out], ...options });
  children.push({ name, child });
  child.on("exit", (code, signal) => {
    if (stopping) return;
    process.stderr.write(`[local] ${name} exited (${signal || code}); see target/localnet/${file}\n`);
    stop(1);
  });
  return child;
}

function stop(code) {
  if (stopping) return;
  stopping = true;
  // Once the children are gone the event loop may empty before the timer below fires.
  process.exitCode = code;
  for (const { child } of children) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
  setTimeout(() => process.exit(code), 1500).unref();
}

function request(portNumber, method, pathName, body) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: "127.0.0.1", port: portNumber, method, path: pathName, headers: { "content-type": "application/json" }, timeout: 2000 },
      (res) => {
        let text = "";
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () => resolve({ status: res.statusCode, text }));
      },
    );
    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
    req.end(body);
  });
}

async function rpc(portNumber, method, params = []) {
  const response = await request(portNumber, "POST", "/", JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }));
  try {
    return response ? (JSON.parse(response.text).result ?? null) : null;
  } catch {
    return null;
  }
}

async function waitFor(label, check, seconds = 180, file = "") {
  for (let i = 0; i < seconds * 2; i += 1) {
    if (stopping) return;
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  process.stderr.write(`[local] ${label} did not come up in ${seconds}s; see target/localnet/${file}\n`);
  stop(1);
}

async function main() {
  process.on("SIGINT", () => stop(130));
  process.on("SIGTERM", () => stop(143));
  need("mb-stack", `Install it with: npm install -g ${MB_PACKAGE}`);
  need("vrf-oracle", `It ships with mb-stack: npm install -g ${MB_PACKAGE}`);
  for (const tool of ["solana-test-validator", "solana", "solana-keygen"]) need(tool, "Install the Anza CLI: https://docs.anza.xyz/cli/install");
  if (!args.has("--no-build")) need("cargo-build-sbf", "It ships with the Anza CLI: https://docs.anza.xyz/cli/install");
  if (!args.has("--no-indexer")) need("cargo", "The indexer is built with cargo: https://rustup.rs");
  fs.mkdirSync(work, { recursive: true });

  for (const [what, portNumber] of [["base", BASE], ["rollup", ER]]) {
    if (await rpc(portNumber, "getHealth")) {
      process.stderr.write(`[local] something already answers on 127.0.0.1:${portNumber} (${what}). Stop it first.\n`);
      process.exit(1);
    }
  }
  const indexing = !args.has("--no-indexer");
  if (indexing && (await request(Number(INDEXER_PORT), "GET", "/health"))) {
    process.stderr.write(`[local] something already answers on 127.0.0.1:${INDEXER_PORT}. Stop it, set INDEXER_PORT, or pass --no-indexer.\n`);
    process.exit(1);
  }

  if (!args.has("--no-build")) {
    // Default features: inline-mock-vrf and inline-mock-magic are LiteSVM-only builds and must not
    // reach a real validator. The LiteSVM suite's mock build overwrites the same .so, so build here.
    log("building programs/horizon-zero with default features");
    buildDefault(root, { validator: LOCAL_VALIDATOR, oracleQueue: EPHEMERAL_TEST_QUEUE }, log);
  }
  const so = path.join(root, SO);
  try {
    assertDefaultBuild(root, { validator: LOCAL_VALIDATOR, oracleQueue: EPHEMERAL_TEST_QUEUE });
  } catch (err) {
    process.stderr.write(`[local] ${err.message}; run without --no-build\n`);
    process.exit(1);
  }

  // The admin holds the program's upgrade authority from genesis, so it is the one key `initialize`
  // accepts. The ledger is reset on every start; the keypair is kept between runs.
  const admin = path.join(work, "admin.json");
  if (!fs.existsSync(admin)) run("solana-keygen", ["new", "--no-bip39-passphrase", "--silent", "--force", "-o", admin], { stdio: "ignore" });

  // `--reset` resets only the base ledger. The rollup keeps its accounts in
  // magicblock-test-storage/ under its working directory, so it runs in target/localnet and that
  // directory is removed here: otherwise ephemeral armies, behaviors and battles from the last run
  // outlive the base ledger they were made on.
  fs.rmSync(path.join(work, "magicblock-test-storage"), { recursive: true, force: true });
  log("starting mb-stack (base validator, ephemeral rollup, query front)");
  start("mb-stack", "mb-stack", [
    "--reset",
    "--ledger", path.join(work, "mb-ledger"),
    "--gossip-port", String(GOSSIP),
    "--dynamic-port-range", DYNAMIC,
    "--faucet-port", String(FAUCET),
    "--upgradeable-program", PROGRAM_ID, so, admin,
  ], "mb-stack.log", { cwd: work });
  await waitFor("mb-stack", async () => fs.readFileSync(path.join(work, "mb-stack.log"), "utf8").includes("stack is ready"), 180, "mb-stack.log");
  if (stopping) return;

  // The ephemeral test queue is delegated to the rollup, so its oracle watches the rollup.
  log("starting vrf-oracle on the rollup's ephemeral test queue");
  start("vrf-oracle", "vrf-oracle", ["--rpc-url", ER_URL, "--websocket-url", `ws://127.0.0.1:${ER + 1}`], "vrf-oracle.log", {
    env: { ...process.env, RUST_LOG: process.env.RUST_LOG || "info" },
  });

  run("solana", ["airdrop", "100", "-k", admin, "-u", BASE_URL], { stdio: "ignore" });
  log("bootstrapping: eSPL rent PDA, config, battlegrounds, treasury Outbox, delegations");
  run("node", ["app/scripts/bootstrap.mjs", "--url", BASE_URL, "--er-url", ER_URL, "--keypair", admin, "--validator", LOCAL_VALIDATOR, "--espl-rent"]);

  if (indexing) {
    // A fresh database: the ledger was just reset, and rows from the last run name accounts that
    // no longer exist.
    const database = path.join(work, "indexer.db");
    for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(database + suffix, { force: true });
    log("starting the indexer on the rollup (first run compiles it)");
    start("indexer", "node", ["scripts/run-indexer.mjs"], "indexer.log", {
      env: { ...process.env, SOLANA_RPC_URL: ER_URL, DATABASE_PATH: database, INDEXER_PORT },
    });
    await waitFor("the indexer", async () => (await request(Number(INDEXER_PORT), "GET", "/battlegrounds"))?.status === 200, 900, "indexer.log");
    if (stopping) return;
  }

  log("ready");
  log(`  base (Solana) RPC   ${BASE_URL}   ws ws://127.0.0.1:${BASE + 1}`);
  log(`  ephemeral rollup    ${ER_URL}   ws ws://127.0.0.1:${ER + 1}`);
  log(`  public (routed)     http://127.0.0.1:${PUBLIC}   ws ws://127.0.0.1:${PUBLIC + 1}`);
  log(`  VRF queue           ${EPHEMERAL_TEST_QUEUE} (ephemeral, oracle on the rollup)`);
  log(`  admin keypair       ${path.relative(root, admin)}`);
  if (indexing) log(`  indexer             ${INDEXER_URL}   db target/localnet/indexer.db`);
  log(`  app env             VITE_DEV_MODE=false RPC_URL=${BASE_URL} ER_RPC_URL=${ER_URL} ORACLE_QUEUE=${EPHEMERAL_TEST_QUEUE}`);
  log(`  fund a wallet       pnpm localnet:fund <address>`);

  if (args.has("--check")) {
    log("playing, settling and cashing out one battle");
    run("node", ["app/scripts/localnet-assert.mjs", ...(args.has("--probe") ? ["--probe"] : [])], {
      env: {
        ...process.env,
        RPC_URL: BASE_URL,
        ER_RPC_URL: ER_URL,
        ORACLE_QUEUE: EPHEMERAL_TEST_QUEUE,
        ADMIN_KEYPAIR: admin,
        ...(indexing ? { INDEXER_URL } : { INDEXER_URL: "" }),
      },
    });
    log("localnet check passed");
    stop(0);
    return;
  }
  log("Ctrl-C stops every node");
}

main().catch((err) => {
  process.stderr.write(`[local] ${err.stack || err}\n`);
  stop(1);
});
