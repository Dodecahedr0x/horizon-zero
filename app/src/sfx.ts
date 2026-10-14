// Small synthesized sound effects for battles. No audio files: each cue is a few oscillators and a noise burst.
// The context is created on the first call, which always follows a click (Lock, Play), so browsers allow it.

export type Cue = "hit" | "heavy" | "cast" | "miss" | "defend" | "death" | "victory" | "defeat" | "draw";

const STORAGE_KEY = "hz-sound";
let context: AudioContext | null = null;

export function soundEnabled() {
  try {
    return localStorage.getItem(STORAGE_KEY) !== "off";
  } catch {
    return true;
  }
}

export function setSoundEnabled(on: boolean) {
  try {
    localStorage.setItem(STORAGE_KEY, on ? "on" : "off");
  } catch {
    // Private mode: the choice lasts for this page only.
  }
}

function audio() {
  if (!context) {
    const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    context = new Ctor();
  }
  if (context.state === "suspended") void context.resume();
  return context;
}

function tone(ctx: AudioContext, at: number, type: OscillatorType, from: number, to: number, length: number, volume: number) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(from, at);
  osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), at + length);
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(volume, at + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + length);
  osc.connect(gain).connect(ctx.destination);
  osc.start(at);
  osc.stop(at + length + 0.02);
}

function noise(ctx: AudioContext, at: number, length: number, volume: number, cutoff: number) {
  const buffer = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * length), ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i += 1) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
  const source = ctx.createBufferSource();
  const filter = ctx.createBiquadFilter();
  const gain = ctx.createGain();
  source.buffer = buffer;
  filter.type = "lowpass";
  filter.frequency.value = cutoff;
  gain.gain.value = volume;
  source.connect(filter).connect(gain).connect(ctx.destination);
  source.start(at);
}

export function play(cue: Cue) {
  if (!soundEnabled()) return;
  const ctx = audio();
  if (!ctx) return;
  const t = ctx.currentTime + 0.005;
  switch (cue) {
    case "hit":
      noise(ctx, t, 0.08, 0.35, 1800);
      tone(ctx, t, "sine", 170, 70, 0.12, 0.35);
      break;
    case "heavy":
      noise(ctx, t, 0.14, 0.45, 1200);
      tone(ctx, t, "sine", 130, 45, 0.22, 0.5);
      break;
    case "cast":
      tone(ctx, t, "triangle", 320, 960, 0.22, 0.18);
      tone(ctx, t + 0.05, "sine", 640, 1280, 0.18, 0.1);
      break;
    case "miss":
      noise(ctx, t, 0.06, 0.12, 3200);
      break;
    case "defend":
      tone(ctx, t, "square", 520, 500, 0.08, 0.06);
      tone(ctx, t + 0.06, "square", 780, 760, 0.1, 0.05);
      break;
    case "death":
      tone(ctx, t, "sawtooth", 260, 55, 0.45, 0.12);
      noise(ctx, t + 0.05, 0.25, 0.2, 600);
      break;
    case "victory":
      [523, 659, 784, 1047].forEach((f, i) => tone(ctx, t + i * 0.12, "triangle", f, f, 0.32, 0.18));
      break;
    case "defeat":
      [392, 330, 262].forEach((f, i) => tone(ctx, t + i * 0.18, "triangle", f, f * 0.98, 0.4, 0.16));
      break;
    case "draw":
      [440, 440].forEach((f, i) => tone(ctx, t + i * 0.2, "triangle", f, f, 0.3, 0.14));
      break;
  }
}
