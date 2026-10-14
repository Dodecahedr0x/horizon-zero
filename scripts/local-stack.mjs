// Local Solana + MagicBlock ephemeral rollup for Horizon Zero, as one foreground process.
//
//   node scripts/local-stack.mjs            build, boot, bootstrap, then keep running (Ctrl-C stops all)
//   node scripts/local-stack.mjs --check    the same, then play one VRF-resolved battle and exit
//   node scripts/local-stack.mjs --no-build reuse target/deploy/horizon_zero.so and mock_hydra.so
//
// mb-stack (npm @magicblock-labs/ephemeral-validator) runs the base validator with the delegation
// and VRF programs and the VRF test queue preloaded, the ephemeral validator, and the
// query-filtering front. horizon_zero is loaded into the base validator at its program id.
// vrf-oracle from the same package fulfils requests on the test queue with its built-in local key.
// mb-stack has no Hydra, so programs/mock-hydra is loaded at the Hydra id and
// app/scripts/hydra-cranker.mjs runs the settlement cranks. HZ_HYDRA_SO=<hydra.so> loads a real
// Hydra build instead, and HZ_HYDRA_CRANKER=<hydra-cranker binary> runs MagicBlock's cranker
// (both from https://github.com/magicblock-labs/hydra).
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const work = path.join(root, "target/localnet");
const args = new Set(process.argv.slice(2));

export const PROGRAM_ID = "Hm19JfKaKCRphRwF7DbxhJWmLpHgMG1SnEnKGRyN9Z7c";
// ephemeral_vrf_sdk::consts::DEFAULT_TEST_QUEUE, served by the local vrf-oracle.
export const TEST_QUEUE = "GKE6d7iv8kCBrsxr78W3xVdjGLLLJnxsGiuzrsZCGEvb";
export const HYDRA_ID = "Hydra17i1feui9deaxu6d1TzSQMRNHeBRkDR1Awy7zea";
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

function start(name, command, commandArgs, file) {
  const out = fs.openSync(path.join(work, file), "w");
  const child = spawn(command, commandArgs, { cwd: root, detached: true, stdio: ["ignore", out, out] });
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

function rpc(portNumber, method, params = []) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
    const req = http.request(
      { host: "127.0.0.1", port: portNumber, method: "POST", headers: { "content-type": "application/json" }, timeout: 2000 },
      (res) => {
        let text = "";
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(text).result ?? null);
          } catch {
            resolve(null);
          }
        });
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

async function waitFor(label, check, seconds = 180) {
  for (let i = 0; i < seconds * 2; i += 1) {
    if (stopping) return;
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  process.stderr.write(`[local] ${label} did not come up in ${seconds}s; see target/localnet/\n`);
  stop(1);
}

async function main() {
  process.on("SIGINT", () => stop(130));
  process.on("SIGTERM", () => stop(143));
  need("mb-stack", `Install it with: npm install -g ${MB_PACKAGE}`);
  need("vrf-oracle", `It ships with mb-stack: npm install -g ${MB_PACKAGE}`);
  need("solana-test-validator", "Install the Anza CLI: https://docs.anza.xyz/cli/install");
  fs.mkdirSync(work, { recursive: true });

  const busy = await rpc(BASE, "getHealth");
  if (busy) {
    process.stderr.write(`[local] something already answers on 127.0.0.1:${BASE}. Stop it or set MB_STACK_BASE_PORT.\n`);
    process.exit(1);
  }

  if (!args.has("--no-build")) {
    // Default features: inline-mock-vrf is a LiteSVM-only build and must not reach a real cluster.
    log("building programs/horizon-zero and programs/mock-hydra");
    run("cargo-build-sbf", ["--manifest-path", "programs/horizon-zero/Cargo.toml"]);
    run("cargo-build-sbf", ["--manifest-path", "programs/mock-hydra/Cargo.toml"]);
  }
  const so = path.join(root, "target/deploy/horizon_zero.so");
  const hydraSo = process.env.HZ_HYDRA_SO ? path.resolve(process.env.HZ_HYDRA_SO) : path.join(root, "target/deploy/mock_hydra.so");
  for (const file of [so, hydraSo]) {
    if (!fs.existsSync(file)) {
      process.stderr.write(`[local] ${path.relative(root, file)} is missing; run without --no-build\n`);
      process.exit(1);
    }
  }

  log("starting mb-stack (base validator, ephemeral rollup, query front)");
  start("mb-stack", "mb-stack", [
    "--reset",
    "--ledger", path.join(work, "mb-ledger"),
    "--gossip-port", String(GOSSIP),
    "--dynamic-port-range", DYNAMIC,
    "--faucet-port", String(FAUCET),
    "--bpf-program", PROGRAM_ID, so,
    "--bpf-program", HYDRA_ID, hydraSo,
  ], "mb-stack.log");
  await waitFor("mb-stack", async () => fs.readFileSync(path.join(work, "mb-stack.log"), "utf8").includes("stack is ready"));
  if (stopping) return;

  log("starting vrf-oracle on the test queue");
  start("vrf-oracle", "vrf-oracle", ["--rpc-url", `http://127.0.0.1:${BASE}`, "--websocket-url", `ws://127.0.0.1:${BASE + 1}`], "vrf-oracle.log");

  const admin = path.join(work, "admin.json");
  if (!fs.existsSync(admin)) run("solana-keygen", ["new", "--no-bip39-passphrase", "--silent", "--force", "-o", admin], { stdio: "ignore" });
  run("solana", ["airdrop", "100", "-k", admin, "-u", `http://127.0.0.1:${BASE}`], { stdio: "ignore" });
  log("bootstrapping config, battlegrounds and standard behaviors");
  run("node", ["app/scripts/bootstrap.mjs", "--url", `http://127.0.0.1:${BASE}`, "--keypair", admin]);

  const cranker = path.join(work, "cranker.json");
  if (!fs.existsSync(cranker)) run("solana-keygen", ["new", "--no-bip39-passphrase", "--silent", "--force", "-o", cranker], { stdio: "ignore" });
  run("solana", ["airdrop", "10", "-k", cranker, "-u", `http://127.0.0.1:${BASE}`], { stdio: "ignore" });
  if (process.env.HZ_HYDRA_CRANKER) {
    log(`starting ${process.env.HZ_HYDRA_CRANKER}`);
    start("hydra-cranker", process.env.HZ_HYDRA_CRANKER, ["--rpc-url", `http://127.0.0.1:${BASE}`, "--ws-url", `ws://127.0.0.1:${BASE + 1}`, "--keypair", cranker], "hydra-cranker.log");
  } else {
    log("starting the Hydra cranker");
    start("hydra-cranker", "node", ["app/scripts/hydra-cranker.mjs", "--url", `http://127.0.0.1:${BASE}`, "--keypair", cranker], "hydra-cranker.log");
  }

  log("ready");
  log(`  base (Solana) RPC   http://127.0.0.1:${BASE}   ws ws://127.0.0.1:${BASE + 1}`);
  log(`  ephemeral rollup    http://127.0.0.1:${ER}   ws ws://127.0.0.1:${ER + 1}`);
  log(`  public (routed)     http://127.0.0.1:${PUBLIC}   ws ws://127.0.0.1:${PUBLIC + 1}`);
  log(`  VRF queue           ${TEST_QUEUE}`);
  log(`  Hydra               ${HYDRA_ID} from ${path.relative(root, hydraSo)}`);
  log(`  Hydra cranker       ${process.env.HZ_HYDRA_CRANKER || "app/scripts/hydra-cranker.mjs"}`);
  log(`  fund a wallet       pnpm localnet:fund <address>`);

  if (args.has("--check")) {
    log("playing one VRF-resolved battle");
    run("node", ["app/scripts/localnet-assert.mjs"], { env: { ...process.env, RPC_URL: `http://127.0.0.1:${BASE}`, ORACLE_QUEUE: TEST_QUEUE } });
    log("localnet battle resolved");
    stop(0);
    return;
  }
  log("Ctrl-C stops every node");
}

main().catch((err) => {
  process.stderr.write(`[local] ${err.stack || err}\n`);
  stop(1);
});
