export type BoardPiece = { kind: number; col: number; row: number; race?: number };

export type BoardViewOptions = {
  cols: number;
  rows: number;
  unitsA?: BoardPiece[];
  unitsB?: BoardPiece[];
  mySide?: number;
  blocked?: { col: number; row: number }[];
  lines?: string[];
  playing?: boolean;
  speed?: number;
  stepMs?: number;
  onProgress?: (cursor: number) => void;
  onImpact?: (event: BoardImpact) => void;
};

export type BoardImpact = {
  kind: "hit" | "cast" | "miss" | "defend" | "death";
  damage?: number;
  mine?: boolean;
  line: string;
};

export type BoardView = {
  setPlaying(playing: boolean): void;
  setSpeed(speed: number): void;
  setStepMs(stepMs: number): void;
  seek(cursor: number): void;
  dispose(): void;
};

export function unitMeshUrl(raceId: number, kind: number): string;
export function stepTrace(fighters: { side: number; index: number; group: { position: { set: (x: number, y: number, z: number) => void; y: number }; scale: { setScalar: (value: number) => void }; visible: boolean } }[], line: string): void;
export function createBoardView(host: HTMLElement, options: BoardViewOptions): BoardView;
