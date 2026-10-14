import { AIMS, EFFECTS, LASTING_EFFECTS } from "./ids.mjs";

export { AIMS, EFFECTS, LASTING_EFFECTS };
export const MOVE_KINDS = ["Approach", "Flee", "Flank left", "Flank right"];
export const EXTREMA = ["Lowest", "Highest"];
export const STATS = ["Distance", "HP", "ATK"];
export const VERBS = ["Attack", "Cast"];
export const SIDES = ["Enemy", "Ally"];
export const MAX_BEHAVIOR_LEN = 77;
/** The longest name a behavior gets, in characters. Longer generated names are cut at a word. */
export const MAX_BEHAVIOR_NAME_LEN = 32;

const KIND_IDS = { approach: 0, flee: 1, "flank-left": 2, "flank-right": 3 };
const EXTREMUM_IDS = { lowest: 0, highest: 1 };
const STAT_IDS = { distance: 0, hp: 1, atk: 2 };
const SIDE_IDS = { enemy: 0, ally: 1 };
const VERB_IDS = { attack: 0, cast: 1 };

function fail(message) {
  throw new Error(`content catalog: ${message}`);
}

function word(table, value, label) {
  const id = table[value];
  if (id === undefined) fail(`${label} ${JSON.stringify(value)}`);
  return id;
}

function colorFromFile(value, label) {
  if (typeof value !== "string" || !/^#[0-9a-f]{6}$/i.test(value)) fail(`${label} color must be #rrggbb`);
  return value;
}

function whole(value, label) {
  if (!Number.isInteger(value) || value < 0) fail(`${label} must be a non-negative integer`);
  return value;
}

function movementFromFile(movement) {
  if (!movement || typeof movement !== "object") fail("movement must be an object");
  if (typeof movement.stop !== "boolean") fail("movement stop must be true or false");
  return {
    kind: word(KIND_IDS, movement.kind, "movement kind"),
    extremum: word(EXTREMUM_IDS, movement.extremum, "movement extremum"),
    stat: word(STAT_IDS, movement.stat, "movement stat"),
    side: word(SIDE_IDS, movement.side, "movement side"),
    stop: movement.stop ? 1 : 0,
  };
}

function actionFromFile(action) {
  if (!action || typeof action !== "object") fail("action must be an object");
  return {
    verb: word(VERB_IDS, action.type, "action type"),
    extremum: word(EXTREMUM_IDS, action.extremum, "action extremum"),
    stat: word(STAT_IDS, action.stat, "action stat"),
    side: word(SIDE_IDS, action.side, "action side"),
  };
}

function castFromFile(cast, label) {
  if (!cast || typeof cast !== "object") fail(`${label} cast`);
  return {
    damage: whole(cast.damage, `${label} cast damage`),
    range: whole(cast.range, `${label} cast range`),
    aoe: whole(cast.aoe, `${label} cast aoe`),
    effect: word(Object.fromEntries(EFFECTS.map((slug, id) => [slug, id])), cast.effect, `${label} cast effect`),
    aim: word(Object.fromEntries(AIMS.map((slug, id) => [slug, id])), cast.aim, `${label} cast aim`),
    power: whole(cast.power, `${label} cast power`),
    rounds: whole(cast.rounds, `${label} cast rounds`),
    cooldown: whole(cast.cooldown, `${label} cast cooldown`),
  };
}

const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

// One line a player can read: what the cast does, to whom, how far.
export function describeCast(cast) {
  const effect = EFFECTS[cast.effect] ?? "none";
  const aim = AIMS[cast.aim] ?? "chosen";
  const who = aim === "self" ? "itself" : aim === "ally" ? "an ally or itself" : aim === "foe" ? "a foe" : "the chosen target";
  const lasting = `for ${plural(cast.rounds, "round")}`;
  const self = aim === "self";
  const speed = cast.power === 1 ? "Doubles" : `Multiplies by ${cast.power + 1}`;
  const what = {
    none: `Strikes ${who}`,
    push: `Pushes ${who} back ${plural(cast.power, "tile")}`,
    sprint: self ? `${speed} its movement ${lasting}` : `${speed} the movement of ${who} ${lasting}`,
    reach: self ? `Adds ${cast.power} to its attack range ${lasting}` : `Adds ${cast.power} to the attack range of ${who} ${lasting}`,
    taunt: `Taunts ${who}: it walks toward the caster ${lasting}`,
    heal: `Heals ${who} for up to ${cast.power} HP`,
  }[effect];
  const parts = [what];
  if (cast.damage > 0) parts.push(`${cast.damage} damage`);
  if (aim !== "self") parts.push(`range ${cast.range}`);
  if (cast.aoe > 0) parts.push(`area ${cast.aoe}`);
  if (cast.cooldown > 0) parts.push(`then waits ${plural(cast.cooldown, "round")} to cast again`);
  return parts.join(" · ");
}

export function interpretCatalog(raw) {
  if (!raw || typeof raw !== "object") fail("root must be an object");
  if (!Array.isArray(raw.races) || raw.races.length === 0) fail("races");
  if (!Array.isArray(raw.behaviors) || raw.behaviors.length === 0) fail("behaviors");
  if (!Array.isArray(raw.battlegrounds) || raw.battlegrounds.length === 0) fail("battlegrounds");
  // Stakes are lamports; they stay below 2^53, so a JSON number holds them exactly.
  const battlegrounds = raw.battlegrounds.map((ground) => {
    if (!ground || typeof ground.name !== "string" || typeof ground.slug !== "string") fail("battleground name and slug");
    const label = `battleground ${ground.name}`;
    return {
      id: whole(ground.id, `${label} id`),
      slug: ground.slug,
      name: ground.name,
      budget: whole(ground.budget, `${label} budget`),
      stake: whole(ground.stake, `${label} stake`),
      cols: whole(ground.cols, `${label} cols`),
      rows: whole(ground.rows, `${label} rows`),
    };
  });
  const races = raw.races.map((race) => {
    if (!race || typeof race.name !== "string" || typeof race.slug !== "string") fail("race name and slug");
    if (!Array.isArray(race.units) || race.units.length === 0) fail(`${race.name} units`);
    return {
      id: whole(race.id, `${race.name} id`),
      name: race.name,
      slug: race.slug,
      units: race.units.map((unit) => {
        const label = `${race.name} ${unit && unit.name}`;
        if (!unit || typeof unit.name !== "string") fail(`${label} name`);
        return {
          id: whole(unit.id, `${label} id`),
          name: unit.name,
          color: colorFromFile(unit.color, label),
          cost: whole(unit.cost, `${label} cost`),
          hp: whole(unit.hp, `${label} hp`),
          atk: whole(unit.atk, `${label} atk`),
          range: whole(unit.range, `${label} range`),
          speed: whole(unit.speed, `${label} speed`),
          actions: whole(unit.actions, `${label} actions`),
          cast: castFromFile(unit.cast, label),
        };
      }),
    };
  });
  const behaviors = raw.behaviors.map((behavior) => {
    if (!behavior || typeof behavior.name !== "string" || !Array.isArray(behavior.elements)) fail("behavior name and elements");
    const elements = behavior.elements.map((element) => {
      if (!element || !Array.isArray(element.actions)) fail(`${behavior.name} element`);
      return {
        movement: element.movement == null ? null : movementFromFile(element.movement),
        actions: element.actions.map((action) => actionFromFile(action)),
      };
    });
    const body = encodeBehavior(elements);
    if (!body) fail(`${behavior.name} does not encode`);
    return { name: behavior.name, elements, body };
  });
  return { battlegrounds, races, behaviors };
}

export function encodeBehavior(elements) {
  if (!Array.isArray(elements) || elements.length < 1 || elements.length > 4) return null;
  const out = [elements.length];
  for (const element of elements) {
    if (!element || !Array.isArray(element.actions) || element.actions.length > 3) return null;
    if (element.movement) {
      const movement = element.movement;
      if (movement.kind > 3 || movement.extremum > 1 || movement.stat > 2 || movement.stop > 1) return null;
      if (movement.side !== 0 && movement.side !== 1) return null;
      out.push(1, movement.kind, movement.extremum, movement.stat, movement.side, movement.stop);
    } else {
      out.push(0);
    }
    out.push(element.actions.length);
    for (const action of element.actions) {
      if (action.verb > 1 || action.extremum > 1 || action.stat > 2) return null;
      if (action.side !== 0 && action.side !== 1) return null;
      out.push(action.verb, action.extremum, action.stat, action.side);
    }
  }
  return out.length > MAX_BEHAVIOR_LEN ? null : out;
}

export function parseBehavior(body) {
  if (!Array.isArray(body)) return null;
  let index = 0;
  const count = body[index++];
  if (!count || count > 4 || body.length > MAX_BEHAVIOR_LEN) return null;
  const elements = [];
  for (let slot = 0; slot < count; slot += 1) {
    const present = body[index++];
    if (present !== 0 && present !== 1) return null;
    let movement = null;
    if (present === 1) {
      const kind = body[index++];
      const extremum = body[index++];
      const stat = body[index++];
      const side = body[index++];
      const stop = body[index++];
      if ([kind, extremum, stat, side, stop].some((value) => value === undefined)) return null;
      if (kind > 3 || extremum > 1 || stat > 2 || stop > 1) return null;
      if (side !== 0 && side !== 1) return null;
      movement = { kind, extremum, stat, side, stop };
    }
    const actionCount = body[index++];
    if (actionCount === undefined || actionCount > 3) return null;
    const actions = [];
    for (let actionIndex = 0; actionIndex < actionCount; actionIndex += 1) {
      const verb = body[index++];
      const extremum = body[index++];
      const stat = body[index++];
      const side = body[index++];
      if ([verb, extremum, stat, side].some((value) => value === undefined)) return null;
      if (verb > 1 || extremum > 1 || stat > 2) return null;
      if (side !== 0 && side !== 1) return null;
      actions.push({ verb, extremum, stat, side });
    }
    elements.push({ movement, actions });
  }
  return index === body.length ? elements : null;
}

export function standardName(elements, standards) {
  const body = encodeBehavior(elements)?.join(",");
  if (!body) return "";
  return standards.find((item) => encodeBehavior(item.elements)?.join(",") === body)?.name || "";
}

// Short target words, by stat then extremum (lowest, highest).
const TARGET_WORDS = [
  ["nearest", "farthest"],
  ["weakest", "healthiest"],
  ["gentlest", "deadliest"],
];
const SIDE_WORDS = ["foe", "ally"];
const MOVE_WORDS = ["Approach", "Flee", "Flank left", "Flank right"];
const VERB_WORDS = ["attack", "cast"];

function targetWords(spec) {
  return `${TARGET_WORDS[spec.stat]?.[spec.extremum] ?? "?"} ${SIDE_WORDS[spec.side] ?? "?"}`;
}

/** `text` cut to `MAX_BEHAVIOR_NAME_LEN` characters at a word boundary, with an ellipsis. */
export function clipBehaviorName(text) {
  if (text.length <= MAX_BEHAVIOR_NAME_LEN) return text;
  let room = text.slice(0, MAX_BEHAVIOR_NAME_LEN - 1);
  // Mid-word: back up to the last space.
  if (/\w/.test(text[room.length]) && /\w$/.test(room)) {
    const cut = room.lastIndexOf(" ");
    if (cut > 0) room = room.slice(0, cut);
  }
  return `${room.replace(/[\s,·]+$/, "")}…`;
}

/**
 * A short name for a behavior: the standard's name when it is one, otherwise one phrase per
 * element, at most `MAX_BEHAVIOR_NAME_LEN` characters. The nearest foe is the default target and
 * is left out, a target is named once when the movement and the actions share it, and the stop
 * flag is left to `describeBehavior`. "Approach, attack · Wait" rather than the full description.
 */
export function nameBehavior(elements, standards) {
  const named = standardName(elements, standards);
  if (named) return clipBehaviorName(named);
  if (!elements.length) return "Empty";
  const isDefault = (spec) => spec.stat === 0 && spec.extremum === 0 && spec.side === 0;
  const same = (left, right) => left.stat === right.stat && left.extremum === right.extremum && left.side === right.side;
  const phrases = elements.map((element) => {
    const movement = element.movement;
    const parts = [];
    if (movement) parts.push(isDefault(movement) ? MOVE_WORDS[movement.kind] : `${MOVE_WORDS[movement.kind]} ${targetWords(movement)}`);
    if (element.actions.length) {
      const verbs = [...new Set(element.actions.map((action) => VERB_WORDS[action.verb]))].join(" & ");
      const first = element.actions[0];
      const shared = element.actions.every((action) => same(action, first));
      const implied = !shared || isDefault(first) || (movement && same(movement, first));
      const phrase = implied ? verbs : `${verbs} ${targetWords(first)}`;
      parts.push(movement ? phrase : phrase[0].toUpperCase() + phrase.slice(1));
    }
    return parts.join(", ") || "Wait";
  });
  return clipBehaviorName(phrases.join(" · "));
}

export function describeBehavior(elements, standards) {
  const named = standardName(elements, standards);
  if (named) return named;
  if (!elements.length) return "Empty";
  return elements.map((element) => {
    const parts = [];
    if (element.movement) {
      const movement = element.movement;
      const stop = movement.stop === 1 ? ", Stop if an action triggers" : "";
      parts.push(`${MOVE_KINDS[movement.kind]} ${EXTREMA[movement.extremum]} ${STATS[movement.stat]} ${SIDES[movement.side]}${stop}`);
    }
    for (const action of element.actions) {
      parts.push(`${VERBS[action.verb]} ${EXTREMA[action.extremum]} ${STATS[action.stat]} ${SIDES[action.side]}`);
    }
    return parts.join(", ") || "Wait";
  }).join(" · ");
}
