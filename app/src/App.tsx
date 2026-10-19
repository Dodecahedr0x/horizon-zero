import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { Board, type Piece } from "./board";
import { BATTLEGROUNDS, CANCEL_AFTER_SECS, RACES, STANDARDS, ZONE_DEPTH, behaviorLabel, cancellable, encodeBehavior, raceById, unitSpec, type ElementSpec } from "./codec";
import type { Army, Behavior, ChainAdapter, DraftUnit, Match, PlayerBalance, ProtocolConfig } from "./devChain";
import { randomSeed, replay, simulateTrial } from "./replay";
import { chronicle, cueFor, healthAt, HealthBar } from "./battleParts";
import { BehaviorEditor, BehaviorGlyphs, BehaviorList } from "./BehaviorEditor";
import { armyCost, isFull, matchUnit, MAX_UNITS, randomArmy } from "./armyRules";
import { Gem, GroundPicker, Select, UnitArt, swatch } from "./ui";
import { play, setSoundEnabled, soundEnabled } from "./sfx";
import { tourSteps, Walkthrough, walkthroughSeen } from "./Walkthrough";
import { AdminPanel, CreatePlayer, explain, WalletPanel, type Tone } from "./Wallet";

const devMode = import.meta.env.VITE_DEV_MODE === "true";
const SCREENS = ["battle", "army", "behaviors"] as const;
type Screen = (typeof SCREENS)[number];
const STATUS = ["Idle", "Queued", "Fighting"];

// An open fight: a stored match, or a simulation that is never stored.
type Arena = { match: Match; mySide: number; lines: string[]; simulated: boolean };

function behaviorName(behaviors: Behavior[], key: string) {
  const behavior = behaviors.find((item) => item.pubkey === key);
  return behavior ? behaviorLabel(behavior) : "Unknown behavior";
}

function cloneElements(elements: ElementSpec[]): ElementSpec[] {
  return elements.map((element) => ({
    movement: element.movement ? { ...element.movement } : null,
    actions: element.actions.map((action) => ({ ...action })),
  }));
}

function groundOf(match: Pick<Match, "cols" | "rows">) {
  return BATTLEGROUNDS.find((item) => item.cols === match.cols && item.rows === match.rows);
}

function outcomeFor(match: Match, side: number) {
  if (match.status === 3) return "cancelled";
  if (match.status === 0 || !match.outcome) return "pending";
  if (match.outcome === 3) return "draw";
  return match.outcome === side + 1 ? "victory" : "defeat";
}

const OUTCOME_LABEL: Record<string, string> = { victory: "Victory", defeat: "Defeat", draw: "Draw", pending: "Awaiting the seed", cancelled: "Cancelled" };
const CANCEL_TITLE = `The seed never came. ${CANCEL_AFTER_SECS / 60} minutes after the battle opened anyone may cancel it: both stakes go back to their budgets and both armies come home.`;

function Section({ title, aside, children, tour }: { title: string; aside?: ReactNode; children: ReactNode; tour?: string }) {
  return (
    <section className="panel" data-tour={tour}>
      <header className="panel__head">
        <h2 className="panel__title">{title}</h2>
        {aside}
      </header>
      {children}
    </section>
  );
}

function ArmyCard({ army, budget, behaviors, actions }: { army: Army; budget: number; behaviors: Behavior[]; actions: ReactNode }) {
  const cost = armyCost(army.race, army.units);
  const full = isFull(army.race, army.units, budget);
  return (
    <article className={army.status === 1 ? "army is-queued" : "army"}>
      <header className="army__head">
        <h3 className="army__title">{raceById(army.race)?.name || "Race"} host <small>#{army.index}</small></h3>
        <span className={`status status--${STATUS[army.status]?.toLowerCase() || "idle"}`}>{STATUS[army.status] || "Idle"}</span>
      </header>
      <ul className="army__units">
        {army.units.map((unit, index) => (
          <li key={index} title={`${unitSpec(army.race, unit.kind)?.name} · ${behaviorName(behaviors, unit.behavior)} · tile ${unit.col},${unit.row}`}>
            <UnitArt race={army.race} kind={unit.kind} />
            <span className="army__unit-name">{unitSpec(army.race, unit.kind)?.name}</span>
          </li>
        ))}
      </ul>
      <p className="army__meta">{cost} / {budget} budget{full ? "" : " · not full"}</p>
      <div className="army__actions">{actions}</div>
    </article>
  );
}

export function App({ chain, connected, wallet, identity }: { chain: ChainAdapter; connected: boolean; wallet?: ReactNode; identity?: string }) {
  const [screen, setScreen] = useState<Screen>("battle");
  const [owner, setOwner] = useState("");
  const [behaviors, setBehaviors] = useState<Behavior[]>([]);
  const [armies, setArmies] = useState<Army[]>([]);
  const [matches, setMatches] = useState<Match[]>([]);
  const [forging, setForging] = useState(false);
  const [draftElements, setDraftElements] = useState<ElementSpec[]>(() => cloneElements(STANDARDS[0].elements));
  const [battlegroundId, setBattlegroundId] = useState(0);
  const [raceId, setRaceId] = useState(RACES[0]?.id ?? 0);
  const [kind, setKind] = useState(RACES[0]?.units[0]?.id ?? 0);
  const [behaviorKey, setBehaviorKey] = useState("");
  // One draft per league and race: switching race keeps the army you were building and shows the other race's.
  const [drafts, setDrafts] = useState<Record<string, DraftUnit[]>>({});
  const [selected, setSelected] = useState<number | null>(null);
  const [locked, setLocked] = useState<Record<number, number>>({});
  // A soldier being dragged to another tile of the zone: where the pointer is, and the tile under it.
  const [drag, setDrag] = useState<{ index: number; x: number; y: number; over: { col: number; row: number } | null } | null>(null);
  const press = useRef<{ index: number; pointer: number; x: number; y: number; moved: boolean } | null>(null);
  const swallowClick = useRef(false);
  const [arena, setArena] = useState<Arena | null>(null);
  const [cursor, setCursor] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(2);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [sound, setSound] = useState(soundEnabled);
  const [touring, setTouring] = useState(false);
  const [doomed, setDoomed] = useState("");
  const [busy, setBusy] = useState(false);
  // The clock the battle log compares open times with, to offer Cancel once a seed is overdue.
  const [now, setNow] = useState(() => Date.now());
  // undefined until the first read; null when the wallet has no Player yet.
  const [player, setPlayer] = useState<PlayerBalance | null | undefined>(undefined);
  const [config, setConfig] = useState<ProtocolConfig | null>(null);
  const boardControls = useRef<{ seek: (cursor: number) => void } | null>(null);
  const traceRef = useRef<HTMLOListElement>(null);
  const ground = BATTLEGROUNDS[battlegroundId];
  const race = raceById(raceId);
  const kinds = race?.units ?? [];
  const draftKey = `${battlegroundId}:${raceId}`;
  const draft = drafts[draftKey] ?? [];
  const cost = armyCost(raceId, draft);
  const full = isFull(raceId, draft, ground.budget);
  const cheapest = Math.min(...kinds.map((item) => item.cost));
  const match = arena?.match ?? null;
  const mySide = arena?.mySide ?? 0;
  const lines = arena?.lines ?? [];

  function setDraft(units: DraftUnit[]) {
    setDrafts((current) => ({ ...current, [draftKey]: units }));
  }

  // A read started for one wallet or backend must not land after the page has moved to another.
  const chainNow = useRef(chain);
  chainNow.current = chain;

  async function refresh() {
    const at = chain;
    const me = await chain.owner();
    if (chainNow.current !== at) return;
    setOwner(me);
    const known = await chain.behaviors();
    if (chainNow.current !== at) return;
    setBehaviors(known);
    setBehaviorKey((current) => current || known[0]?.pubkey || "");
    const [mine, fought] = await Promise.all([chain.armies(me), chain.matches(me).catch(() => [] as Match[])]);
    if (chainNow.current !== at) return;
    setArmies(mine);
    setMatches(fought);
    await Promise.all([refreshLocked(), refreshPlayer()]);
  }

  // A failed read leaves the Player unknown (not "no Player"), so nothing offers to register again.
  async function refreshPlayer() {
    try {
      const at = chain;
      const [mine, protocol] = await Promise.all([chain.player(), chain.admin().catch(() => null)]);
      if (chainNow.current !== at) return;
      setPlayer(mine);
      setConfig(protocol);
    } catch (err) {
      if (chainNow.current !== chain) return;
      setPlayer(undefined);
      setConfig(null);
      throw new Error(`Your player could not be read: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Armies locked and waiting in each battleground's queue, from every player.
  async function refreshLocked() {
    const at = chain;
    const grounds = await chain.battlegrounds();
    if (chainNow.current !== at) return;
    setLocked(Object.fromEntries(grounds.map((ground) => [ground.battlegroundId, ground.queue.length])));
  }

  useEffect(() => {
    // Another wallet or backend: forget the last one's Player, Config and identity before reading.
    setOwner("");
    setPlayer(undefined);
    setConfig(null);
    if (connected) refresh().catch((err) => chainNow.current === chain && setError(err.message));
  }, [connected, chain]);

  // Other players lock and match too; keep the counts current while the page is open.
  useEffect(() => {
    if (!connected) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") refreshLocked().catch(() => {});
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [connected, chain]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [forging, screen]);

  // The first time a player connects on this browser, walk them through the screens.
  useEffect(() => {
    if (connected && !walkthroughSeen()) setTouring(true);
  }, [connected]);

  function startTour() {
    setForging(false);
    setTouring(true);
  }

  // A pending or recovered result is not a failure: it reads as a notice, and the page still refreshes.
  function report(err: unknown) {
    const outcome = explain(err);
    if (outcome.tone === "error") {
      setNotice("");
      setError(outcome.text);
    } else {
      setNotice(outcome.text);
    }
    return outcome;
  }

  /**
   * Runs one action, then refreshes. Returns how the action ended; a refresh that fails afterwards
   * does not turn a landed action into a failure.
   */
  async function run(action: () => Promise<void>): Promise<Tone> {
    setError("");
    setNotice("");
    setBusy(true);
    try {
      let tone: Tone = "success";
      try {
        await action();
      } catch (err) {
        tone = report(err).tone;
        if (tone === "error") return tone;
      }
      try {
        await refresh();
      } catch {
        setNotice((current) => (current ? `${current} The balances could not be refreshed.` : "Done; the balances could not be refreshed."));
      }
      return tone;
    } finally {
      setBusy(false);
    }
  }

  async function release(which: "player" | "treasury") {
    const what = which === "player" ? "withdrawal" : "fee claim";
    await run(async () => {
      const result = await chain.releasePending(which);
      setNotice(result === "paid" ? `The pending ${what} has been paid to your wallet.` : result === "inFlight" ? `The ${what} is still on its way. Release it again in a moment.` : `No ${what} was waiting to be paid.`);
    });
  }

  function selectUnit(index: number | null) {
    setSelected(index);
    if (index === null) return;
    // The controls show the selected soldier, so changing them edits it.
    setKind(draft[index].kind);
    setBehaviorKey(draft[index].behavior);
  }

  function place(col: number, row: number) {
    if (swallowClick.current) {
      swallowClick.current = false;
      return;
    }
    const occupied = draft.findIndex((unit) => unit.col === col && unit.row === row);
    if (occupied !== -1) {
      selectUnit(occupied === selected ? null : occupied);
      setError("");
      return;
    }
    if (selected !== null) {
      setDraft(draft.map((unit, index) => (index === selected ? { ...unit, col, row } : unit)));
      setError("");
      return;
    }
    if (!behaviors.length || !behaviorKey) {
      setError("Create a behavior first");
      return;
    }
    if (draft.length >= MAX_UNITS) {
      setError(`An army can have at most ${MAX_UNITS} units`);
      return;
    }
    if (cost + (unitSpec(raceId, kind)?.cost || 0) > ground.budget) {
      setError("Army cost exceeds the battleground budget");
      return;
    }
    setDraft([...draft, { kind, behavior: behaviorKey, col, row }]);
    setError("");
  }

  /** Moves a soldier to a tile; a soldier already there takes the moved one's old tile. */
  function moveUnit(index: number, col: number, row: number) {
    const from = draft[index];
    if (!from || (from.col === col && from.row === row)) return;
    const other = draft.findIndex((unit) => unit.col === col && unit.row === row);
    setDraft(draft.map((unit, i) => (i === index ? { ...unit, col, row } : i === other ? { ...unit, col: from.col, row: from.row } : unit)));
    setError("");
  }

  function tileAt(x: number, y: number) {
    const tile = document.elementFromPoint(x, y)?.closest<HTMLElement>(".zone .tile");
    if (!tile?.dataset.col || !tile.dataset.row) return null;
    return { col: Number(tile.dataset.col), row: Number(tile.dataset.row) };
  }

  function startDrag(event: ReactPointerEvent<HTMLButtonElement>, index: number) {
    if (event.button !== 0) return;
    press.current = { index, pointer: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    const held = press.current;
    if (!held || held.pointer !== event.pointerId) return;
    // A few pixels of slack so a tap with a shaky finger stays a tap.
    if (!held.moved && Math.hypot(event.clientX - held.x, event.clientY - held.y) < 6) return;
    held.moved = true;
    setDrag({ index: held.index, x: event.clientX, y: event.clientY, over: tileAt(event.clientX, event.clientY) });
  }

  function endDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    const held = press.current;
    if (!held || held.pointer !== event.pointerId) return;
    press.current = null;
    setDrag(null);
    if (!held.moved) return;
    // The drop ends with a click on the pressed tile; it must not also select or place.
    swallowClick.current = true;
    const target = event.type === "pointerup" ? tileAt(event.clientX, event.clientY) : null;
    if (target) moveUnit(held.index, target.col, target.row);
  }

  function pickKind(id: number) {
    setKind(id);
    if (selected === null) return;
    const next = cost - (unitSpec(raceId, draft[selected].kind)?.cost || 0) + (unitSpec(raceId, id)?.cost || 0);
    if (next > ground.budget) {
      setError("Army cost exceeds the battleground budget");
      return;
    }
    setError("");
    setDraft(draft.map((unit, index) => (index === selected ? { ...unit, kind: id } : unit)));
  }

  function pickBehavior(key: string) {
    setBehaviorKey(key);
    if (selected !== null) setDraft(draft.map((unit, index) => (index === selected ? { ...unit, behavior: key } : unit)));
  }

  function pickBattleground(id: number) {
    setBattlegroundId(id);
    setSelected(null);
    setDoomed("");
  }

  function pickRace(id: number) {
    setRaceId(id);
    setKind(raceById(id)?.units[0]?.id ?? 0);
    setSelected(null);
  }

  function removeUnit(index: number) {
    setDraft(draft.filter((_, i) => i !== index));
    setSelected(null);
  }

  function copyToMuster(army: Army) {
    setRaceId(army.race);
    setDrafts((current) => ({ ...current, [`${army.battlegroundId}:${army.race}`]: army.units.map(({ kind: unitKind, behavior, col, row }) => ({ kind: unitKind, behavior, col, row })) }));
    setBattlegroundId(army.battlegroundId);
    setSelected(null);
    setNotice("The army is copied into the muster. Saving makes a new army.");
  }

  function openArena(next: Arena) {
    setArena(next);
    setCursor(0);
    setScreen("battle");
    setPlaying(true);
  }

  async function watch(item: Match) {
    setError("");
    try {
      const traced = await replay(item);
      openArena({ match: item, mySide: item.playerA === owner ? 0 : 1, lines: traced, simulated: false });
    } catch (err) {
      setError(err instanceof Error ? err.message : "The replay failed");
    }
  }

  async function simulate() {
    setError("");
    const body = (key: string) => encodeBehavior(behaviors.find((item) => item.pubkey === key)?.elements ?? []) || [];
    const mine = draft.map((unit) => matchUnit(raceId, unit.kind, body(unit.behavior), unit.col, unit.row));
    const foeRace = RACES[crypto.getRandomValues(new Uint8Array(1))[0] % RACES.length]?.id ?? raceId;
    const foe = randomArmy(foeRace, ground.budget, ground.cols);
    const seed = randomSeed();
    const result = await simulateTrial({ cols: ground.cols, rows: ground.rows, a: mine, b: foe, seed });
    if (result.error) {
      setError(result.error);
      return;
    }
    const outcome = result.winner === 0 ? 1 : result.winner === 1 ? 2 : 3;
    const simulated = { pubkey: "simulation", unitsA: mine, unitsB: foe, cols: ground.cols, rows: ground.rows, seed, outcome, status: 1, stake: "0" } as unknown as Match;
    play("defend");
    openArena({ match: simulated, mySide: 0, lines: result.lines, simulated: true });
  }

  async function lock(army: Army) {
    await run(async () => {
      // On chain a lock that finds a foe waits for the VRF seed and settles before it returns.
      if (!devMode) setNotice("Locking. If a foe is waiting, the battle waits for its seed and settles; this can take up to a minute.");
      const opened = await chain.lock(army);
      if (!opened) {
        setNotice(`Your host waits at the gate of the ${BATTLEGROUNDS[army.battlegroundId]?.name}. The battle opens when a foe locks there.`);
        return;
      }
      if (opened.status !== 1 || !opened.outcome) {
        setNotice("The battle is open and still waiting for its seed or its settlement. It is in the battle log; settle or watch it from there once the seed lands.");
        return;
      }
      setNotice("");
      play("defend");
      openArena({ match: opened, mySide: opened.armyA === army.pubkey ? 0 : 1, lines: await replay(opened), simulated: false });
    });
  }

  async function closeArmy(army: Army) {
    setDoomed("");
    await run(async () => {
      await chain.closeArmy(army);
      setNotice("The army is disbanded.");
    });
  }

  const pieces = useMemo(() => ({ a: (match?.unitsA || []) as Piece[], b: (match?.unitsB || []) as Piece[] }), [match]);
  const health = useMemo(() => (match ? healthAt(match, lines, cursor) : [[], []]), [match, lines, cursor]);
  const finished = !!match && lines.length > 0 && cursor >= lines.length;
  const result = match ? outcomeFor(match, mySide) : "";
  const resultGround = match ? groundOf(match)?.name : "";
  const entries = useMemo(() => (match ? chronicle(match, lines, mySide) : []), [match, lines, mySide]);
  const survivors = match ? (mySide === 0 ? match.unitsA : match.unitsB).map((unit, index) => ({
    index,
    race: unit.race || 0,
    kind: unit.kind,
    name: unitSpec(unit.race || 0, unit.kind)?.name || "Soldier",
    hp: health[mySide]?.[index] ?? 0,
    max: unit.hp || unitSpec(unit.race || 0, unit.kind)?.hp || 0,
  })).filter((item) => item.hp > 0) : [];

  const groundArmies = armies.filter((army) => army.battlegroundId === battlegroundId);
  const ready = groundArmies.filter((army) => isFull(army.race, army.units, ground.budget));
  const unfinished = groundArmies.length - ready.length;
  const readyCounts = Object.fromEntries(BATTLEGROUNDS.map((item) => [item.id, armies.filter((army) => army.battlegroundId === item.id && isFull(army.race, army.units, item.budget)).length]));
  const behaviorOptions = behaviors.map((behavior) => ({
    value: behavior.pubkey,
    label: behaviorLabel(behavior),
    detail: <BehaviorGlyphs compact elements={behavior.elements} />,
  }));

  // Keep the newest chronicle line in view inside the log, without scrolling the page.
  useEffect(() => {
    const list = traceRef.current;
    const current = list?.querySelector<HTMLElement>(".trace__now");
    if (!list || !current) return;
    const top = current.offsetTop - list.offsetTop;
    if (top < list.scrollTop || top + current.offsetHeight > list.scrollTop + list.clientHeight) {
      list.scrollTop = Math.max(0, top - list.clientHeight / 2);
    }
  }, [cursor]);

  // When the last line lands: stop, and sound the outcome.
  const wasFinished = useRef(false);
  useEffect(() => {
    if (finished && !wasFinished.current) {
      setPlaying(false);
      if (result === "victory" || result === "defeat" || result === "draw") play(result);
    }
    wasFinished.current = finished;
  }, [finished, result]);

  function deleteControls(army: Army) {
    if (doomed === army.pubkey) {
      return (
        <span className="confirm" role="group" aria-label="Confirm delete">
          <span>Disband for good?</span>
          <button type="button" className="hz-button mini danger" disabled={busy} onClick={() => closeArmy(army)}>Delete</button>
          <button type="button" className="hz-button mini" onClick={() => setDoomed("")}>Keep</button>
        </span>
      );
    }
    return (
      <button type="button" className="hz-button mini quiet" disabled={army.status !== 0} title={army.status !== 0 ? "Unlock the army first" : undefined} onClick={() => setDoomed(army.pubkey)}>Delete</button>
    );
  }

  const selectedUnit = selected !== null ? draft[selected] : null;
  const canStake = !!player && BigInt(player.budget) >= BigInt(ground.stake);
  const needsPlayer = player === null ? "Create your player on the Battle tab first" : player === undefined ? "Loading your player" : undefined;

  return (
    <div className="hz-root shell">
      <div className="horizon" aria-hidden="true" />
      <header className="masthead">
        <span className="mark"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5 14.5 8 8 14.5 1.5 8Z" /></svg>Horizon Zero</span>
        <nav className="tabs" data-tour="tabs" role="tablist" aria-label="Screens">
          {SCREENS.map((item) => (
            <button key={item} type="button" role="tab" className="tab" aria-selected={screen === item} onClick={() => { setScreen(item); setForging(false); }}>{item}</button>
          ))}
        </nav>
        <div className="masthead__end">
          {devMode && <span className="dev-tag" title="No Solana node is connected">Dev</span>}
          {identity && <span className="local-id" data-local-user={identity}>{identity}</span>}
          <button type="button" className="hz-button mini quiet" onClick={startTour}>Guide</button>
          {wallet && <div className="wallet">{wallet}</div>}
        </div>
      </header>

      <main className="screen">
        {error && <p className="hz-error" role="alert">{error}</p>}
        {notice && !error && <p className="notice" role="status"><span className="hz-diamond" />{notice}</p>}

        {screen === "battle" && (
          <>
            {match && (
              <section className="arena" aria-labelledby="arena-title">
                <header className="arena__head">
                  <div>
                    <p className="kicker">{arena?.simulated ? "Simulation · not staked" : `${resultGround} · seed ${match.seed.slice(0, 4)}…${match.seed.slice(-4)}`}</p>
                    <h2 id="arena-title" className="arena__title">{arena?.simulated ? "Against a random army" : `The ${resultGround}`}</h2>
                  </div>
                  <button type="button" className="hz-button mini quiet" onClick={() => { setArena(null); setPlaying(false); }}>Leave the field</button>
                </header>
                <Board cols={match.cols} rows={match.rows} seed={match.seed} unitsA={pieces.a} unitsB={pieces.b} mySide={mySide} lines={lines} playing={playing} speed={speed} onProgress={setCursor} onImpact={(event) => { const cue = cueFor(event); if (cue) play(cue); }} controls={boardControls} />
                <div className="controls">
                  {!finished && <button type="button" className="hz-button hz-button--primary" onClick={() => setPlaying((value) => !value)}>{playing ? "Pause" : cursor > 0 ? "Resume" : "Play"}</button>}
                  {finished && <button type="button" className="hz-button hz-button--primary" onClick={() => { boardControls.current?.seek(0); setPlaying(true); }}>Watch again</button>}
                  <div className="speed" role="group" aria-label="Playback speed">
                    {[1, 2, 3].map((value) => (
                      <button key={value} type="button" aria-pressed={speed === value} aria-label={`Speed ${value}`} onClick={() => setSpeed(value)}>{value}×</button>
                    ))}
                  </div>
                  {!finished && <button type="button" className="hz-button mini quiet" onClick={() => { boardControls.current?.seek(lines.length); setPlaying(false); }}>Skip to the end</button>}
                  <button type="button" className="hz-button mini quiet sound" aria-pressed={sound} onClick={() => { setSoundEnabled(!sound); setSound(!sound); }}>{sound ? "Sound on" : "Sound off"}</button>
                </div>
                {finished && (result === "victory" || result === "defeat" || result === "draw") && (
                  <section className={`decree decree--${result}`} aria-labelledby="decree-title">
                    <h3 id="decree-title" className="decree__title">{OUTCOME_LABEL[result]}</h3>
                    <p>{result === "victory" ? "Your host holds the field." : result === "defeat" ? "Your host has fallen." : "Neither host could break the other."}</p>
                    {survivors.length > 0 && (
                      <ul className="chips">
                        {survivors.map((item) => <li key={item.index} className="chip" style={swatch(item.race, item.kind)}>{item.name} <small>{item.hp}/{item.max}</small></li>)}
                      </ul>
                    )}
                    {!arena?.simulated && <small>Stake {Number(match.stake) / 1e9} SOL</small>}
                    {arena?.simulated && <button type="button" className="hz-button" onClick={() => { setArena(null); setPlaying(false); setScreen("army"); }}>Back to the muster</button>}
                  </section>
                )}
                <div className="sides">
                  {[mySide, 1 - mySide].map((side) => (
                    <section key={side} className="side">
                      <h3 className="side__title">{side === mySide ? "Your host" : arena?.simulated ? "Random army" : "The foe"}</h3>
                      {(side === 0 ? match.unitsA : match.unitsB).map((unit, index) => (
                        <div key={index} className="side__unit">
                          <UnitArt race={unit.race || 0} kind={unit.kind} className={(health[side][index] ?? 0) > 0 ? "" : "is-dead"} />
                          <span className={(health[side][index] ?? 0) > 0 ? "side__name" : "side__name is-dead"}>{unitSpec(unit.race || 0, unit.kind)?.name}</span>
                          <HealthBar hp={health[side][index] ?? 0} max={unit.hp || unitSpec(unit.race || 0, unit.kind)?.hp || 0} foe={side !== mySide} />
                        </div>
                      ))}
                    </section>
                  ))}
                </div>
                {entries.length > 0 && (
                  <ol className="trace" ref={traceRef} aria-label="Chronicle">
                    {entries.map((entry) => (
                      <li key={entry.index} className={`trace__${entry.kind}${entry.index < cursor ? " trace__done" : ""}${entry.index === cursor - 1 ? " trace__now" : ""}`}>{entry.text}</li>
                    ))}
                  </ol>
                )}
              </section>
            )}

            <Section title="Latest battles" tour="log" aside={<span className="panel__count">{matches.length}</span>}>
              <ol className="log" aria-label="Latest battles">
                {matches.map((item) => {
                  const side = item.playerA === owner ? 0 : 1;
                  const outcome = outcomeFor(item, side);
                  const mine = side === 0 ? item.unitsA : item.unitsB;
                  const theirs = side === 0 ? item.unitsB : item.unitsA;
                  return (
                    <li key={item.pubkey} className={`log__row log__row--${outcome}`}>
                      <span className="log__outcome">{item.status === 2 ? "Ready to settle" : OUTCOME_LABEL[outcome]}</span>
                      <span className="log__ground">{groundOf(item)?.name || `${item.cols}×${item.rows}`}</span>
                      <span className="log__armies">
                        <span className="log__side">{mine.map((unit, index) => <UnitArt key={index} race={unit.race || 0} kind={unit.kind} />)}</span>
                        <span className="log__vs">vs</span>
                        <span className="log__side">{theirs.map((unit, index) => <UnitArt key={index} race={unit.race || 0} kind={unit.kind} />)}</span>
                      </span>
                      {item.status === 2
                        ? <button type="button" className="hz-button mini" disabled={busy} title="The seed has landed; settle the battle to pay the stakes" onClick={() => run(() => chain.settle(item))}>Settle</button>
                        : !devMode && cancellable(item, Math.floor(now / 1000))
                          ? <button type="button" className="hz-button mini" disabled={busy} title={CANCEL_TITLE} aria-label={`Cancel: ${CANCEL_TITLE}`} onClick={() => run(async () => { await chain.cancel(item); setNotice("The battle is cancelled. Both stakes are back in their budgets."); })}>Cancel</button>
                          : <button type="button" className="hz-button mini quiet" disabled={outcome === "pending" || outcome === "cancelled"} onClick={() => watch(item)}>Watch</button>}
                    </li>
                  );
                })}
                {!matches.length && <li className="log__empty">No battle yet. Lock a full army below; the fight opens when a foe locks on the same battleground.</li>}
              </ol>
            </Section>

            {player === undefined && connected && (
              <Section title="Wallet">
                <p className="panel__note">Loading your player.</p>
              </Section>
            )}
            {player === null && (
              <Section title="Create your player">
                <CreatePlayer busy={busy} fees={!devMode} onRegister={(lamports) => run(async () => { await chain.register(lamports); setNotice("Your player is ready. Fund your budget to lock an army."); })} />
              </Section>
            )}
            {player && (
              <Section title="Wallet">
                <WalletPanel
                  player={player}
                  stake={Number(ground.stake)}
                  groundName={ground.name}
                  busy={busy}
                  fees={!devMode}
                  onTopUp={(lamports) => run(() => chain.topUp(lamports))}
                  onFund={(lamports) => run(() => chain.fundBudget(lamports))}
                  onWithdraw={(lamports) => run(async () => { await chain.withdraw(lamports); setNotice("The withdrawal has been paid to your wallet."); })}
                  onRelease={() => release("player")}
                  onSegregate={(segregate) => run(() => chain.setSegregation(segregate))}
                />
              </Section>
            )}

            <Section
              title="Your armies"
              tour="armies"
              aside={<button type="button" className="hz-button hz-button--primary" data-tour="create" onClick={() => { setScreen("army"); setSelected(null); }}>Create an army</button>}
            >
              <GroundPicker value={battlegroundId} onChange={pickBattleground} counts={readyCounts} locked={locked} />
              <div className="armies">
                {ready.map((army) => (
                  <ArmyCard
                    key={army.pubkey}
                    army={army}
                    budget={ground.budget}
                    behaviors={behaviors}
                    actions={(
                      <>
                        {army.status === 1
                          ? <button type="button" className="hz-button" disabled={busy} onClick={() => run(() => chain.unlock(army))}>Unlock</button>
                          : <button type="button" className="hz-button hz-button--primary" disabled={busy || army.status !== 0 || !canStake} title={needsPlayer ?? (!canStake ? "Your budget must cover one stake" : undefined)} onClick={() => lock(army)}><span className="hz-diamond hz-diamond--ember" />Lock · {ground.stake / 1e9} SOL</button>}
                        {deleteControls(army)}
                      </>
                    )}
                  />
                ))}
                {!ready.length && <p className="empty">No full army for the {ground.name} yet. An army is ready once its budget is spent or nothing more fits.</p>}
              </div>
              {unfinished > 0 && <p className="panel__note">{unfinished} unfinished {unfinished === 1 ? "army waits" : "armies wait"} in the Army tab.</p>}
            </Section>

            {config && owner && config.admin === owner && (
              <Section title="Protocol fees">
                <AdminPanel
                  config={config}
                  busy={busy}
                  treasury={!devMode}
                  onSetFee={(bps) => run(async () => { await chain.setFee(bps); setNotice(`The fee is now ${bps} bps for battles opened from here on.`); })}
                  onClaim={() => run(async () => { await chain.claimFees(); setNotice("The fees have been paid to the admin wallet."); })}
                  onRelease={() => release("treasury")}
                />
              </Section>
            )}
          </>
        )}

        {screen === "army" && (
          <>
            <Section title="Muster" tour="muster" aside={<span className={cost > ground.budget ? "tally over" : full ? "tally is-full" : "tally"}>{cost}<small> / {ground.budget}</small></span>}>
              <GroundPicker value={battlegroundId} onChange={pickBattleground} locked={locked} />
              <div className="budget" role="meter" aria-label="Cost against budget" aria-valuemin={0} aria-valuemax={ground.budget} aria-valuenow={cost} style={{ gridTemplateColumns: `repeat(${ground.budget}, minmax(0, 1fr))` }}>
                {Array.from({ length: ground.budget }, (_, index) => <i key={index} className={index < cost ? "on" : ""} />)}
              </div>
              <div className="fields">
                <Select label="Race" value={raceId} options={RACES.map((item) => ({ value: item.id, label: item.name }))} onChange={pickRace} />
                <Select label={selectedUnit ? "Behavior of the selected soldier" : "Behavior"} value={behaviorKey} options={behaviorOptions} onChange={pickBehavior} placeholder="Forge a behavior first" />
              </div>
              <p className="caption">{selectedUnit ? "Change the selected soldier" : "Pick a soldier"}</p>
              <div className="tray" role="group" aria-label="Soldier">
                {kinds.map((item) => {
                  const base = selectedUnit ? cost - (unitSpec(raceId, selectedUnit.kind)?.cost || 0) : cost;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      className="pick"
                      style={swatch(raceId, item.id)}
                      aria-pressed={item.id === kind}
                      aria-label={`${item.name}, cost ${item.cost}, ${item.hp} HP, attack ${item.atk}, range ${item.range}, speed ${item.speed}`}
                      disabled={base + item.cost > ground.budget && item.id !== kind}
                      onClick={() => pickKind(item.id)}
                    >
                      <UnitArt race={raceId} kind={item.id} className="pick__art" />
                      <Gem value={item.cost} />
                      <span className="pick__name">{item.name}</span>
                      <span className="pick__stat">HP {item.hp} · Atk {item.atk} · Rng {item.range} · Spd {item.speed}</span>
                    </button>
                  );
                })}
              </div>
              <p className="panel__note">Your zone is the back two rows of the {ground.name}. Tap an empty tile to place the soldier. Drag a placed soldier to another tile to move it, or onto another soldier to swap them. Tap a placed soldier to change its type or behavior.</p>
              <div className="zone" style={{ gridTemplateColumns: `repeat(${ground.cols}, minmax(0, 1fr))` }} data-zone={`${ground.cols}x${ZONE_DEPTH}`}>
                {Array.from({ length: ZONE_DEPTH }, (_, row) => Array.from({ length: ground.cols }, (_, col) => {
                  const index = draft.findIndex((unit) => unit.col === col && unit.row === row);
                  const unit = index === -1 ? null : draft[index];
                  const classes = ["tile"];
                  if (unit) classes.push("filled");
                  if (index === selected) classes.push("selected");
                  else if (!unit && selected !== null) classes.push("target");
                  if (drag && drag.index === index) classes.push("dragging");
                  if (drag && drag.over?.col === col && drag.over?.row === row && drag.index !== index) classes.push("drop");
                  return (
                    <button
                      key={`${col}-${row}`}
                      type="button"
                      className={classes.join(" ")}
                      style={unit ? swatch(raceId, unit.kind) : undefined}
                      data-col={col}
                      data-row={row}
                      aria-pressed={unit ? index === selected : undefined}
                      aria-label={unit ? `${unitSpec(raceId, unit.kind)?.name} at ${col},${row}` : `zone ${col},${row}`}
                      onClick={() => place(col, row)}
                      onPointerDown={unit ? (event) => startDrag(event, index) : undefined}
                      onPointerMove={unit ? moveDrag : undefined}
                      onPointerUp={unit ? endDrag : undefined}
                      onPointerCancel={unit ? endDrag : undefined}
                    >
                      {unit && <UnitArt race={raceId} kind={unit.kind} />}
                    </button>
                  );
                }))}
              </div>
              {drag && draft[drag.index] && (
                <div className="drag-ghost" style={{ left: drag.x, top: drag.y, ...swatch(raceId, draft[drag.index].kind) }} aria-hidden="true">
                  <UnitArt race={raceId} kind={draft[drag.index].kind} />
                </div>
              )}
              {selectedUnit && selected !== null && (
                <div className="editing" role="status">
                  <UnitArt race={raceId} kind={selectedUnit.kind} />
                  <p><strong>{unitSpec(raceId, selectedUnit.kind)?.name}</strong> at {selectedUnit.col},{selectedUnit.row} follows <em>{behaviorName(behaviors, selectedUnit.behavior)}</em>. Pick another soldier or behavior above, or tap or drag to an empty tile to move it.</p>
                  <div className="editing__actions">
                    <button type="button" className="hz-button mini quiet" onClick={() => removeUnit(selected)}>Remove</button>
                    <button type="button" className="hz-button mini" onClick={() => setSelected(null)}>Done</button>
                  </div>
                </div>
              )}
              <ul className="draft">
                {draft.map((unit, index) => (
                  <li key={`${unit.col}-${unit.row}`}>
                    <button type="button" className={selected === index ? "draft__row is-selected" : "draft__row"} aria-pressed={selected === index} onClick={() => selectUnit(selected === index ? null : index)}>
                      <UnitArt race={raceId} kind={unit.kind} />
                      <span className="draft__name">{unitSpec(raceId, unit.kind)?.name}<small>{behaviorName(behaviors, unit.behavior)} · tile {unit.col},{unit.row}</small></span>
                      <Gem value={unitSpec(raceId, unit.kind)?.cost || 0} />
                    </button>
                  </li>
                ))}
              </ul>
              <p className={full ? "muster-hint is-full" : "muster-hint"}>
                {!draft.length ? `Spend the ${ground.budget} budget to field an army.` : full ? "The army is full and ready to save." : `${ground.budget - cost} budget left. Keep adding soldiers until nothing more fits (the cheapest costs ${cheapest}).`}
              </p>
              <div className="muster-actions">
                <button type="button" className="hz-button" data-tour="simulate" disabled={!draft.length || busy} onClick={() => simulate()}><span className="hz-diamond hz-diamond--ember" />Simulate against a random army</button>
                <button type="button" className="hz-button hz-button--primary" disabled={!full || busy || !!needsPlayer} title={needsPlayer} onClick={() => run(async () => { await chain.createArmy(battlegroundId, draft, raceId); setDraft([]); setSelected(null); setNotice(`The host is mustered for the ${ground.name}. Lock it from the Battle tab.`); })}>Save army</button>
              </div>
            </Section>

            <Section title={`Armies of the ${ground.name}`} aside={<span className="panel__count">{groundArmies.length}</span>}>
              <div className="armies">
                {groundArmies.map((army) => (
                  <ArmyCard
                    key={army.pubkey}
                    army={army}
                    budget={ground.budget}
                    behaviors={behaviors}
                    actions={(
                      <>
                        <button type="button" className="hz-button mini" onClick={() => copyToMuster(army)}>Copy to the muster</button>
                        {deleteControls(army)}
                      </>
                    )}
                  />
                ))}
                {!groundArmies.length && <p className="empty">No army on the {ground.name} yet.</p>}
              </div>
            </Section>
          </>
        )}

        {screen === "behaviors" && !forging && (
          <Section title="Behaviors">
            <BehaviorList behaviors={behaviors} onNew={() => { setError(""); setNotice(""); setForging(true); }} />
          </Section>
        )}

        {screen === "behaviors" && forging && (
          <Section title="New behavior" aside={<button type="button" className="hz-button mini quiet" onClick={() => setForging(false)}>All behaviors</button>}>
            <BehaviorEditor
              elements={draftElements}
              disabledReason={needsPlayer}
              onChange={setDraftElements}
              onCreate={() => run(() => chain.createBehavior(draftElements)).then((tone) => {
                if (tone !== "success") return;
                setForging(false);
                setNotice("The behavior is forged.");
              })}
            />
          </Section>
        )}
      </main>
      {touring && <Walkthrough steps={tourSteps(devMode)} screen={screen} onScreen={setScreen} onClose={() => setTouring(false)} />}
    </div>
  );
}
