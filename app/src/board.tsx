import { useEffect, useRef, useState } from "react";
import { ZONE_DEPTH } from "./codec";
import { blockedTiles } from "./replay";
import { createBoardView, type BoardImpact, type BoardView } from "./board-view.js";

export type Piece = { kind: number; col: number; row: number; race?: number };

export function Board({
  cols,
  rows,
  seed,
  unitsA,
  unitsB,
  mySide,
  lines,
  playing,
  speed,
  onProgress,
  onImpact,
  controls,
}: {
  cols: number;
  rows: number;
  seed: string;
  unitsA: Piece[];
  unitsB: Piece[];
  mySide: number;
  lines: string[];
  playing: boolean;
  speed: number;
  onProgress?: (cursor: number) => void;
  onImpact?: (event: BoardImpact) => void;
  controls?: { current: { seek: (cursor: number) => void } | null };
}) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<BoardView | null>(null);
  const progressRef = useRef(onProgress);
  progressRef.current = onProgress;
  const impactRef = useRef(onImpact);
  impactRef.current = onImpact;
  const [blocked, setBlocked] = useState<{ col: number; row: number }[]>([]);

  useEffect(() => {
    let stop = false;
    blockedTiles(cols, rows, seed).then((tiles) => {
      if (!stop) setBlocked(tiles);
    });
    return () => {
      stop = true;
    };
  }, [cols, rows, seed]);

  useEffect(() => {
    const parent = host.current;
    if (!parent) return;
    const view = createBoardView(parent, {
      cols,
      rows,
      unitsA,
      unitsB,
      mySide,
      blocked,
      lines,
      playing,
      speed,
      onProgress: (cursor) => progressRef.current?.(cursor),
      onImpact: (event) => impactRef.current?.(event),
    });
    viewRef.current = view;
    if (controls) controls.current = { seek: (cursor) => view.seek(cursor) };
    return () => {
      view.dispose();
      if (viewRef.current === view) viewRef.current = null;
      if (controls) controls.current = null;
    };
  }, [cols, rows, unitsA, unitsB, mySide, lines, blocked]);

  useEffect(() => {
    viewRef.current?.setPlaying(playing);
    viewRef.current?.setSpeed(speed);
  }, [playing, speed]);

  const outside = blocked.filter((tile) => tile.row >= ZONE_DEPTH && tile.row < rows - ZONE_DEPTH);
  return (
    <div className="board-frame">
      <p className="board-caption" data-board-size={`${cols}x${rows}`}>
        Board {cols}×{rows}. Blocked {outside.map((tile) => `${tile.col},${tile.row}`).join(" ") || "none"}.
      </p>
      <div className="board" ref={host} />
    </div>
  );
}
