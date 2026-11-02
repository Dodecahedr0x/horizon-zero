import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { BATTLEGROUNDS, raceById, unitSpec } from "./codec";

export function unitImage(race: number, kind: number) {
  const slug = (raceById(race) || raceById(0))?.slug;
  const name = unitSpec(race, kind)?.name.toLowerCase();
  return slug && name ? `/assets/units/${slug}/${name}/${name}.approved.png` : "";
}

export function swatch(race: number, kind: number) {
  return { "--swatch": `var(--unit-${unitSpec(race, kind)?.name.toLowerCase() || "guard"})` } as CSSProperties;
}

/** The approved 2D art of a unit, or its colour swatch while the art is missing. */
export function UnitArt({ race, kind, className }: { race: number; kind: number; className?: string }) {
  const [failed, setFailed] = useState(false);
  const src = unitImage(race, kind);
  useEffect(() => setFailed(false), [src]);
  return (
    <span className={className ? `unit-art ${className}` : "unit-art"} style={swatch(race, kind)} aria-hidden="true">
      {src && !failed ? <img src={src} alt="" decoding="async" loading="lazy" onError={() => setFailed(true)} /> : <i className="unit-art__fallback" />}
    </span>
  );
}

export function Gem({ value }: { value: number }) {
  return <span className="gem"><span>{value}</span></span>;
}

export type SelectOption<T> = { value: T; label: string; detail?: ReactNode };

/** A listbox dropdown in the game's style. Keyboard: arrows, Home/End, Enter or Space to pick, Escape to close. */
export function Select<T extends string | number>({ label, value, options, onChange, placeholder = "Choose" }: {
  label: string;
  value: T;
  options: SelectOption<T>[];
  onChange: (value: T) => void;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const id = useId();
  const current = options.find((option) => option.value === value);

  useEffect(() => {
    if (!open) return;
    setActive(Math.max(0, options.findIndex((option) => option.value === value)));
    list.current?.focus();
    const away = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);

  useEffect(() => {
    if (open) list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  function choose(index: number) {
    const option = options[index];
    if (option) onChange(option.value);
    setOpen(false);
    button.current?.focus();
  }

  function onKey(event: KeyboardEvent) {
    const moves: Record<string, number> = { ArrowDown: active + 1, ArrowUp: active - 1, Home: 0, End: options.length - 1 };
    if (event.key in moves) {
      event.preventDefault();
      setActive(Math.min(options.length - 1, Math.max(0, moves[event.key])));
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      choose(active);
    } else if (event.key === "Escape" || event.key === "Tab") {
      setOpen(false);
      if (event.key === "Escape") button.current?.focus();
    }
  }

  return (
    <div className={open ? "select is-open" : "select"} ref={root}>
      <span className="select__label" id={`${id}-label`}>{label}</span>
      <button
        ref={button}
        type="button"
        className="select__button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-labelledby={`${id}-label ${id}-value`}
        onClick={() => setOpen(!open)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span className="select__value" id={`${id}-value`}>
          <span className="select__text">{current?.label ?? placeholder}</span>
          {current?.detail}
        </span>
        <svg className="select__chevron" viewBox="0 0 12 12" aria-hidden="true"><path d="M2 4.5 6 8.5 10 4.5" /></svg>
      </button>
      {open && (
        <ul ref={list} className="select__list" role="listbox" tabIndex={-1} aria-labelledby={`${id}-label`} aria-activedescendant={`${id}-${active}`} onKeyDown={onKey}>
          {options.map((option, index) => (
            <li
              key={String(option.value)}
              id={`${id}-${index}`}
              data-index={index}
              role="option"
              aria-selected={option.value === value}
              className={index === active ? "select__option is-active" : "select__option"}
              onPointerEnter={() => setActive(index)}
              onClick={() => choose(index)}
            >
              <span className="select__text">{option.label}</span>
              {option.detail}
            </li>
          ))}
          {!options.length && <li className="select__empty">Nothing to choose yet</li>}
        </ul>
      )}
    </div>
  );
}

/** The three leagues, as on the landing page: name, stake, budget and grid. */
/**
 * The battleground tabs. `counts` badges the player's own ready armies; `locked` is how many armies,
 * from any player, wait in each battleground's queue for a foe.
 */
export function GroundPicker({ value, onChange, counts, locked }: { value: number; onChange: (id: number) => void; counts?: Record<number, number>; locked?: Record<number, number> }) {
  return (
    <div className="grounds" role="group" aria-label="Battleground" data-tour="battleground">
      {BATTLEGROUNDS.map((ground) => {
        const waiting = locked?.[ground.id];
        const lockedText = waiting === undefined ? "" : waiting === 1 ? "1 army locked" : `${waiting} armies locked`;
        return (
        <button
          key={ground.id}
          type="button"
          className="ground"
          aria-pressed={ground.id === value}
          aria-label={`${ground.name}, ${ground.stake / 1e9} SOL, budget ${ground.budget}, ${ground.cols} by ${ground.rows}${lockedText ? `, ${lockedText}` : ""}`}
          onClick={() => onChange(ground.id)}
        >
          <span className="ground__name">{ground.name}</span>
          <span className="ground__facts">
            <b>{ground.stake / 1e9} SOL</b>
            <span>budget {ground.budget}</span>
            <span>{ground.cols}×{ground.rows}</span>
          </span>
          {lockedText && (
            <span className={waiting ? "ground__locked is-waiting" : "ground__locked"} title="Armies from every player locked here and waiting for a foe. Locking yours matches one of the others.">
              {lockedText}
            </span>
          )}
          {counts && counts[ground.id] > 0 && <span className="ground__count" aria-hidden="true">{counts[ground.id]}</span>}
        </button>
        );
      })}
    </div>
  );
}
