import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../src/config.js";
import {
  curveIn,
  dbToLinear,
  duckWeight,
  layerGain,
  panGains,
  sourcePositionMs,
  type Layer,
  type MixPlan,
} from "../src/fusion/envelope.js";
import { buildEnvelopeCases } from "../scripts/fixture-data.js";

const layer = (over: Partial<Layer> = {}): Layer => ({
  id: "a",
  assetId: "x",
  role: "music",
  startMs: 0,
  sourceInMs: 0,
  durationMs: 60000,
  gainDb: 0,
  fadeInMs: 0,
  fadeOutMs: 0,
  loop: false,
  pan: 0,
  ...over,
});
const plan = (layers: Layer[], over: Partial<MixPlan> = {}): MixPlan => ({
  version: 1,
  title: "t",
  durationMs: 120000,
  layers,
  ...over,
});

describe("envelope math", () => {
  it("converts dB", () => {
    expect(dbToLinear(0)).toBe(1);
    expect(dbToLinear(-6)).toBeCloseTo(0.501, 3);
  });
  it("fade-in is monotonic and completes", () => {
    const l = layer({ fadeInMs: 4000 });
    const p = plan([l]);
    let prev = -1;
    for (let t = 0; t <= 4000; t += 100) {
      const g = layerGain(p, l, t);
      expect(g).toBeGreaterThanOrEqual(prev);
      prev = g;
    }
    expect(layerGain(p, l, 4000)).toBeCloseTo(1, 6);
    expect(layerGain(p, l, 0)).toBe(0);
  });
  it("fade-out is monotonic decreasing to ~0 at the end", () => {
    const l = layer({ fadeOutMs: 5000 });
    const p = plan([l]);
    let prev = 2;
    for (let t = 55000; t < 60000; t += 100) {
      const g = layerGain(p, l, t);
      expect(g).toBeLessThanOrEqual(prev);
      prev = g;
    }
    expect(layerGain(p, l, 59999)).toBeLessThan(0.001);
    expect(layerGain(p, l, 60000)).toBe(0);
  });
  it("silences outside the layer window", () => {
    const l = layer({ startMs: 10000, durationMs: 5000 });
    expect(layerGain(plan([l]), l, 9999)).toBe(0);
    expect(layerGain(plan([l]), l, 12000)).toBe(1);
    expect(layerGain(plan([l]), l, 15000)).toBe(0);
  });
  it("ducks music while speech plays with attack and release", () => {
    const m = layer({ id: "m" });
    const s = layer({ id: "s", role: "speech", startMs: 20000, durationMs: 10000 });
    const p = plan([m, s], { ducking: { enabled: true, amountDb: 12, attackMs: 1000, releaseMs: 2000 } });
    expect(duckWeight(p, 19999)).toBe(0);
    expect(duckWeight(p, 20500)).toBeCloseTo(0.5, 6);
    expect(layerGain(p, m, 25000)).toBeCloseTo(dbToLinear(-12), 6);
    expect(layerGain(p, s, 25000)).toBe(1); // speech never ducks itself
    expect(duckWeight(p, 31000)).toBeCloseTo(0.5, 6);
    expect(duckWeight(p, 32000)).toBe(0);
  });
  it("applies equal-power transitions", () => {
    const a = layer({ id: "a" });
    const b = layer({ id: "b", startMs: 20000, durationMs: 40000 });
    const p = plan([a, b], {
      transitions: [
        { fromLayerId: "a", toLayerId: "b", startMs: 20000, durationMs: 10000, curve: "equal_power" },
      ],
    });
    const mid = 25000;
    const ga = layerGain(p, a, mid);
    const gb = layerGain(p, b, mid);
    expect(ga * ga + gb * gb).toBeCloseTo(1, 6);
    expect(layerGain(p, a, 31000)).toBe(0);
  });
  it("mute and solo", () => {
    const a = layer({ id: "a", solo: true });
    const b = layer({ id: "b" });
    const c = layer({ id: "c", muted: true });
    const p = plan([a, b, c]);
    expect(layerGain(p, a, 1000)).toBe(1);
    expect(layerGain(p, b, 1000)).toBe(0);
    expect(layerGain(p, c, 1000)).toBe(0);
  });
  it("curves are bounded", () => {
    for (const c of ["linear", "equal_power", "exponential"] as const) {
      expect(curveIn(c, -1)).toBe(0);
      expect(curveIn(c, 2)).toBeCloseTo(1, 9);
    }
  });
  it("pan law is equal power", () => {
    const [l, r] = panGains(0);
    expect(l * l + r * r).toBeCloseTo(1, 9);
    expect(panGains(-1)[1]).toBeCloseTo(0, 9);
  });
  it("source positions loop and run out", () => {
    const l = layer({ durationMs: 100000, loop: true, sourceInMs: 1000 });
    expect(sourcePositionMs(l, 31000, 35000)).toBe(1000 + (35000 % 30000));
    const nl = layer({ durationMs: 100000 });
    expect(sourcePositionMs(nl, 30000, 40000)).toBeNull();
  });
  it("shared fixture file is in sync with the reference implementation", () => {
    const file = path.join(REPO_ROOT, "contracts", "fixtures", "envelope-cases.json");
    const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(onDisk).toEqual(JSON.parse(JSON.stringify(buildEnvelopeCases())));
  });
});
