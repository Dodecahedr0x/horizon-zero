import { useEffect, useLayoutEffect, useState } from "react";

export type Screen = "behaviors" | "army" | "battle";

export type TourStep = {
  title: string;
  body: string;
  screen?: Screen;
  target?: string;
};

const STORAGE_KEY = "hz-walkthrough-done";

export function walkthroughSeen() {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function markSeen() {
  try {
    localStorage.setItem(STORAGE_KEY, "1");
  } catch {
    // Without storage the tour shows again next visit.
  }
}

export function tourSteps(devMode: boolean): TourStep[] {
  return [
    {
      title: "Welcome to Horizon Zero",
      body: "Muster a host of up to six soldiers, give each one orders, and lock it on a battleground. The battle then plays out on its own. This short tour shows the way.",
    },
    {
      title: "Behaviors are orders",
      body: "A behavior tells a soldier how to move and whom to attack or cast on. The standards are ready to use. Forge your own here when you want a new plan.",
      screen: "behaviors",
      target: "behaviors",
    },
    {
      title: "Muster your host",
      body: "Pick a battleground, a soldier and a behavior, then tap a tile in your zone to place it. Tap a placed soldier to change it. Spend the whole budget, then save the army.",
      screen: "army",
      target: "muster",
    },
    {
      title: "Try it first",
      body: "Simulate plays your draft against a random army on the same battleground. Nothing is staked and nothing is stored.",
      screen: "army",
      target: "simulate",
    },
    {
      title: "Lock to fight",
      body: devMode
        ? "Full armies wait here, per battleground. First create your player and fund its budget in the wallet above; the budget must cover one stake. Lock an army to queue and stake. Dev mode has a single player, so a locked army waits in the queue; use Simulate on the Army tab to see a fight."
        : "Full armies wait here, per battleground. First create your player and fund its budget in the wallet above; the budget must cover one stake. Lock an army to queue and stake; the battle opens as soon as a foe locks there too. Unlock leaves the queue, and an idle army can be deleted.",
      screen: "battle",
      target: "armies",
    },
    {
      title: "Watch the battle",
      body: "Your latest battles are listed here. Watch replays a fight with a chronicle of every move and blow. You can reopen this tour any time from the Guide button at the top.",
      screen: "battle",
      target: "log",
    },
  ];
}

type Rect = { top: number; left: number; width: number; height: number };

function measure(target?: string): Rect | null {
  if (!target) return null;
  const element = document.querySelector<HTMLElement>(`[data-tour="${target}"]`);
  if (!element) return null;
  const box = element.getBoundingClientRect();
  return { top: box.top, left: box.left, width: box.width, height: box.height };
}

export function Walkthrough({ steps, screen, onScreen, onClose }: { steps: TourStep[]; screen: Screen; onScreen: (screen: Screen) => void; onClose: () => void }) {
  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);
  const step = steps[index];
  const last = index === steps.length - 1;

  function close() {
    markSeen();
    onClose();
  }

  useEffect(() => {
    if (step.screen) onScreen(step.screen);
  }, [index]);

  // Once the step's screen is showing, bring the target into view, then track it through scroll and resize.
  useLayoutEffect(() => {
    if (!step.target || (step.screen && step.screen !== screen)) {
      setRect(null);
      return;
    }
    const element = document.querySelector<HTMLElement>(`[data-tour="${step.target}"]`);
    const fixed = element && getComputedStyle(element).position === "fixed";
    if (element && !fixed) element.scrollIntoView({ block: "center", behavior: "auto" });
    const update = () => setRect(measure(step.target));
    update();
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [index, step.target, screen]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
      if (event.key === "ArrowRight" && !last) setIndex(index + 1);
      if (event.key === "ArrowLeft" && index > 0) setIndex(index - 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, last]);

  // Put the card on the side of the viewport away from the highlighted element.
  const cardAtTop = !!rect && rect.top + rect.height / 2 > window.innerHeight / 2;
  const pad = 6;

  return (
    <div className="tour" role="dialog" aria-modal="true" aria-labelledby="tour-title">
      {rect ? (
        <div className="tour__spot" style={{ top: rect.top - pad, left: rect.left - pad, width: rect.width + pad * 2, height: rect.height + pad * 2 }} />
      ) : (
        <div className="tour__veil" />
      )}
      <section className={cardAtTop ? "tour__card hz-frame tour__card--top" : "tour__card hz-frame"}>
        <p className="caption">Step {index + 1} of {steps.length}</p>
        <h3 id="tour-title" className="hz-frame__title">{step.title}</h3>
        <p className="tour__body">{step.body}</p>
        <div className="tour__dots" aria-hidden="true">
          {steps.map((_, i) => <i key={i} className={i === index ? "hz-diamond hz-diamond--ember" : "hz-diamond"} />)}
        </div>
        <div className="tour__actions">
          <button type="button" className="hz-button mini" onClick={close}>Skip</button>
          <span className="tour__nav">
            {index > 0 && <button type="button" className="hz-button" onClick={() => setIndex(index - 1)}>Back</button>}
            <button type="button" className="hz-button hz-button--primary" autoFocus onClick={() => (last ? close() : setIndex(index + 1))}>{last ? "Start playing" : "Next"}</button>
          </span>
        </div>
      </section>
    </div>
  );
}
