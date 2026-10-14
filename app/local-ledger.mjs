// Dev-mode accounts. This process is not the Carbon indexer and does not open DATABASE_PATH.
import "../scripts/load-root-env.mjs";
import { createRequire } from "node:module";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
  BATTLEGROUNDS,
  STANDARDS,
  ZONE_DEPTH,
  raceById,
  unitSpec,
  behaviorHash,
  behaviorPda,
  encodeBehavior,
  nameBehavior,
} from "./src/codec.ts";

const require = createRequire(import.meta.url);
// The program's `MAX_UNITS` (also `app/src/armyRules.ts`).
const MAX_UNITS = 10;
const { simulate_json } = require("./src/combat-node/horizon_combat.js");

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PREFIX = "/api/local";

class LedgerError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function hex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function randomHex(size) {
  return hex(crypto.getRandomValues(new Uint8Array(size)));
}

function indexerDbPath() {
  const configured = process.env.DATABASE_PATH || "indexer/data/horizon.db";
  return path.resolve(repoRoot, configured);
}

export function resolveLedgerPath(configured = process.env.LOCAL_LEDGER_PATH || "data/local-ledger.db") {
  const dbPath = path.resolve(repoRoot, configured);
  if (dbPath === indexerDbPath() || dbPath === "/var/data/horizon.db") {
    throw new Error("LOCAL_LEDGER_PATH must not be the indexer database");
  }
  return dbPath;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let failed = false;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 1_000_000) {
        failed = true;
        reject(new LedgerError("body too large", 413));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (failed) return;
      if (!chunks.length) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new LedgerError("invalid json"));
      }
    });
    req.on("error", (err) => {
      if (!failed) reject(err);
    });
  });
}

function send(res, status, body, extra = {}) {
  const payload = JSON.stringify(body === undefined ? null : body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...extra,
  });
  res.end(payload);
}

export function createLedger(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 3000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS identities (
      role TEXT PRIMARY KEY,
      id TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS behaviors (
      hash TEXT PRIMARY KEY,
      pubkey TEXT NOT NULL UNIQUE,
      creator TEXT NOT NULL,
      name TEXT NOT NULL,
      elements TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS battlegrounds (
      id INTEGER PRIMARY KEY,
      pubkey TEXT NOT NULL,
      name TEXT NOT NULL,
      budget INTEGER NOT NULL,
      stake TEXT NOT NULL,
      cols INTEGER NOT NULL,
      rows INTEGER NOT NULL,
      queue TEXT NOT NULL,
      match_seq INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS armies (
      pubkey TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      battleground TEXT NOT NULL,
      battleground_id INTEGER NOT NULL,
      race INTEGER NOT NULL,
      idx INTEGER NOT NULL,
      status INTEGER NOT NULL,
      units TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS armies_owner ON armies(owner);
    DROP TABLE IF EXISTS escrow;
    CREATE TABLE IF NOT EXISTS pots (
      owner TEXT NOT NULL,
      battleground_id INTEGER NOT NULL,
      budget TEXT NOT NULL,
      winnings TEXT NOT NULL,
      segregate INTEGER NOT NULL,
      PRIMARY KEY (owner, battleground_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS matches (
      pubkey TEXT PRIMARY KEY,
      battleground TEXT NOT NULL,
      army_a TEXT NOT NULL,
      army_b TEXT NOT NULL,
      player_a TEXT NOT NULL,
      player_b TEXT NOT NULL,
      stake TEXT NOT NULL,
      cols INTEGER NOT NULL,
      rows INTEGER NOT NULL,
      units_a TEXT NOT NULL,
      units_b TEXT NOT NULL,
      status INTEGER NOT NULL,
      seed TEXT NOT NULL,
      outcome INTEGER NOT NULL,
      trace TEXT NOT NULL
    ) STRICT;
  `);

  // Settled time, for the landing page's "today" count. Rows from before the column read as unknown.
  if (!db.prepare("PRAGMA table_info(matches)").all().some((column) => column.name === "resolved_at")) {
    db.exec("ALTER TABLE matches ADD COLUMN resolved_at INTEGER");
  }

  function transaction(fn) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      db.exec("COMMIT");
      return value;
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // The statement that failed may already have rolled the transaction back.
      }
      throw err;
    }
  }

  function identity(role) {
    return db.prepare("SELECT id, label FROM identities WHERE role = ?").get(role);
  }

  function seed() {
    transaction(() => {
      if (!identity("user")) {
        const idHex = randomHex(16);
        db.prepare("INSERT INTO identities (role, id, label) VALUES ('user', ?, ?)").run(`local_${idHex}`, `local ${idHex.slice(0, 4)}`);
      }
      if (!identity("practice")) {
        const idHex = randomHex(16);
        db.prepare("INSERT INTO identities (role, id, label) VALUES ('practice', ?, 'practice')").run(`practice_${idHex}`);
      }
      const user = identity("user");
      const insertGround = db.prepare(`INSERT OR IGNORE INTO battlegrounds
        (id, pubkey, name, budget, stake, cols, rows, queue, match_seq)
        VALUES (?, ?, ?, ?, ?, ?, ?, '[]', 0)`);
      for (const spec of BATTLEGROUNDS) {
        insertGround.run(spec.id, `battleground-${spec.id}`, spec.name, spec.budget, String(spec.stake), spec.cols, spec.rows);
      }
      const standards = STANDARDS.map((standard) => {
        const body = encodeBehavior(standard.elements);
        if (!body) throw new Error(`${standard.name} is not a valid behavior`);
        return {
          name: standard.name,
          elements: standard.elements,
          body,
          hash: Buffer.from(behaviorHash(body)).toString("hex"),
          pubkey: behaviorPda(body).toBase58(),
        };
      });
      const march = standards.find((item) => item.name === "March");
      const walkNames = new Set(["March", "Kite", "Flank left", "Flank right"]);
      const redirect = new Map();
      const insertBehavior = db.prepare(`INSERT INTO behaviors (hash, pubkey, creator, name, elements) VALUES (?, ?, ?, ?, ?)`);
      const deleteBehavior = db.prepare("DELETE FROM behaviors WHERE hash = ?");
      for (const row of db.prepare("SELECT hash, pubkey, creator, name, elements FROM behaviors").all()) {
        if (row.name === "Volley") {
          redirect.set(row.pubkey, march);
          deleteBehavior.run(row.hash);
          continue;
        }
        const next = standards.find((item) => item.name === row.name);
        if (!next || next.hash === row.hash) continue;
        let elements = [];
        try {
          elements = JSON.parse(row.elements);
        } catch {
          elements = [];
        }
        const walked = Array.isArray(elements) && elements.some((element) => element && element.movement && element.movement.mode === 0);
        redirect.set(row.pubkey, walked || walkNames.has(row.name) ? march : next);
        deleteBehavior.run(row.hash);
      }
      // Names were once the full description; give each stored behavior its short name.
      const rename = db.prepare("UPDATE behaviors SET name = ? WHERE hash = ?");
      for (const row of db.prepare("SELECT hash, name, elements FROM behaviors").all()) {
        let elements = null;
        try {
          elements = JSON.parse(row.elements);
        } catch {
          elements = null;
        }
        const name = Array.isArray(elements) && encodeBehavior(elements) ? nameBehavior(elements) : null;
        if (name && name !== row.name && !standards.some((item) => item.name === row.name)) rename.run(name, row.hash);
      }
      for (const standard of standards) {
        if (db.prepare("SELECT hash FROM behaviors WHERE hash = ?").get(standard.hash)) continue;
        insertBehavior.run(standard.hash, standard.pubkey, user.id, standard.name, JSON.stringify(standard.elements));
      }
      const live = new Set(db.prepare("SELECT pubkey FROM behaviors").all().map((row) => row.pubkey));
      const updateArmy = db.prepare("UPDATE armies SET units = ? WHERE pubkey = ?");
      for (const army of db.prepare("SELECT pubkey, units FROM armies").all()) {
        const units = JSON.parse(army.units);
        let changed = false;
        for (const unit of units) {
          if (live.has(unit.behavior)) continue;
          const next = redirect.get(unit.behavior);
          if (!next) continue;
          unit.behavior = next.pubkey;
          unit.elements = next.elements;
          changed = true;
        }
        if (changed) updateArmy.run(JSON.stringify(units), army.pubkey);
      }
      // Armies are copied from the catalog when they are saved. On each open, an Idle army that is
      // no longer full under the current catalog (over budget, a kind that is gone, or budget left
      // that a soldier would fit) is deleted, since it can never be locked, and the stored stats of
      // every other army's units are rewritten from the catalog.
      const budgets = new Map(db.prepare("SELECT id, budget FROM battlegrounds").all().map((row) => [row.id, Number(row.budget)]));
      const deleteArmy = db.prepare("DELETE FROM armies WHERE pubkey = ?");
      for (const army of db.prepare("SELECT pubkey, battleground_id, race, status, units FROM armies").all()) {
        const units = JSON.parse(army.units);
        const kinds = raceById(army.race)?.units ?? [];
        const specs = units.map((unit) => unitSpec(army.race, Number(unit.kind)));
        const budget = budgets.get(army.battleground_id) ?? 0;
        const cost = specs.reduce((sum, spec) => sum + (spec?.cost ?? Infinity), 0);
        const cheapest = Math.min(...kinds.map((kind) => kind.cost));
        const full = units.length > 0 && cost <= budget && (units.length >= MAX_UNITS || budget - cost < cheapest);
        if (army.status === 0 && !full) {
          deleteArmy.run(army.pubkey);
          continue;
        }
        if (specs.some((spec) => !spec)) continue;
        const refreshed = units.map((unit) => ({ ...unit, ...storedStats(army.race, Number(unit.kind)) }));
        if (JSON.stringify(refreshed) !== army.units) updateArmy.run(JSON.stringify(refreshed), army.pubkey);
      }
      const byName = (name) => standards.find((item) => item.name === name).body;
      const oldBodies = [
        [[1, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0], march.body],
        [[1, 1, 0, 1, 0, 0, 0, 1, 0, 0, 0], march.body],
        [[1, 1, 0, 2, 0, 0, 0, 1, 0, 1, 2], march.body],
        [[1, 1, 0, 3, 0, 0, 0, 1, 0, 1, 2], march.body],
        [[1, 0, 2, 0, 0, 0, 1, 0, 1], march.body],
        [[1, 1, 1, 0, 0, 0, 0, 1, 0, 0, 1], byName("Charge")],
        [[1, 1, 0, 0, 0, 1, 1, 0, 0, 0], march.body],
        [[1, 1, 0, 0, 0, 0, 1, 0, 0, 0], byName("Charge")],
        [[2, 1, 0, 0, 0, 1, 1, 0, 0, 0, 1, 1, 0, 0, 0, 0], byName("Kite")],
        [[1, 1, 2, 0, 0, 0, 1, 0, 1, 2], byName("Flank left")],
        [[1, 1, 3, 0, 0, 0, 1, 0, 1, 2], byName("Flank right")],
        [[1, 1, 0, 0, 0, 1, 1, 1, 0, 0], byName("March cast")],
        [[1, 1, 0, 0, 0, 0, 1, 1, 0, 0], byName("Charge cast")],
        [[2, 1, 0, 0, 0, 1, 1, 1, 0, 0, 1, 1, 0, 0, 0, 0], byName("Kite cast")],
        [[1, 1, 2, 0, 0, 0, 1, 1, 1, 2], byName("Flank left cast")],
        [[1, 1, 3, 0, 0, 0, 1, 1, 1, 2], byName("Flank right cast")],
      ];
      const sameBytes = (left, right) => Array.isArray(left) && left.length === right.length && left.every((byte, index) => byte === right[index]);
      const updateMatch = db.prepare("UPDATE matches SET units_a = ?, units_b = ? WHERE pubkey = ?");
      for (const match of db.prepare("SELECT pubkey, units_a, units_b FROM matches").all()) {
        const sides = [JSON.parse(match.units_a), JSON.parse(match.units_b)];
        let changed = false;
        for (const units of sides) {
          for (const unit of units) {
            const hit = oldBodies.find(([body]) => sameBytes(unit.body, body));
            if (!hit) continue;
            unit.body = hit[1].slice();
            changed = true;
          }
        }
        if (changed) updateMatch.run(JSON.stringify(sides[0]), JSON.stringify(sides[1]), match.pubkey);
      }
    });
  }

  seed();

  function behaviorRows() {
    return db.prepare("SELECT pubkey, creator, name, elements FROM behaviors ORDER BY name, pubkey").all().map((row) => ({
      pubkey: row.pubkey,
      creator: row.creator,
      name: row.name,
      elements: JSON.parse(row.elements),
    }));
  }

  function groundRow(id) {
    return db.prepare("SELECT id, pubkey, name, budget, stake, cols, rows, queue, match_seq FROM battlegrounds WHERE id = ?").get(id);
  }

  function grounds() {
    return db.prepare("SELECT id, pubkey, name, budget, stake, cols, rows, queue, match_seq FROM battlegrounds ORDER BY id").all().map(groundOut);
  }

  function groundOut(row) {
    return {
      pubkey: row.pubkey,
      battlegroundId: row.id,
      name: row.name,
      budget: row.budget,
      stake: row.stake,
      cols: row.cols,
      rows: row.rows,
      queue: JSON.parse(row.queue),
      matchSeq: row.match_seq,
    };
  }

  function armyRow(pubkey) {
    return db.prepare("SELECT pubkey, owner, battleground, battleground_id, race, idx, status, units FROM armies WHERE pubkey = ?").get(pubkey);
  }

  function armyOut(row) {
    return {
      pubkey: row.pubkey,
      owner: row.owner,
      battleground: row.battleground,
      battlegroundId: row.battleground_id,
      race: row.race,
      index: row.idx,
      status: row.status,
      units: JSON.parse(row.units),
    };
  }

  function matchOut(row) {
    return {
      pubkey: row.pubkey,
      battleground: row.battleground,
      armyA: row.army_a,
      armyB: row.army_b,
      playerA: row.player_a,
      playerB: row.player_b,
      stake: row.stake,
      cols: row.cols,
      rows: row.rows,
      unitsA: JSON.parse(row.units_a),
      unitsB: JSON.parse(row.units_b),
      status: row.status,
      seed: row.seed,
      outcome: row.outcome,
    };
  }

  function checkRoster(ground, units, race) {
    if (!Array.isArray(units) || units.length === 0 || units.length > MAX_UNITS) throw new LedgerError(`An army can have at most ${MAX_UNITS} units`);
    const seen = new Set();
    let cost = 0;
    for (const unit of units) {
      const col = Number(unit.col);
      const row = Number(unit.row);
      if (!Number.isInteger(col) || !Number.isInteger(row) || col < 0 || col >= ground.cols || row < 0 || row >= ZONE_DEPTH) {
        throw new LedgerError("Unit position is outside the starting zone");
      }
      const tile = `${col},${row}`;
      if (seen.has(tile)) throw new LedgerError("Two units cannot share a tile");
      seen.add(tile);
      const spec = unitSpec(race, Number(unit.kind));
      if (!spec) throw new LedgerError("Unknown unit");
      cost += spec.cost;
    }
    if (cost > ground.budget) throw new LedgerError("Army cost exceeds the battleground budget");
  }

  function storedStats(race, kind) {
    const spec = unitSpec(race, kind);
    if (!spec) throw new LedgerError("Unknown unit");
    return {
      cost: spec.cost,
      hp: spec.hp,
      atk: spec.atk,
      range: spec.range,
      speed: spec.speed,
      actions: spec.actions,
      cast: { ...spec.cast },
    };
  }

  function snapshot(units, race) {
    return units.map((unit) => ({
      kind: unit.kind,
      body: encodeBehavior(unit.elements) || [],
      col: unit.col,
      row: unit.row,
      race,
      ...(unit.cast ? {
        cost: unit.cost,
        hp: unit.hp,
        atk: unit.atk,
        range: unit.range,
        speed: unit.speed,
        // Armies saved before the actions stat got speed / 2 action points; keep their replays as fought.
        actions: unit.actions ?? Math.floor(Number(unit.speed) / 2),
        cast: currentCast(unit.cast),
      } : storedStats(race, unit.kind)),
    }));
  }

  // Armies saved before cast effects carry `movement` (knockback tiles). It replays the same as a push aimed where the behavior says.
  function currentCast(cast) {
    if (cast.effect !== undefined) return cast;
    const push = Number(cast.movement) || 0;
    return { damage: cast.damage, range: cast.range, aoe: cast.aoe, effect: push > 0 ? 1 : 0, aim: 0, power: push, rounds: 0 };
  }

  function nextIndex() {
    const row = db.prepare("SELECT COALESCE(MAX(idx), -1) AS idx FROM armies").get();
    return Number(row.idx) + 1;
  }

  function createBehavior(elements) {
    if (!Array.isArray(elements)) throw new LedgerError("Behavior body is not valid");
    const body = encodeBehavior(elements);
    if (!body) throw new LedgerError("Behavior body is not valid");
    const hash = Buffer.from(behaviorHash(body)).toString("hex");
    if (db.prepare("SELECT hash FROM behaviors WHERE hash = ?").get(hash)) throw new LedgerError("That behavior already exists");
    const user = identity("user");
    const name = nameBehavior(elements);
    db.prepare("INSERT INTO behaviors (hash, pubkey, creator, name, elements) VALUES (?, ?, ?, ?, ?)").run(
      hash,
      behaviorPda(body).toBase58(),
      user.id,
      name,
      JSON.stringify(elements),
    );
    return {};
  }

  function createArmy(battlegroundId, units, owner, pubkeyPrefix, race = 0) {
    const ground = groundRow(battlegroundId);
    if (!ground) throw new LedgerError("Unknown battleground");
    if (!raceById(race)) throw new LedgerError("Unknown race");
    checkRoster(ground, units, race);
    const known = behaviorRows();
    const stored = units.map((unit) => {
      const behavior = known.find((item) => item.pubkey === unit.behavior);
      if (!behavior) throw new LedgerError("Unknown behavior");
      const kind = Number(unit.kind);
      return {
        kind,
        behavior: behavior.pubkey,
        elements: behavior.elements,
        col: Number(unit.col),
        row: Number(unit.row),
        ...storedStats(race, kind),
      };
    });
    const index = nextIndex();
    db.prepare(`INSERT INTO armies (pubkey, owner, battleground, battleground_id, race, idx, status, units)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?)`).run(
      `${pubkeyPrefix}${index}`,
      owner,
      ground.pubkey,
      ground.id,
      race,
      index,
      JSON.stringify(stored),
    );
    return {};
  }

  // The program's Pot: one stake budget per player and battleground that every locked army draws on.
  function potOf(owner, battlegroundId) {
    const row = db.prepare("SELECT budget, winnings, segregate FROM pots WHERE owner = ? AND battleground_id = ?").get(owner, battlegroundId);
    return row ? { budget: BigInt(row.budget), winnings: BigInt(row.winnings), segregate: row.segregate === 1 } : null;
  }

  function savePot(owner, battlegroundId, pot) {
    db.prepare(`INSERT INTO pots (owner, battleground_id, budget, winnings, segregate) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (owner, battleground_id) DO UPDATE SET budget = excluded.budget, winnings = excluded.winnings, segregate = excluded.segregate`)
      .run(owner, battlegroundId, pot.budget.toString(), pot.winnings.toString(), pot.segregate ? 1 : 0);
  }

  function potOut(pot) {
    return pot && { budget: pot.budget.toString(), winnings: pot.winnings.toString(), segregate: pot.segregate };
  }

  function lamports(value) {
    let amount;
    try {
      amount = BigInt(value);
    } catch {
      throw new LedgerError("amount must be a whole number of lamports");
    }
    if (amount <= 0n) throw new LedgerError("amount must be positive");
    return amount;
  }

  function fundPot(owner, battlegroundId, amount) {
    if (!groundRow(battlegroundId)) throw new LedgerError("Unknown battleground");
    const pot = potOf(owner, battlegroundId) || { budget: 0n, winnings: 0n, segregate: false };
    pot.budget += lamports(amount);
    savePot(owner, battlegroundId, pot);
    return potOut(pot);
  }

  // withdraw_pot: winnings first, then budget.
  function withdrawPot(owner, battlegroundId, amount) {
    const pot = potOf(owner, battlegroundId);
    const want = lamports(amount);
    if (!pot || want > pot.budget + pot.winnings) throw new LedgerError("Pot holds less than the amount asked for");
    const fromWinnings = want < pot.winnings ? want : pot.winnings;
    pot.winnings -= fromWinnings;
    pot.budget -= want - fromWinnings;
    savePot(owner, battlegroundId, pot);
    return potOut(pot);
  }

  function setSegregation(owner, battlegroundId, segregate) {
    const pot = potOf(owner, battlegroundId);
    if (!pot) throw new LedgerError("Fund the pot first");
    pot.segregate = !!segregate;
    savePot(owner, battlegroundId, pot);
    return potOut(pot);
  }

  function credit(owner, battlegroundId, amount) {
    const pot = potOf(owner, battlegroundId);
    if (pot.segregate) pot.winnings += amount;
    else pot.budget += amount;
    savePot(owner, battlegroundId, pot);
  }

  function lock(pubkey) {
    const live = armyRow(pubkey);
    const ground = live ? groundRow(live.battleground_id) : undefined;
    if (!live || live.status !== 0 || !ground) throw new LedgerError("Army is not idle");
    const army = armyOut(live);
    const stake = BigInt(ground.stake);
    const covers = (owner) => (potOf(owner, ground.id)?.budget ?? 0n) >= stake;
    if (!covers(live.owner)) throw new LedgerError("Pot budget does not cover the battleground stake");
    const queue = JSON.parse(ground.queue);
    // An opponent whose pot no longer covers the stake stays queued but cannot be met.
    const opponents = queue
      .map((key) => armyRow(key))
      .filter((item) => item && item.owner !== live.owner && item.status === 1 && covers(item.owner))
      .map(armyOut);
    if (opponents.length === 0) {
      queue.push(live.pubkey);
      db.prepare("UPDATE battlegrounds SET queue = ? WHERE id = ?").run(JSON.stringify(queue), ground.id);
      db.prepare("UPDATE armies SET status = 1 WHERE pubkey = ?").run(live.pubkey);
      return null;
    }
    const pick = crypto.getRandomValues(new Uint8Array(1))[0] % opponents.length;
    const opponent = opponents[pick];
    const seedBytes = crypto.getRandomValues(new Uint8Array(32));
    const opened = {
      pubkey: `match-${ground.id}-${ground.match_seq}`,
      battleground: ground.pubkey,
      armyA: opponent.pubkey,
      armyB: live.pubkey,
      playerA: opponent.owner,
      playerB: live.owner,
      stake: ground.stake,
      cols: ground.cols,
      rows: ground.rows,
      unitsA: snapshot(opponent.units, opponent.race),
      unitsB: snapshot(army.units, army.race),
      status: 0,
      seed: Buffer.from(seedBytes).toString("hex"),
      outcome: 0,
    };
    const raw = simulate_json(JSON.stringify({
      cols: opened.cols,
      rows: opened.rows,
      a: opened.unitsA,
      b: opened.unitsB,
      seed: [...seedBytes],
    }));
    const result = JSON.parse(raw);
    if (!result || !Array.isArray(result.lines)) throw new LedgerError("Combat simulator did not return a trace", 500);
    opened.status = 1;
    opened.outcome = result.winner === 0 ? 1 : result.winner === 1 ? 2 : 3;
    const nextQueue = queue.filter((key) => key !== opponent.pubkey);
    db.prepare("UPDATE battlegrounds SET queue = ?, match_seq = ? WHERE id = ?").run(JSON.stringify(nextQueue), ground.match_seq + 1, ground.id);
    // Both stakes leave the pots, and the battle settles at once: the payout goes back to them.
    for (const owner of [opponent.owner, live.owner]) {
      const pot = potOf(owner, ground.id);
      pot.budget -= stake;
      savePot(owner, ground.id, pot);
    }
    const paid = opened.outcome === 1 ? [2n * stake, 0n] : opened.outcome === 2 ? [0n, 2n * stake] : [stake, stake];
    for (const [owner, amount] of [[opponent.owner, paid[0]], [live.owner, paid[1]]]) credit(owner, ground.id, amount);
    db.prepare("UPDATE armies SET status = 0 WHERE pubkey = ?").run(opponent.pubkey);
    db.prepare("UPDATE armies SET status = 0 WHERE pubkey = ?").run(live.pubkey);
    db.prepare(`INSERT INTO matches (
      pubkey, battleground, army_a, army_b, player_a, player_b, stake, cols, rows,
      units_a, units_b, status, seed, outcome, trace, resolved_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      opened.pubkey,
      opened.battleground,
      opened.armyA,
      opened.armyB,
      opened.playerA,
      opened.playerB,
      opened.stake,
      opened.cols,
      opened.rows,
      JSON.stringify(opened.unitsA),
      JSON.stringify(opened.unitsB),
      opened.status,
      opened.seed,
      opened.outcome,
      JSON.stringify(result.lines),
      Math.floor(Date.now() / 1000),
    );
    return opened;
  }

  function unlock(pubkey) {
    const live = armyRow(pubkey);
    if (!live) throw new LedgerError("Army is not queued");
    if (live.status === 2) throw new LedgerError("A matched army cannot unlock");
    if (live.status !== 1) throw new LedgerError("Army is not queued");
    const ground = groundRow(live.battleground_id);
    if (!ground) throw new LedgerError("Army is not queued");
    const queue = JSON.parse(ground.queue).filter((key) => key !== live.pubkey);
    db.prepare("UPDATE battlegrounds SET queue = ? WHERE id = ?").run(JSON.stringify(queue), ground.id);
    db.prepare("UPDATE armies SET status = 0 WHERE pubkey = ?").run(live.pubkey);
    return {};
  }

  // close_army: only the owner, only an idle army. Past matches keep their own snapshots.
  function closeArmy(pubkey, owner) {
    const live = armyRow(pubkey);
    if (!live) throw new LedgerError("Army not found", 404);
    if (live.owner !== owner) throw new LedgerError("Signer does not own this army");
    if (live.status !== 0) throw new LedgerError("Army cannot be changed in its current status");
    db.prepare("DELETE FROM armies WHERE pubkey = ?").run(pubkey);
    return {};
  }

  /** The indexer's `/stats` shape (see indexer/src/store.rs), from this file. */
  function stats(now = Math.floor(Date.now() / 1000)) {
    const count = (sql, ...params) => Number(db.prepare(sql).get(...params).n);
    let staked = 0n;
    for (const row of db.prepare("SELECT stake FROM matches").all()) staked += 2n * BigInt(row.stake);
    const battlegrounds = db.prepare("SELECT id, pubkey, queue FROM battlegrounds ORDER BY id").all().map((ground) => ({
      battlegroundId: ground.id,
      locked: JSON.parse(ground.queue).length,
      battlesFought: count("SELECT COUNT(*) AS n FROM matches WHERE battleground = ? AND status = 1", ground.pubkey),
    }));
    const players = new Set([
      ...db.prepare("SELECT player_a AS id FROM matches UNION SELECT player_b FROM matches").all().map((row) => row.id),
      ...db.prepare("SELECT DISTINCT owner AS id FROM armies").all().map((row) => row.id),
    ]);
    return {
      battlesFought: count("SELECT COUNT(*) AS n FROM matches WHERE status = 1"),
      battlesToday: count("SELECT COUNT(*) AS n FROM matches WHERE status = 1 AND resolved_at >= ?", now - 86_400),
      battlesAwaiting: count("SELECT COUNT(*) AS n FROM matches WHERE status != 1"),
      draws: count("SELECT COUNT(*) AS n FROM matches WHERE status = 1 AND outcome = 3"),
      players: players.size,
      behaviors: count("SELECT COUNT(*) AS n FROM behaviors"),
      armiesLocked: battlegrounds.reduce((sum, ground) => sum + ground.locked, 0),
      stakedLamports: staked.toString(),
      battlegrounds,
      generatedAt: now,
    };
  }

  function playerMatches(player, limit = 20) {
    return db.prepare("SELECT * FROM matches WHERE player_a = ? OR player_b = ? ORDER BY rowid DESC LIMIT ?")
      .all(player, player, limit)
      .map(matchOut);
  }

  function practice(battlegroundId) {
    const march = behaviorRows().find((item) => item.name === "March");
    if (!march) throw new LedgerError("March is missing");
    const opponent = identity("practice");
    const ground = groundRow(battlegroundId);
    if (!ground) throw new LedgerError("Unknown battleground");
    const index = nextIndex();
    const pubkey = `practice-${index}`;
    const units = [{ kind: 0, behavior: march.pubkey, elements: march.elements, col: 0, row: 0, ...storedStats(0, 0) }];
    db.prepare(`INSERT INTO armies (pubkey, owner, battleground, battleground_id, race, idx, status, units)
      VALUES (?, ?, ?, ?, 0, ?, 1, ?)`).run(pubkey, opponent.id, ground.pubkey, ground.id, index, JSON.stringify(units));
    const queue = JSON.parse(ground.queue);
    queue.push(pubkey);
    db.prepare("UPDATE battlegrounds SET queue = ? WHERE id = ?").run(JSON.stringify(queue), ground.id);
    // The practice foe's pot covers each army it queues.
    const pot = potOf(opponent.id, ground.id);
    if (!pot || pot.budget < BigInt(ground.stake)) fundPot(opponent.id, ground.id, BigInt(ground.stake) - (pot?.budget ?? 0n));
    return {};
  }

  function call(method, pathname, params, body) {
    const pathName = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
    const lockMatch = pathName.match(/^\/api\/local\/armies\/([^/]+)\/lock$/);
    const unlockMatch = pathName.match(/^\/api\/local\/armies\/([^/]+)\/unlock$/);
    const battleMatch = pathName.match(/^\/api\/local\/matches\/([^/]+)$/);
    const armyMatch = pathName.match(/^\/api\/local\/armies\/([^/]+)$/);
    const potMatch = pathName.match(/^\/api\/local\/pots\/(\d+)(?:\/(fund|withdraw|segregation))?$/);
    if (pathName === `${PREFIX}/owner` && method === "GET") {
      const user = identity("user");
      return { owner: user.id, label: user.label };
    }
    if (pathName === `${PREFIX}/stats` && method === "GET") return stats();
    if (pathName === `${PREFIX}/behaviors` && method === "GET") return behaviorRows();
    if (pathName === `${PREFIX}/behaviors` && method === "POST") return transaction(() => createBehavior(body.elements));
    if (pathName === `${PREFIX}/battlegrounds` && method === "GET") return grounds();
    if (pathName === `${PREFIX}/armies` && method === "GET") {
      const owner = params.get("owner");
      if (!owner) throw new LedgerError("owner is required");
      return db.prepare("SELECT pubkey, owner, battleground, battleground_id, race, idx, status, units FROM armies WHERE owner = ? ORDER BY idx").all(owner).map(armyOut);
    }
    if (pathName === `${PREFIX}/armies` && method === "POST") {
      const battlegroundId = Number(body.battlegroundId);
      const race = body.race == null ? 0 : Number(body.race);
      return transaction(() => createArmy(battlegroundId, body.units, identity("user").id, "army-", race));
    }
    if (armyMatch && method === "DELETE") return transaction(() => closeArmy(decodeURIComponent(armyMatch[1]), identity("user").id));
    if (pathName === `${PREFIX}/matches` && method === "GET") {
      const player = params.get("player");
      if (!player) throw new LedgerError("player is required");
      return playerMatches(player);
    }
    if (lockMatch && method === "POST") return transaction(() => lock(decodeURIComponent(lockMatch[1])));
    if (unlockMatch && method === "POST") return transaction(() => unlock(decodeURIComponent(unlockMatch[1])));
    if (pathName === `${PREFIX}/practice` && method === "POST") {
      return transaction(() => practice(Number(body.battlegroundId)));
    }
    if (potMatch) {
      const owner = identity("user").id;
      const id = Number(potMatch[1]);
      if (!potMatch[2] && method === "GET") return potOut(potOf(owner, id));
      if (potMatch[2] === "fund" && method === "POST") return transaction(() => fundPot(owner, id, body.lamports));
      if (potMatch[2] === "withdraw" && method === "POST") return transaction(() => withdrawPot(owner, id, body.lamports));
      if (potMatch[2] === "segregation" && method === "POST") return transaction(() => setSegregation(owner, id, body.segregate));
      throw new LedgerError("method not allowed", 405);
    }
    if (battleMatch && method === "GET") {
      const row = db.prepare("SELECT * FROM matches WHERE pubkey = ?").get(decodeURIComponent(battleMatch[1]));
      return row ? matchOut(row) : null;
    }
    if (
      pathName === `${PREFIX}/owner` ||
      pathName === `${PREFIX}/behaviors` ||
      pathName === `${PREFIX}/battlegrounds` ||
      pathName === `${PREFIX}/armies` ||
      pathName === `${PREFIX}/practice` ||
      pathName === `${PREFIX}/matches` ||
      lockMatch ||
      unlockMatch ||
      battleMatch ||
      armyMatch
    ) {
      throw new LedgerError("method not allowed", 405);
    }
    throw new LedgerError("not found", 404);
  }

  return {
    dbPath,
    close() {
      db.close();
    },
    call,
  };
}

export function createServer(ledger) {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      const body = req.method === "GET" || req.method === "HEAD" ? {} : await readBody(req);
      // Stats are public, like the indexer's, so the landing site may read them across origins.
      const open = url.pathname === "/api/local/stats" ? { "access-control-allow-origin": "*" } : {};
      send(res, 200, ledger.call(req.method || "GET", url.pathname, url.searchParams, body), open);
    } catch (err) {
      const status = Number(err.status) || 500;
      send(res, status, { error: err instanceof Error ? err.message : "failed" });
    }
  });
}

function main() {
  const dbPath = resolveLedgerPath();
  const port = Number(process.env.LOCAL_LEDGER_PORT || 4713);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("LOCAL_LEDGER_PORT must be a TCP port");
  }
  const ledger = createLedger(dbPath);
  const server = createServer(ledger);
  server.listen(port, "127.0.0.1", () => {
    console.log(`local ledger :${port} ${dbPath}`);
  });
  const shutdown = () => {
    server.close();
    ledger.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) main();
