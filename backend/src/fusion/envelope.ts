/**
 * Reference implementation of mix-plan gain semantics (docs/AUDIO_ENGINE.md §2).
 * iOS (Swift) and Android (Kotlin) engines implement the identical math and are verified against
 * contracts/fixtures/envelope-cases.json, which is generated from this file.
 */
export type Curve = "linear" | "equal_power" | "exponential";

export interface Layer {
  id: string;
  assetId: string;
  role: "music" | "speech" | "ambience" | "percussion" | "effect";
  startMs: number;
  sourceInMs: number;
  durationMs: number;
  gainDb: number;
  fadeInMs: number;
  fadeOutMs: number;
  loop: boolean;
  pan: number;
  muted?: boolean;
  solo?: boolean;
}

export interface Transition {
  fromLayerId: string;
  toLayerId: string;
  startMs: number;
  durationMs: number;
  curve: Curve;
}

export interface Ducking {
  enabled: boolean;
  amountDb?: number;
  attackMs?: number;
  releaseMs?: number;
}

export interface MixPlan {
  version: 1;
  title: string;
  description?: string;
  durationMs: number;
  tempoBpm?: number | null;
  snapToBeat?: boolean;
  masterGainDb?: number;
  ducking?: Ducking;
  layers: Layer[];
  transitions?: Transition[];
  warnings?: string[];
}

export const DEFAULT_MASTER_GAIN_DB = -3;
export const DEFAULT_DUCK_DB = 9;
export const DEFAULT_ATTACK_MS = 300;
export const DEFAULT_RELEASE_MS = 800;

export const dbToLinear = (db: number) => Math.pow(10, db / 20);
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

export function curveIn(curve: Curve, x: number): number {
  const v = clamp01(x);
  switch (curve) {
    case "linear":
      return v;
    case "exponential":
      return v * v;
    case "equal_power":
    default:
      return Math.sin((v * Math.PI) / 2);
  }
}
export const curveOut = (curve: Curve, x: number) => curveIn(curve, 1 - clamp01(x));

function audible(plan: MixPlan, layer: Layer): boolean {
  if (layer.muted) return false;
  const anySolo = plan.layers.some((l) => l.solo);
  return !anySolo || !!layer.solo;
}

/** Duck weight in [0,1] at time t: how strongly speech is currently ducking the music bed. */
export function duckWeight(plan: MixPlan, tMs: number): number {
  const d = plan.ducking;
  if (!d?.enabled) return 0;
  const attack = d.attackMs ?? DEFAULT_ATTACK_MS;
  const release = d.releaseMs ?? DEFAULT_RELEASE_MS;
  let w = 0;
  for (const s of plan.layers) {
    if (s.role !== "speech" || !audible(plan, s)) continue;
    const start = s.startMs;
    const end = s.startMs + s.durationMs;
    let v: number;
    if (tMs < start) v = 0;
    else if (tMs >= end) v = release > 0 ? 1 - (tMs - end) / release : 0;
    else v = attack > 0 ? Math.min(1, (tMs - start) / attack) : 1;
    w = Math.max(w, clamp01(v));
  }
  return w;
}

/** Linear amplitude gain for a layer at plan time t (excludes master gain and pan). */
export function layerGain(plan: MixPlan, layer: Layer, tMs: number): number {
  if (!audible(plan, layer)) return 0;
  const local = tMs - layer.startMs;
  if (local < 0 || local >= layer.durationMs) return 0;
  let g = dbToLinear(layer.gainDb);
  if (layer.fadeInMs > 0 && local < layer.fadeInMs) g *= curveIn("equal_power", local / layer.fadeInMs);
  const remaining = layer.durationMs - local;
  if (layer.fadeOutMs > 0 && remaining < layer.fadeOutMs)
    g *= curveIn("equal_power", remaining / layer.fadeOutMs);
  for (const tr of plan.transitions ?? []) {
    if (tr.fromLayerId === layer.id && tMs >= tr.startMs) {
      g *= tr.durationMs > 0 ? curveOut(tr.curve, (tMs - tr.startMs) / tr.durationMs) : 0;
    }
    if (tr.toLayerId === layer.id) {
      if (tMs < tr.startMs) g = 0;
      else g *= tr.durationMs > 0 ? curveIn(tr.curve, (tMs - tr.startMs) / tr.durationMs) : 1;
    }
  }
  if (layer.role !== "speech") {
    const w = duckWeight(plan, tMs);
    if (w > 0) g *= dbToLinear(-(plan.ducking?.amountDb ?? DEFAULT_DUCK_DB) * w);
  }
  return g;
}

export const masterGain = (plan: MixPlan) => dbToLinear(plan.masterGainDb ?? DEFAULT_MASTER_GAIN_DB);

/** Equal-power pan law: returns [left, right] multipliers for pan in [-1, 1]. */
export function panGains(pan: number): [number, number] {
  const p = Math.max(-1, Math.min(1, pan));
  const angle = ((p + 1) * Math.PI) / 4;
  return [Math.cos(angle), Math.sin(angle)];
}

/**
 * Source position (ms into the asset) for a layer at plan time t, or null when the layer is silent
 * because the source ran out (non-looping) or the layer is inactive.
 */
export function sourcePositionMs(layer: Layer, assetDurationMs: number, tMs: number): number | null {
  const local = tMs - layer.startMs;
  if (local < 0 || local >= layer.durationMs) return null;
  if (layer.loop) {
    const loopLen = assetDurationMs - layer.sourceInMs;
    if (loopLen <= 0) return null;
    return layer.sourceInMs + (local % loopLen);
  }
  const pos = layer.sourceInMs + local;
  return pos < assetDurationMs ? pos : null;
}
