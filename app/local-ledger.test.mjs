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
    assert.equal(broke.data.error, "Pot budget does not cover the battleground stake");
    const funded = await call(first.port, "POST", "/api/local/pots/0/fund", { lamports: String(stake) });
    assert.deepEqual(funded.data, { budget: String(stake), winnings: "0", segregate: false });
    await call(first.port, "POST", "/api/local/pots/0/segregation", { segregate: true });
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
    // Both stakes left the pots; a segregated payout lands in the winnings.
    const won = opened.data.outcome === 2 ? 2n * stake : opened.data.outcome === 3 ? stake : 0n;
    const pot = await call(first.port, "GET", "/api/local/pots/0");
    assert.deepEqual(pot.data, { budget: "0", winnings: String(won), segregate: true });
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
