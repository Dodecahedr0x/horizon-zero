import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Board, type Piece } from "./board";
import { chronicle, cueFor, healthAt, HealthBar } from "./battleParts";
import { parseTraceLine } from "../../content/trace.mjs";
import { RACES, STANDARDS, behaviorLabel, describeBehavior, describeCast, encodeBehavior, unitSpec, type ActionSpec, type ElementSpec, type MovementSpec } from "./codec";
import type { Behavior, Match, MatchUnit } from "./devChain";
import { blockedTiles, randomSeed, simulateTrial } from "./replay";
import { play } from "./sfx";

// Icons: chunky round-capped strokes in the current text colour, 22px.
const ICONS: Record<string, ReactNode> = {
  stay: <><circle cx="12" cy="12" r="3.5" /><path d="M12 3v3M12 18v3M3 12h3M18 12h3" /></>,
  approach: <><path d="M3 12h12" /><path d="M11 7l5 5-5 5" /><circle cx="20" cy="12" r="1.8" /></>,
  flee: <><path d="M21 12H9" /><path d="M13 7l-5 5 5 5" /><circle cx="4" cy="12" r="1.8" /></>,
  flankLeft: <><path d="M19 19c0-8-4-12-12-12" /><path d="M11 3L7 7l4 4" /></>,
  flankRight: <><path d="M5 19c0-8 4-12 12-12" /><path d="M13 3l4 4-4 4" /></>,
  lowest: <path d="M6 9l6 6 6-6" />,
  highest: <path d="M6 15l6-6 6 6" />,
  distance: <><path d="M3 16h18" /><path d="M6 16v-4M10 16v-2M14 16v-4M18 16v-2" /></>,
  hp: <path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z" />,
  atk: <><path d="M14 4h6v6L9 21l-3-3L17 7" /><path d="M5 15l4 4" /></>,
  enemy: <path d="M12 3l9 9-9 9-9-9z" />,
  ally: <><path d="M12 3l9 9-9 9-9-9z" /><path d="M8.5 12l2.5 2.5 4.5-5" /></>,
  attack: <><path d="M14 4h6v6L9 21l-3-3L17 7" /><path d="M5 15l4 4" /></>,
  cast: <><path d="M12 3v5M12 16v5M3 12h5M16 12h5" /><path d="M6.5 6.5l3 3M14.5 14.5l3 3M17.5 6.5l-3 3M9.5 14.5l-3 3" /></>,
};

function Icon({ name }: { name: string }) {
  return (
    <svg className="opt__icon" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {ICONS[name]}
    </svg>
  );
}

type Option = { value: number; label: string; icon: string; tone?: "ally" | "foe" };

// A radio group drawn as icon pills. Real radio inputs, so keyboard and screen readers work as usual.
function Choice({ legend, options, value, onChange, compact, tiles }: { legend: string; options: Option[]; value: number; onChange: (value: number) => void; compact?: boolean; tiles?: boolean }) {
  const name = useId();
  return (
    <fieldset className={tiles ? "choice choice--tiles" : compact ? "choice choice--compact" : "choice"}>
      <legend className="choice__legend">{legend}</legend>
      <div className="choice__options">
        {options.map((option) => (
          <label key={option.value} className={option.tone ? `opt opt--${option.tone}` : "opt"}>
            <input type="radio" name={name} value={option.value} checked={value === option.value} onChange={() => onChange(option.value)} />
            <span className="opt__face"><Icon name={option.icon} /><span className="opt__label">{option.label}</span></span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

const MOVE_OPTIONS: Option[] = [
  { value: -1, label: "Stay", icon: "stay" },
  { value: 0, label: "Approach", icon: "approach" },
  { value: 1, label: "Flee", icon: "flee" },
  { value: 2, label: "Flank left", icon: "flankLeft" },
  { value: 3, label: "Flank right", icon: "flankRight" },
];
const EXTREMUM_OPTIONS: Option[] = [{ value: 0, label: "Lowest", icon: "lowest" }, { value: 1, label: "Highest", icon: "highest" }];
const STAT_OPTIONS: Option[] = [{ value: 0, label: "Distance", icon: "distance" }, { value: 1, label: "HP", icon: "hp" }, { value: 2, label: "ATK", icon: "atk" }];
const SIDE_OPTIONS: Option[] = [{ value: 0, label: "Enemy", icon: "enemy", tone: "foe" }, { value: 1, label: "Ally", icon: "ally", tone: "ally" }];
const VERB_OPTIONS: Option[] = [{ value: 0, label: "Attack", icon: "attack" }, { value: 1, label: "Cast", icon: "cast" }];

type Target = { extremum: number; stat: number; side: number };

function TargetPicker({ target, onChange }: { target: Target; onChange: (patch: Partial<Target>) => void }) {
  return (
    <div className="target">
      <Choice compact legend="Pick the" options={EXTREMUM_OPTIONS} value={target.extremum} onChange={(extremum) => onChange({ extremum })} />
      <Choice compact legend="By" options={STAT_OPTIONS} value={target.stat} onChange={(stat) => onChange({ stat })} />
      <Choice compact legend="Among" options={SIDE_OPTIONS} value={target.side} onChange={(side) => onChange({ side })} />
    </div>
  );
}

// "the nearest enemy", "the weakest ally", "the most dangerous enemy".
function targetWords(target: Target) {
  const adjectives = [["nearest", "farthest"], ["weakest", "healthiest"], ["least dangerous", "most dangerous"]];
  return `the ${adjectives[target.stat]?.[target.extremum] ?? "chosen"} ${target.side ? "ally" : "enemy"}`;
}

const MOVE_VERBS = ["approach", "flee from", "flank left of", "flank right of"];

export function elementSentence(element: ElementSpec) {
  const parts: string[] = [];
  if (element.movement) {
    parts.push(`${MOVE_VERBS[element.movement.kind]} ${targetWords(element.movement)}${element.movement.stop ? ", halting once an action lands" : ""}`);
  } else {
    parts.push("hold position");
  }
  for (const action of element.actions) parts.push(`${action.verb ? "cast at" : "attack"} ${targetWords(action)}`);
  if (!element.actions.length) parts.push("take no action");
  const text = parts.join(", then ");
  return text[0].toUpperCase() + text.slice(1) + ".";
}

function ElementCard({ index, element, onChange, onRemove }: { index: number; element: ElementSpec; onChange: (element: ElementSpec) => void; onRemove: () => void }) {
  const movement = element.movement;
  const setMovement = (patch: Partial<MovementSpec>) => movement && onChange({ ...element, movement: { ...movement, ...patch } });
  const setAction = (actionIndex: number, patch: Partial<ActionSpec>) => onChange({
    ...element,
    actions: element.actions.map((action, current) => (current === actionIndex ? { ...action, ...patch } : action)),
  });
  return (
    <div className="step">
      <div className="step__head">
        <span className="hz-section__num step__num">{index + 1}</span>
        <span className="step__title">Element {index + 1}</span>
        <button type="button" className="hz-button mini" aria-label={`Remove element ${index + 1}`} onClick={onRemove}>Remove</button>
      </div>
      <p className="element-sentence">{elementSentence(element)}</p>

      <Choice
        tiles
        legend="Move"
        options={MOVE_OPTIONS}
        value={movement ? movement.kind : -1}
        onChange={(kind) => onChange({
          ...element,
          movement: kind === -1 ? null : { kind, extremum: movement?.extremum ?? 0, stat: movement?.stat ?? 0, side: movement?.side ?? 0, stop: movement?.stop ?? 0 },
        })}
      />
      {movement && (
        <>
          <TargetPicker target={movement} onChange={setMovement} />
          <label className="toggle">
            <input type="checkbox" role="switch" checked={movement.stop === 1} onChange={(event) => setMovement({ stop: event.target.checked ? 1 : 0 })} />
            <span className="toggle__track" aria-hidden="true" />
            <span>Stop once an action lands</span>
          </label>
        </>
      )}

      {element.actions.map((action, actionIndex) => (
        <div className="action-row" key={actionIndex}>
          <div className="action-row__head">
            <Choice tiles legend={`Action ${actionIndex + 1}`} options={VERB_OPTIONS} value={action.verb} onChange={(verb) => setAction(actionIndex, { verb })} />
            <button type="button" className="hz-button mini" aria-label={`Remove action ${actionIndex + 1} of element ${index + 1}`} onClick={() => onChange({ ...element, actions: element.actions.filter((_, current) => current !== actionIndex) })}>Remove</button>
          </div>
          <TargetPicker target={action} onChange={(patch) => setAction(actionIndex, patch)} />
          {action.verb === 1 && <p className="action-row__note">Each soldier's cast knows whom it lands on: a foe, an ally, or itself. This target only picks among those, and a cast never wastes itself on a unit it would not change.</p>}
        </div>
      ))}
      <button type="button" className="hz-button mini" disabled={element.actions.length >= 3} onClick={() => onChange({ ...element, actions: [...element.actions, { verb: 0, extremum: 0, stat: 0, side: 0 }] })}>Add action</button>
    </div>
  );
}

function cloneElements(elements: ElementSpec[]): ElementSpec[] {
  return elements.map((element) => ({ movement: element.movement ? { ...element.movement } : null, actions: element.actions.map((action) => ({ ...action })) }));
}

// A skill is one move or one action a behavior can use. Stay is the absence of a move.
type Skill = { key: string; label: string; icon: string };
const SKILLS: Skill[] = [
  ...MOVE_OPTIONS.map((option) => ({ key: option.value === -1 ? "stay" : `move${option.value}`, label: option.label, icon: option.icon })),
  ...VERB_OPTIONS.map((option) => ({ key: `verb${option.value}`, label: option.label, icon: option.icon })),
];

function skillsOf(elements: ElementSpec[]) {
  const keys = new Set<string>();
  for (const element of elements) {
    keys.add(element.movement ? `move${element.movement.kind}` : "stay");
    for (const action of element.actions) keys.add(`verb${action.verb}`);
  }
  return keys;
}

// A move or an action with its target: what it does, then lowest/highest, the stat, and the side.
function Glyph({ icon, target }: { icon: string; target?: Target }) {
  return (
    <span className={target ? (target.side ? "glyph glyph--ally" : "glyph glyph--foe") : "glyph"}>
      <span className="glyph__verb"><Icon name={icon} /></span>
      {target && (
        <span className="glyph__target">
          <Icon name={EXTREMUM_OPTIONS[target.extremum].icon} />
          <Icon name={STAT_OPTIONS[target.stat].icon} />
          <Icon name={SIDE_OPTIONS[target.side ? 1 : 0].icon} />
        </span>
      )}
    </span>
  );
}

// One cell per element: the move, then each action. The card's tooltip carries the words.
function ElementGlyphs({ element, index }: { element: ElementSpec; index: number }) {
  const move = element.movement;
  return (
    <li className="glyphs__element">
      <span className="glyphs__num">{index + 1}</span>
      {move ? <Glyph icon={MOVE_OPTIONS[move.kind + 1].icon} target={move} /> : <Glyph icon="stay" />}
      {element.actions.map((action, actionIndex) => <Glyph key={actionIndex} icon={VERB_OPTIONS[action.verb].icon} target={action} />)}
    </li>
  );
}

/** A behavior as a compact strip of icons, one cell per element. */
export function BehaviorGlyphs({ elements, compact }: { elements: ElementSpec[]; compact?: boolean }) {
  return (
    <ol className={compact ? "glyphs glyphs--compact" : "glyphs"} aria-hidden="true">
      {elements.map((element, index) => <ElementGlyphs key={index} element={element} index={index} />)}
    </ol>
  );
}

function BehaviorCard({ behavior }: { behavior: Behavior }) {
  return (
    <article className="hz-frame behavior-card">
      <h3 className="hz-frame__title behavior-card__title" title={describeBehavior(behavior.elements)}>{behaviorLabel(behavior)}</h3>
      <BehaviorGlyphs elements={behavior.elements} />
      <ol className="behavior-card__steps">
        {behavior.elements.map((element, index) => <li key={index}>{elementSentence(element)}</li>)}
      </ol>
    </article>
  );
}

export function BehaviorList({ behaviors, onNew }: { behaviors: Behavior[]; onNew: () => void }) {
  const [filters, setFilters] = useState<string[]>([]);
  const indexed = useMemo(() => behaviors.map((behavior) => ({ behavior, skills: skillsOf(behavior.elements) })), [behaviors]);
  const shown = indexed.filter((item) => filters.every((key) => item.skills.has(key)));
  const toggle = (key: string) => setFilters((current) => (current.includes(key) ? current.filter((item) => item !== key) : [...current, key]));
  return (
    <>
      <button type="button" className="hz-button hz-button--primary hz-button--block" data-tour="behaviors" onClick={onNew}>
        <span className="hz-diamond hz-diamond--ember" />Forge a new behavior
      </button>
      <div className="skill-filter" role="group" aria-label="Filter by skill">
        <span className="choice__legend">Uses every skill</span>
        <div className="choice__options">
          {SKILLS.map((skill) => (
            <button key={skill.key} type="button" className="skill-chip" aria-pressed={filters.includes(skill.key)} onClick={() => toggle(skill.key)}>
              <Icon name={skill.icon} />{skill.label}
            </button>
          ))}
          {filters.length > 0 && <button type="button" className="hz-button mini" onClick={() => setFilters([])}>Clear</button>}
        </div>
        <p className="skill-filter__count" role="status">{shown.length} of {behaviors.length} behaviors</p>
      </div>
      <div className="grid">
        {shown.map(({ behavior }) => (
          <BehaviorCard key={behavior.pubkey} behavior={behavior} />
        ))}
        {!behaviors.length && <p className="hz-lore">No behaviors yet. Forge one above.</p>}
        {behaviors.length > 0 && !shown.length && <p className="hz-lore">No behavior uses all of those skills.</p>}
      </div>
    </>
  );
}

export function BehaviorEditor({ elements, onChange, onCreate }: { elements: ElementSpec[]; onChange: (elements: ElementSpec[]) => void; onCreate: () => void }) {
  const [trial, setTrial] = useState(false);
  const valid = elements.length > 0 && !!encodeBehavior(elements);
  return (
    <section className="hz-frame hz-frame--crest">
      <h3 className="hz-frame__title">Forge a behavior</h3>
      <p className="hz-frame__body">An ordered sequence. Each element may move once, then attack or cast.</p>
      <div className="presets" role="group" aria-label="Start from a standard behavior">
        {STANDARDS.map((standard) => (
          <button key={standard.name} type="button" className="preset" onClick={() => onChange(cloneElements(standard.elements))}>{standard.name}</button>
        ))}
      </div>
      {elements.map((element, index) => (
        <ElementCard
          key={index}
          index={index}
          element={element}
          onChange={(next) => onChange(elements.map((item, current) => (current === index ? next : item)))}
          onRemove={() => onChange(elements.filter((_, current) => current !== index))}
        />
      ))}
      <button type="button" className="hz-button" disabled={elements.length >= 4} onClick={() => onChange([...elements, { movement: null, actions: [] }])}>Add element</button>
      <p className="reads-as">Reads as <strong>{elements.length ? describeBehavior(elements) : "Nothing yet"}</strong></p>
      <button type="button" className="hz-button hz-button--block" disabled={!valid} onClick={() => setTrial(true)}>
        <span className="hz-diamond hz-diamond--ember" />Simulate
      </button>
      <button type="button" className="hz-button hz-button--primary hz-button--block" disabled={!valid} onClick={onCreate}>Create behavior</button>
      {trial && <TrialSheet elements={elements} onClose={() => setTrial(false)} />}
    </section>
  );
}

// The trial: one of your units runs the draft behavior against a training dummy that never moves or acts.
// The dummy is an Ashborn Warden whatever race the soldier comes from.
const TRIAL = { cols: 8, rows: 6, at: { col: 3, row: 0 }, dummyAt: { col: 4, row: 0 }, dummyRace: 0, dummyKind: 4 };
const DUMMY_BODY = encodeBehavior([{ movement: null, actions: [] }]) || [];

function trialUnit(race: number, kind: number, body: number[], at: { col: number; row: number }): MatchUnit {
  const spec = unitSpec(race, kind);
  return { kind, race, body, col: at.col, row: at.row, cost: spec?.cost, hp: spec?.hp, atk: spec?.atk, range: spec?.range, speed: spec?.speed, actions: spec?.actions, cast: spec?.cast };
}

// The first field keeps a clear lane between the two units, so the behavior is judged on its own.
async function openFieldSeed() {
  const lane = new Set([TRIAL.at.col, TRIAL.dummyAt.col]);
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const seed = randomSeed();
    const blocked = await blockedTiles(TRIAL.cols, TRIAL.rows, seed);
    if (!blocked.some((tile) => lane.has(tile.col))) return seed;
  }
  return randomSeed();
}

function TrialSheet({ elements, onClose }: { elements: ElementSpec[]; onClose: () => void }) {
  // Every race's units, so a behavior can be tried on any soldier; the Skirmisher is first picked.
  const units = RACES.flatMap((race) => race.units.map((unit) => ({ race: race.id, kind: unit.id, name: unit.name })));
  const [pick, setPick] = useState({ race: 0, kind: 1 });
  const [seed, setSeed] = useState("");
  const [lines, setLines] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [cursor, setCursor] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState(2);
  const controls = useRef<{ seek: (cursor: number) => void } | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();

  const a = useMemo(() => [trialUnit(pick.race, pick.kind, encodeBehavior(elements) || [], TRIAL.at)], [pick, elements]);
  const b = useMemo(() => [trialUnit(TRIAL.dummyRace, TRIAL.dummyKind, DUMMY_BODY, TRIAL.dummyAt)], []);
  const match = useMemo(() => ({ unitsA: a, unitsB: b, cols: TRIAL.cols, rows: TRIAL.rows, seed, outcome: 0 }) as unknown as Match, [a, b, seed]);

  useEffect(() => {
    let alive = true;
    openFieldSeed().then((first) => {
      if (alive) setSeed((current) => current || first);
    });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!seed) return;
    let alive = true;
    setLines([]);
    setCursor(0);
    simulateTrial({ cols: TRIAL.cols, rows: TRIAL.rows, a, b, seed }).then((result) => {
      if (!alive) return;
      setError(result.error);
      setLines(result.lines);
      setPlaying(true);
    });
    return () => {
      alive = false;
    };
  }, [a, b, seed]);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const entries = useMemo(() => chronicle(match, lines, 0, "training dummy"), [match, lines]);
  const health = useMemo(() => healthAt(match, lines, cursor), [match, lines, cursor]);
  const finished = lines.length > 0 && cursor >= lines.length;
  const dealt = lines.map(parseTraceLine).reduce((sum, step) => {
    const hitsDummy = (step.kind === "attack" || step.kind === "cast") && step.target.side === 1;
    return hitsDummy ? sum + step.damage : sum;
  }, 0);
  const rounds = lines.filter((line) => line === "R").length;
  const fell = lines.some((line) => line === "D 1 0");
  const spec = unitSpec(pick.race, pick.kind);
  const dummy = unitSpec(TRIAL.dummyRace, TRIAL.dummyKind);
  const swatch = (race: number, unitKind: number) => ({ "--swatch": `var(--unit-${unitSpec(race, unitKind)?.name.toLowerCase()})` }) as CSSProperties;

  return (
    <div className="sheet-backdrop" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="sheet" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="sheet__head">
          <h3 id={titleId} className="hz-frame__title">Trial run</h3>
          <button ref={closeRef} type="button" className="hz-button mini" onClick={onClose}>Close</button>
        </div>
        <p className="sheet__lede">Your soldier follows the draft behavior. The training dummy, a {dummy?.name}, never moves or attacks; with nothing else to do it may defend.</p>

        <fieldset className="choice">
          <legend className="choice__legend">Soldier</legend>
          <div className="choice__options">
            {units.map((unit) => (
              <label key={`${unit.race}:${unit.kind}`} className="opt opt--unit" style={swatch(unit.race, unit.kind)}>
                <input type="radio" name={`${titleId}-unit`} checked={pick.race === unit.race && pick.kind === unit.kind} onChange={() => setPick({ race: unit.race, kind: unit.kind })} />
                <span className="opt__face"><span className="opt__swatch" aria-hidden="true" /><span className="opt__label">{unit.name}</span></span>
              </label>
            ))}
          </div>
        </fieldset>

        {spec && <p className="sheet__lede trial-cast"><strong>{spec.name} cast.</strong> {describeCast(spec.cast)}.</p>}

        {error ? <p className="hz-error" role="alert">{error}</p> : !seed ? <p className="sheet__lede">Clearing a field…</p> : (
          <Board cols={TRIAL.cols} rows={TRIAL.rows} seed={seed} unitsA={a as Piece[]} unitsB={b as Piece[]} mySide={0} lines={lines} playing={playing} speed={speed} onProgress={setCursor} onImpact={(event) => { const cue = cueFor(event); if (cue) play(cue); }} controls={controls} />
        )}

        <div className="controls">
          {!finished && <button type="button" className="hz-button hz-button--primary" onClick={() => setPlaying((value) => !value)}>{playing ? "Pause" : "Play"}</button>}
          {finished && <button type="button" className="hz-button hz-button--primary" onClick={() => { controls.current?.seek(0); setPlaying(true); }}>Watch again</button>}
          <div className="speed" role="group" aria-label="Playback speed">
            {[1, 2, 3].map((value) => <button key={value} type="button" aria-pressed={speed === value} aria-label={`Speed ${value}`} onClick={() => setSpeed(value)}>{value}×</button>)}
          </div>
          <button type="button" className="hz-button mini" onClick={() => setSeed(randomSeed())}>New field</button>
        </div>

        <div className="sides">
          <section className="side" style={swatch(pick.race, pick.kind)}>
            <span className="side__name">{spec?.name}</span>
            <HealthBar hp={health[0]?.[0] ?? 0} max={spec?.hp || 0} foe={false} />
          </section>
          <section className="side" style={swatch(TRIAL.dummyRace, TRIAL.dummyKind)}>
            <span className="side__name">Training dummy</span>
            <HealthBar hp={health[1]?.[0] ?? 0} max={dummy?.hp || 0} foe />
          </section>
        </div>

        {finished && (
          <p className="notice" role="status">
            <span className="hz-diamond" />
            {fell
              ? `The dummy fell after ${rounds} ${rounds === 1 ? "round" : "rounds"}: ${dealt} damage dealt.`
              : dealt > 0
                ? `${dealt} damage dealt in ${rounds} ${rounds === 1 ? "round" : "rounds"}; the dummy still stands.`
                : `No blow landed in ${rounds} ${rounds === 1 ? "round" : "rounds"}. Check the movement and targets.`}
          </p>
        )}

        {entries.length > 0 && (
          <ol className="trace trace--trial">
            {entries.map((entry) => <li key={entry.index} className={`trace__${entry.kind}${entry.index < cursor ? " trace__done" : ""}`}>{entry.text}</li>)}
          </ol>
        )}
      </div>
    </div>
  );
}
