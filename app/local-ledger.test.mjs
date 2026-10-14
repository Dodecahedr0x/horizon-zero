import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { BATTLEGROUNDS, STANDARDS, behaviorPda, unitSpec } from "./src/codec.ts";
import { createLedger, createServer, resolveLedgerPath } from "./local-ledger.mjs";

function march() {
  return STANDARDS.find((item) => item.name === "March").elements;
}

async function listen(dbPath) {
  const ledger = createLedger(dbPath);
  const server = createServer(ledger);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    ledger,
    port,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      ledger.close();
    },
  };
}

async function call(port, method, pathname, body) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  return { status: response.status, data };
}

test("local ledger keeps one user, catalog rows, and army rules across a reopen", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hz-ledger-"));
  const dbPath = path.join(dir, "ledger.db");
  const first = await listen(dbPath);
  let ownerId = "";
  let label = "";
  try {
    const who = await call(first.port, "GET", "/api/local/owner");
    ownerId = who.data.owner;
    label = who.data.label;
    assert.equal(who.status, 200);
    assert.match(who.data.owner, /^local_[0-9a-f]{32}$/);
    assert.match(who.data.label, /^local [0-9a-f]{4}$/);

    const grounds = await call(first.port, "GET", "/api/local/battlegrounds");
    assert.deepEqual(grounds.data.map((ground) => [ground.name, ground.budget, ground.cols, ground.rows]), [
      ["Outpost", 8, 8, 6],
      ["Garrison", 16, 10, 8],
      ["Citadel", 32, 12, 10],
    ]);

    const behaviors = await call(first.port, "GET", "/api/local/behaviors");
    assert.equal(behaviors.data.length, 10);
    assert.equal(behaviors.data.some((item) => item.name === "Volley"), false);
    const duplicate = await call(first.port, "POST", "/api/local/behaviors", { elements: march() });
    assert.equal(duplicate.status, 400);
    assert.equal(duplicate.data.error, "That behavior already exists");

    const custom = [{ movement: { kind: 1, extremum: 0, stat: 0, side: 0, stop: 1 }, actions: [{ verb: 0, extremum: 0, stat: 0, side: 0 }] }];
    const created = await call(first.port, "POST", "/api/local/behaviors", { elements: custom });
    assert.equal(created.status, 200);
    const again = await call(first.port, "POST", "/api/local/behaviors", { elements: custom });
    assert.equal(again.status, 400);

    const marchKey = behaviors.data.find((item) => item.name === "March").pubkey;
    const shared = await call(first.port, "POST", "/api/local/armies", {
      battlegroundId: 0,
      units: [
        { kind: 0, behavior: marchKey, col: 0, row: 0 },
        { kind: 0, behavior: marchKey, col: 0, row: 0 },
      ],
    });
    assert.equal(shared.data.error, "Two units cannot share a tile");
    const outside = await call(first.port, "POST", "/api/local/armies", {
      battlegroundId: 0,
      units: [{ kind: 0, behavior: marchKey, col: 0, row: 2 }],
    });
    assert.equal(outside.data.error, "Unit position is outside the starting zone");
    const costly = await call(first.port, "POST", "/api/local/armies", {
      battlegroundId: 0,
      units: [0, 1, 2, 3].map((col) => ({ kind: 4, behavior: marchKey, col, row: 0 })),
    });
    assert.equal(costly.data.error, "Army cost exceeds the battleground budget");

    const saved = await call(first.port, "POST", "/api/local/armies", {
      battlegroundId: 0,
      units: [
        { kind: 0, behavior: marchKey, col: 0, row: 0 },
        { kind: 1, behavior: marchKey, col: 1, row: 1 },
      ],
    });
    assert.equal(saved.status, 200);
    const mine = await call(first.port, "GET", `/api/local/armies?owner=${encodeURIComponent(who.data.owner)}`);
    assert.equal(mine.data.length, 1);
    assert.equal(mine.data[0].status, 0);
    assert.deepEqual(mine.data[0].units.map((unit) => [unit.kind, unit.col, unit.row]), [[0, 0, 0], [1, 1, 1]]);
    assert.deepEqual(mine.data[0].units[0].elements, march());

    const stake = BigInt(BATTLEGROUNDS[0].stake);
    const broke = await call(first.port, "POST", `/api/local/armies/${mine.data[0].pubkey}/lock`);
    assert.equal(broke.status, 400);
    assert.equal(broke.data.error, "Player budget does not cover the battleground stake");
    assert.equal(broke.data.name, "BudgetTooLow");
    assert.equal((await call(first.port, "GET", "/api/local/player")).data, null);
    await call(first.port, "POST", "/api/local/player/register", { lamports: String(stake) });
    const funded = await call(first.port, "POST", "/api/local/player/budget", { lamports: String(stake) });
    assert.deepEqual(funded.data, {
      free: "0",
      budget: String(stake),
      winnings: "0",
      locked: "0",
      segregate: false,
      outboxPending: "0",
      outboxInFlight: false,
    });
    await call(first.port, "POST", "/api/local/player/segregation", { segregate: true });
    const queued = await call(first.port, "POST", `/api/local/armies/${mine.data[0].pubkey}/lock`);
    assert.equal(queued.status, 200);
    assert.equal(queued.data, null);
    const idleUnlock = await call(first.port, "POST", `/api/local/armies/${mine.data[0].pubkey}/unlock`);
    assert.equal(idleUnlock.status, 200);

    await call(first.port, "POST", "/api/local/practice", { battlegroundId: 0 });
    const afterPractice = await call(first.port, "GET", `/api/local/armies?owner=${encodeURIComponent(who.data.owner)}`);
    assert.equal(afterPractice.data.length, 1);
    const opened = await call(first.port, "POST", `/api/local/armies/${mine.data[0].pubkey}/lock`);
    assert.equal(opened.status, 200);
    assert.equal(opened.data.status, 1);
    assert.equal(opened.data.playerB, who.data.owner);
    assert.notEqual(opened.data.playerA, who.data.owner);
    assert.match(opened.data.playerA, /^practice_[0-9a-f]{32}$/);
    assert.equal(opened.data.seed.length, 64);
    assert.equal(opened.data.unitsB.length, 2);
    // The battle settles at once: a segregated win lands in the winnings less the 5% fee, a draw
    // refunds the budget, a loss leaves nothing.
    const fee = (2n * stake * 500n) / 10_000n;
    const outcome = opened.data.outcome;
    const player = (await call(first.port, "GET", "/api/local/player")).data;
    assert.equal(player.budget, outcome === 3 ? String(stake) : "0");
    assert.equal(player.winnings, outcome === 2 ? String(2n * stake - fee) : "0");
    assert.equal(player.locked, "0");
    assert.equal(player.free, "0");
    const config = (await call(first.port, "GET", "/api/local/config")).data;
    assert.equal(config.fees, outcome === 3 ? "0" : String(fee));
    const matchedUnlock = await call(first.port, "POST", `/api/local/armies/${mine.data[0].pubkey}/unlock`);
    assert.equal(matchedUnlock.status, 400);

    const fighting = new DatabaseSync(dbPath);
    fighting.prepare("UPDATE armies SET status = 2 WHERE pubkey = ?").run(mine.data[0].pubkey);
    fighting.close();
    const refused = await call(first.port, "POST", `/api/local/armies/${mine.data[0].pubkey}/unlock`);
    assert.equal(refused.status, 400);
    assert.equal(refused.data.error, "A matched army cannot unlock");
  } finally {
    await first.close();
  }

  const second = await listen(dbPath);
  try {
    const who = await call(second.port, "GET", "/api/local/owner");
    assert.equal(who.data.owner, ownerId);
    assert.equal(who.data.label, label);
    const armies = await call(second.port, "GET", `/api/local/armies?owner=${encodeURIComponent(who.data.owner)}`);
    assert.equal(armies.data.length, 1);
    assert.equal(armies.data[0].units.length, 2);
    const behaviors = await call(second.port, "GET", "/api/local/behaviors");
    assert.equal(behaviors.data.length, 11);
    const custom = behaviors.data.find((item) => item.elements[0]?.movement?.kind === 1 && item.elements[0]?.movement?.stop === 1);
    assert.equal(custom.elements[0].movement.stop, 1);
    const battle = await call(second.port, "GET", "/api/local/matches/match-0-0");
    assert.equal(battle.data.outcome > 0, true);
    const raw = new DatabaseSync(dbPath);
    const trace = raw.prepare("SELECT trace FROM matches WHERE pubkey = 'match-0-0'").get();
    raw.close();
    assert.equal(Array.isArray(JSON.parse(trace.trace)), true);
    const latest = await call(second.port, "GET", `/api/local/matches?player=${encodeURIComponent(who.data.owner)}`);
    assert.deepEqual(latest.data.map((item) => item.pubkey), ["match-0-0"]);

    // close_army: refused while fighting, then the idle army is gone.
    const busy = await call(second.port, "DELETE", `/api/local/armies/${armies.data[0].pubkey}`);
    assert.equal(busy.status, 400);
    const idle = new DatabaseSync(dbPath);
    idle.prepare("UPDATE armies SET status = 0 WHERE pubkey = ?").run(armies.data[0].pubkey);
    idle.close();
    const closed = await call(second.port, "DELETE", `/api/local/armies/${armies.data[0].pubkey}`);
    assert.equal(closed.status, 200);
    const left = await call(second.port, "GET", `/api/local/armies?owner=${encodeURIComponent(who.data.owner)}`);
    assert.equal(left.data.length, 0);
    const missing = await call(second.port, "DELETE", `/api/local/armies/${armies.data[0].pubkey}`);
    assert.equal(missing.status, 404);
  } finally {
    await second.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadEnvFile keeps a variable that is already set", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hz-env-"));
  const file = path.join(dir, "env");
  fs.writeFileSync(file, "HZ_LEDGER_TEST_VAR=from-file\n");
  process.env.HZ_LEDGER_TEST_VAR = "from-process";
  process.loadEnvFile(file);
  assert.equal(process.env.HZ_LEDGER_TEST_VAR, "from-process");
  delete process.env.HZ_LEDGER_TEST_VAR;
  fs.rmSync(dir, { recursive: true, force: true });
});

test("reopen replaces old standards and points a removed walk body at March", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hz-ledger-old-"));
  const dbPath = path.join(dir, "ledger.db");
  const first = createLedger(dbPath);
  first.close();
  const oldMarch = [1, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0];
  const oldCharge = [1, 1, 1, 0, 0, 0, 0, 1, 0, 0, 1];
  const oldVolley = [1, 0, 2, 0, 0, 0, 1, 0, 1];
  const marchKey = behaviorPda(oldMarch).toBase58();
  const chargeKey = behaviorPda(oldCharge).toBase58();
  const volleyKey = behaviorPda(oldVolley).toBase58();
  const raw = new DatabaseSync(dbPath);
  const user = raw.prepare("SELECT id FROM identities WHERE role = 'user'").get();
  raw.prepare("DELETE FROM behaviors").run();
  const insert = raw.prepare("INSERT INTO behaviors (hash, pubkey, creator, name, elements) VALUES (?, ?, ?, ?, ?)");
  insert.run("old-march", marchKey, user.id, "March", JSON.stringify([{ movement: { mode: 0, kind: 0, extremum: 0, stat: 0, stop: 0 }, actions: [{ verb: 0, extremum: 0, stat: 0 }] }]));
  insert.run("old-charge", chargeKey, user.id, "Charge", JSON.stringify([{ movement: { mode: 1, kind: 0, extremum: 0, stat: 0, stop: 0 }, actions: [{ verb: 0, extremum: 0, stat: 1 }] }]));
  insert.run("old-volley", volleyKey, user.id, "Volley", JSON.stringify([{ movement: null, actions: [{ verb: 0, extremum: 0, stat: 0 }, { verb: 1, extremum: 0, stat: 1 }] }]));
  const keptKey = "custom-walk";
  insert.run("custom-walk", keptKey, user.id, "Walk Approach Lowest Distance", JSON.stringify([{ movement: { mode: 0, kind: 0, extremum: 0, stat: 0, stop: 0 }, actions: [] }]));
  const units = [
    { kind: 0, behavior: volleyKey, elements: [], col: 0, row: 0 },
    { kind: 0, behavior: chargeKey, elements: [], col: 1, row: 0 },
    { kind: 0, behavior: keptKey, elements: [{ movement: { mode: 0, kind: 0, extremum: 0, stat: 0, stop: 0 }, actions: [] }], col: 2, row: 0 },
    { kind: 0, behavior: chargeKey, elements: [], col: 3, row: 0 },
  ];
  raw.prepare("INSERT INTO armies (pubkey, owner, battleground, battleground_id, race, idx, status, units) VALUES ('army-old', ?, 'battleground-0', 0, 0, 0, 0, ?)").run(user.id, JSON.stringify(units));
  raw.close();

  const second = createLedger(dbPath);
  try {
    const behaviors = second.call("GET", "/api/local/behaviors", new URLSearchParams(), {});
    assert.equal(behaviors.some((item) => item.name === "Volley"), false);
    assert.equal(behaviors.filter((item) => item.name === "March").length, 1);
    assert.equal(behaviors.find((item) => item.name === "March").elements[0].movement.stop, 1);
    assert.equal(behaviors.find((item) => item.pubkey === keptKey).name, "Walk Approach Lowest Distance");
    const army = second.call("GET", "/api/local/armies", new URLSearchParams({ owner: user.id }), {});
    const march = behaviors.find((item) => item.name === "March").pubkey;
    const charge = behaviors.find((item) => item.name === "Charge").pubkey;
    assert.equal(army[0].units[0].behavior, march);
    assert.equal(army[0].units[1].behavior, charge);
    assert.equal(army[0].units[1].elements[0].actions[0].stat, 0);
    assert.equal(army[0].units[2].behavior, keptKey);
    assert.equal(army[0].units.length, 4);
  } finally {
    second.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an Idle army that is no longer full is dropped on open, and kept armies get catalog stats", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hz-ledger-armies-"));
  const dbPath = path.join(dir, "ledger.db");
  createLedger(dbPath).close();
  const raw = new DatabaseSync(dbPath);
  const user = raw.prepare("SELECT id FROM identities WHERE role = 'user'").get();
  const marchKey = raw.prepare("SELECT pubkey FROM behaviors WHERE name = 'March'").get().pubkey;
  const guard = (col, stale = {}) => ({ kind: 0, behavior: marchKey, elements: march(), col, row: 0, cost: 2, hp: 6, atk: 1, range: 1, speed: 1, ...stale });
  const insert = raw.prepare("INSERT INTO armies (pubkey, owner, battleground, battleground_id, race, idx, status, units) VALUES (?, ?, 'battleground-0', 0, 0, ?, ?, ?)");
  // Outpost budget 8, Guards cost 2: two Guards leave room, five are over budget, four are full.
  assert.equal(unitSpec(0, 0).cost, 2);
  insert.run("army-short", user.id, 0, 0, JSON.stringify([guard(0), guard(1)]));
  insert.run("army-over", user.id, 1, 0, JSON.stringify([0, 1, 2, 3, 4].map((col) => guard(col))));
  insert.run("army-gone", user.id, 2, 0, JSON.stringify([{ ...guard(0), kind: 99 }]));
  insert.run("army-full", user.id, 3, 0, JSON.stringify([0, 1, 2, 3].map((col) => guard(col))));
  insert.run("army-queued", user.id, 4, 1, JSON.stringify([guard(0)]));
  raw.close();

  const ledger = createLedger(dbPath);
  try {
    const armies = ledger.call("GET", "/api/local/armies", new URLSearchParams({ owner: user.id }), {});
    assert.deepEqual(armies.map((army) => army.pubkey), ["army-full", "army-queued"]);
    const full = armies.find((army) => army.pubkey === "army-full");
    const spec = unitSpec(0, 0);
    for (const unit of full.units) {
      assert.deepEqual(
        { cost: unit.cost, hp: unit.hp, atk: unit.atk, range: unit.range, speed: unit.speed, actions: unit.actions, cast: unit.cast },
        { cost: spec.cost, hp: spec.hp, atk: spec.atk, range: spec.range, speed: spec.speed, actions: spec.actions, cast: spec.cast },
      );
    }
  } finally {
    ledger.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the ledger path stays off the indexer database", () => {
  const previous = process.env.DATABASE_PATH;
  process.env.DATABASE_PATH = "indexer/data/horizon.db";
  assert.throws(() => resolveLedgerPath("indexer/data/horizon.db"), /indexer database/);
  assert.throws(() => resolveLedgerPath("/var/data/horizon.db"), /indexer database/);
  if (previous === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = previous;
});

// Outpost: stake 10_000_000 lamports; at the default 5% the fee on a won pot is 1_000_000.
const STAKE = 10_000_000n;
const FEE = 1_000_000n;
const DEPOSIT = 100_000_000n;

/**
 * A ledger whose battles end as `winner` says (0 side A, the queued practice army; 1 side B, the
 * local user's lock; null a draw), so payouts are exact.
 */
function scripted() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hz-ledger-money-"));
  const dbPath = path.join(dir, "ledger.db");
  const state = { winner: null };
  const ledger = createLedger(dbPath, { simulate: () => JSON.stringify({ winner: state.winner, lines: [] }) });
  const api = (method, pathname, body = {}, params = new URLSearchParams()) => ledger.call(method, `/api/local${pathname}`, params, body);
  const user = api("GET", "/owner").owner;
  const marchKey = api("GET", "/behaviors").find((item) => item.name === "March").pubkey;
  function army() {
    api("POST", "/armies", { battlegroundId: 0, units: [0, 1, 2, 3].map((col) => ({ kind: 0, behavior: marchKey, col, row: 0 })) });
    return api("GET", "/armies", {}, new URLSearchParams({ owner: user })).at(-1);
  }
  function practicePlayer(db) {
    const id = db.prepare("SELECT id FROM identities WHERE role = 'practice'").get().id;
    return db.prepare("SELECT * FROM players WHERE owner = ?").get(id);
  }
  function raw(fn) {
    const db = new DatabaseSync(dbPath);
    try {
      return fn(db);
    } finally {
      db.close();
    }
  }
  return {
    state,
    api,
    user,
    army,
    raw,
    practice: () => raw(practicePlayer),
    close() {
      ledger.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function balanceOf(free, budget, winnings = 0n, locked = 0n, segregate = false) {
  return {
    free: String(free),
    budget: String(budget),
    winnings: String(winnings),
    locked: String(locked),
    segregate,
    outboxPending: "0",
    outboxInFlight: false,
  };
}

function refused(fn, name, message) {
  assert.throws(fn, (err) => err.errorName === name && err.message === message);
}

test("register, top up and fund the budget keep the lamports whole", () => {
  const t = scripted();
  try {
    assert.equal(t.api("GET", "/player"), null);
    refused(() => t.api("POST", "/player/budget", { lamports: "1" }), "MissingAccount", "A required account is missing");
    assert.deepEqual(t.api("POST", "/player/register", { lamports: String(DEPOSIT) }), balanceOf(DEPOSIT, 0n));
    refused(() => t.api("POST", "/player/register", { lamports: "1" }), "AlreadyExists", "Account already exists");
    const funded = t.api("POST", "/player/budget", { lamports: "30000000" });
    assert.deepEqual(funded, balanceOf(70_000_000n, 30_000_000n));
    assert.equal(BigInt(funded.free) + BigInt(funded.budget), DEPOSIT);
    refused(() => t.api("POST", "/player/budget", { lamports: "70000001" }), "BalanceShort", "Player holds less than the amount asked for");
    assert.deepEqual(t.api("POST", "/player/top-up", { lamports: "5000000" }), balanceOf(75_000_000n, 30_000_000n));
    assert.deepEqual(t.api("GET", "/player"), balanceOf(75_000_000n, 30_000_000n));
  } finally {
    t.close();
  }
});

test("a won match pays the winner 2 * stake - fee and the fee to config", () => {
  const t = scripted();
  try {
    t.api("POST", "/player/register", { lamports: String(DEPOSIT) });
    t.api("POST", "/player/budget", { lamports: "30000000" });
    t.api("POST", "/practice", { battlegroundId: 0 });
    t.state.winner = 1;
    const match = t.api("POST", `/armies/${t.army().pubkey}/lock`);
    assert.equal(match.outcome, 2);
    // Budget 30M - 10M stake + 19M credit; the Player gained the loser's stake less the fee.
    assert.deepEqual(t.api("GET", "/player"), balanceOf(70_000_000n, 30_000_000n - STAKE + 2n * STAKE - FEE));
    const loser = t.practice();
    assert.deepEqual([loser.balance, loser.budget, loser.locked, loser.fighting], ["0", "0", "0", 0]);
    assert.deepEqual(t.api("GET", "/config"), { admin: t.user, feeBps: 500, fees: String(FEE) });

    // Lost: the local user's stake leaves the Player.
    t.api("POST", "/practice", { battlegroundId: 0 });
    t.state.winner = 0;
    assert.equal(t.api("POST", `/armies/${t.army().pubkey}/lock`).outcome, 1);
    assert.deepEqual(t.api("GET", "/player"), balanceOf(70_000_000n, 39_000_000n - STAKE));
    assert.equal(t.practice().budget, String(2n * STAKE - FEE));
    assert.equal(t.api("GET", "/config").fees, String(2n * FEE));
  } finally {
    t.close();
  }
});

test("a draw restores both budgets and takes no fee", () => {
  const t = scripted();
  try {
    t.api("POST", "/player/register", { lamports: String(DEPOSIT) });
    t.api("POST", "/player/budget", { lamports: "30000000" });
    t.api("POST", "/practice", { battlegroundId: 0 });
    t.state.winner = null;
    assert.equal(t.api("POST", `/armies/${t.army().pubkey}/lock`).outcome, 3);
    assert.deepEqual(t.api("GET", "/player"), balanceOf(70_000_000n, 30_000_000n));
    const other = t.practice();
    assert.deepEqual([other.balance, other.budget, other.locked], [String(STAKE), String(STAKE), "0"]);
    assert.equal(t.api("GET", "/config").fees, "0");
  } finally {
    t.close();
  }
});

test("a segregated win goes to winnings, and withdraw takes free, winnings, then budget", () => {
  const t = scripted();
  try {
    t.api("POST", "/player/register", { lamports: String(DEPOSIT) });
    t.api("POST", "/player/budget", { lamports: "30000000" });
    t.api("POST", "/player/segregation", { segregate: true });
    t.api("POST", "/practice", { battlegroundId: 0 });
    t.state.winner = 1;
    t.api("POST", `/armies/${t.army().pubkey}/lock`);
    assert.deepEqual(t.api("GET", "/player"), balanceOf(70_000_000n, 20_000_000n, 19_000_000n, 0n, true));

    refused(() => t.api("POST", "/player/withdraw", { lamports: "0" }), "NothingToWithdraw", "There is nothing to withdraw");
    assert.deepEqual(t.api("POST", "/player/withdraw", { lamports: "80000000" }), balanceOf(0n, 20_000_000n, 9_000_000n, 0n, true));
    refused(() => t.api("POST", "/player/withdraw", { lamports: "29000001" }), "BalanceShort", "Player holds less than the amount asked for");
    assert.deepEqual(t.api("POST", "/player/withdraw", { lamports: "15000000" }), balanceOf(0n, 14_000_000n, 0n, 0n, true));

    // A stake still locked in a battle is never withdrawn.
    t.raw((db) => db.prepare("UPDATE players SET locked = ?, balance = ?, fighting = 1 WHERE owner = ?").run(String(STAKE), String(14_000_000n + STAKE), t.user));
    refused(() => t.api("POST", "/player/withdraw", { lamports: "14000001" }), "BalanceShort", "Player holds less than the amount asked for");
    assert.deepEqual(t.api("POST", "/player/withdraw", { lamports: "14000000" }), balanceOf(0n, 0n, 0n, STAKE, true));
  } finally {
    t.close();
  }
});

test("setFee and claimFees are admin only, setFee is capped, and a claim zeroes the fees", () => {
  const t = scripted();
  try {
    refused(() => t.api("POST", "/config/claim"), "NothingToWithdraw", "There is nothing to withdraw");
    refused(() => t.api("POST", "/config/fee", { bps: 1001 }), "FeeTooHigh", "Fee rate is above the cap");
    assert.deepEqual(t.api("POST", "/config/fee", { bps: 1000 }), { admin: t.user, feeBps: 1000, fees: "0" });

    t.api("POST", "/player/register", { lamports: String(DEPOSIT) });
    t.api("POST", "/player/budget", { lamports: String(STAKE) });
    t.api("POST", "/practice", { battlegroundId: 0 });
    t.state.winner = 1;
    t.api("POST", `/armies/${t.army().pubkey}/lock`);
    // 10% of a 20M pot.
    assert.equal(t.api("GET", "/config").fees, "2000000");
    assert.equal(t.api("GET", "/player").budget, "18000000");

    const admin = t.api("GET", "/config").admin;
    t.raw((db) => db.prepare("UPDATE config SET admin = 'someone-else'").run());
    refused(() => t.api("POST", "/config/claim"), "NotAdmin", "Battleground admin signature is required");
    refused(() => t.api("POST", "/config/fee", { bps: 100 }), "NotAdmin", "Battleground admin signature is required");
    t.raw((db) => db.prepare("UPDATE config SET admin = ?").run(admin));

    assert.deepEqual(t.api("POST", "/config/claim"), { admin, feeBps: 1000, fees: "0" });
    refused(() => t.api("POST", "/config/claim"), "NothingToWithdraw", "There is nothing to withdraw");
  } finally {
    t.close();
  }
});

test("a lock evicts a queued army whose owner's budget no longer covers the stake", () => {
  const t = scripted();
  try {
    t.api("POST", "/player/register", { lamports: String(DEPOSIT) });
    t.api("POST", "/player/budget", { lamports: String(3n * STAKE) });
    // Two practice armies on one practice budget of one stake.
    t.api("POST", "/practice", { battlegroundId: 0 });
    t.api("POST", "/practice", { battlegroundId: 0 });
    assert.equal(t.practice().budget, String(STAKE));
    t.state.winner = 1;
    const first = t.api("POST", `/armies/${t.army().pubkey}/lock`);
    assert.equal(first.outcome, 2);
    assert.equal(t.practice().budget, "0");
    const stranded = t.api("GET", "/battlegrounds")[0].queue;
    assert.equal(stranded.length, 1);

    const mine = t.army();
    assert.equal(t.api("POST", `/armies/${mine.pubkey}/lock`), null);
    assert.deepEqual(t.api("GET", "/battlegrounds")[0].queue, [mine.pubkey]);
    const practiceId = t.raw((db) => db.prepare("SELECT id FROM identities WHERE role = 'practice'").get().id);
    const evicted = t.api("GET", "/armies", {}, new URLSearchParams({ owner: practiceId })).find((item) => item.pubkey === stranded[0]);
    assert.equal(evicted.status, 0);
  } finally {
    t.close();
  }
});
