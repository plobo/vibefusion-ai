import type { Layer, MixPlan, Transition } from "../envelope.js";
import type { CandidateAsset, MixPlanner, PlanRequest } from "./gateway.js";

const KEYWORDS: Record<string, string[]> = {
  calm: ["calm", "relax", "peace", "chill", "soft", "gentle", "sleep", "focus"],
  uplifting: ["uplift", "hope", "inspir", "motivat", "bright", "happy", "rise", "positive"],
  energetic: ["energ", "workout", "run", "power", "pump", "intense", "drive"],
  cinematic: ["cinematic", "epic", "film", "score", "orchestr", "strings"],
  electronic: ["electronic", "synth", "edm", "techno", "house", "beat", "percussion"],
  ambient: ["ambient", "atmos", "drone", "pad", "texture"],
  piano: ["piano", "keys"],
};

function tokens(req: PlanRequest): Set<string> {
  const text = `${req.prompt} ${req.mood ?? ""} ${(req.genres ?? []).join(" ")}`.toLowerCase();
  const found = new Set<string>((req.genres ?? []).map((g) => g.toLowerCase()));
  if (req.mood) found.add(req.mood.toLowerCase());
  for (const [tag, kws] of Object.entries(KEYWORDS)) if (kws.some((k) => text.includes(k))) found.add(tag);
  return found;
}

function score(a: CandidateAsset, want: Set<string>): number {
  const tags = [...a.genres, ...a.moods, ...a.topics, a.title].map((t) => t.toLowerCase());
  let s = 0;
  for (const w of want) if (tags.some((t) => t.includes(w))) s += 2;
  if (a.loopable) s += 0.5;
  return s;
}

/**
 * Deterministic planner used when no LLM is configured or the provider is down.
 * Same request + same candidates => byte-identical plan.
 */
export class RuleBasedPlanner implements MixPlanner {
  readonly name = "rules";
  available() {
    return true;
  }

  async plan(req: PlanRequest, candidates: CandidateAsset[]): Promise<MixPlan> {
    const want = tokens(req);
    const D = req.targetDurationMs;
    const byScore = (list: CandidateAsset[]) =>
      [...list].sort((x, y) => score(y, want) - score(x, want) || x.id.localeCompare(y.id));
    const music = byScore(candidates.filter((c) => c.role !== "speech"));
    const speech = byScore(candidates.filter((c) => c.role === "speech")).filter((c) => {
      if (!req.speechTopic) return true;
      const t = req.speechTopic.toLowerCase();
      return c.topics.some((x) => x.toLowerCase().includes(t)) || c.title.toLowerCase().includes(t);
    });
    const speechPool = speech.length > 0 ? speech : byScore(candidates.filter((c) => c.role === "speech"));
    const warnings: string[] = [];
    const layers: Layer[] = [];
    const transitions: Transition[] = [];
    const maxMusic = Math.max(1, Math.min(req.maxLayers - (req.includeSpeech ? 1 : 0), 3));
    const usable = (c: CandidateAsset, dur: number) => (req.allowLoops && c.loopable) || c.durationMs >= dur;
    const curve = req.energyCurve ?? "gradual_build";

    // Bed layer: full length.
    const bed = music.find((c) => usable(c, D));
    if (!bed) {
      warnings.push("No cleared music long enough for this session was found; try a shorter duration.");
    } else {
      layers.push({
        id: "layer-1",
        assetId: bed.id,
        role: bed.role === "speech" ? "music" : bed.role,
        startMs: 0,
        sourceInMs: 0,
        durationMs: D,
        gainDb: curve === "gradual_build" ? -12 : -10,
        fadeInMs: Math.min(8000, Math.floor(D / 10)),
        fadeOutMs: Math.min(10000, Math.floor(D / 8)),
        loop: bed.durationMs < D,
        pan: 0,
      });
    }

    // Additional music layers introduced according to the energy curve.
    const rest = music.filter((c) => c.id !== bed?.id);
    for (let i = 0; i < maxMusic - 1 && i < rest.length; i++) {
      const c = rest[i]!;
      const start =
        curve === "wind_down"
          ? 0
          : curve === "peak_middle"
            ? Math.floor(D * (0.25 + 0.1 * i))
            : Math.floor(D * (0.15 + 0.15 * i));
      const end =
        curve === "wind_down"
          ? Math.floor(D * (0.6 - 0.1 * i))
          : curve === "peak_middle"
            ? Math.floor(D * 0.8)
            : D;
      let dur = Math.max(10000, end - start);
      if (!usable(c, dur)) {
        if (c.durationMs < 10000) continue;
        dur = Math.min(dur, c.durationMs);
      }
      layers.push({
        id: `layer-${layers.length + 1}`,
        assetId: c.id,
        role: c.role === "speech" ? "music" : c.role,
        startMs: start,
        sourceInMs: 0,
        durationMs: dur,
        gainDb: -14 + 2 * i,
        fadeInMs: Math.min(10000, Math.floor(dur / 4)),
        fadeOutMs: Math.min(12000, Math.floor(dur / 4)),
        loop: c.durationMs < dur,
        pan: i % 2 === 0 ? -0.2 : 0.2,
      });
    }

    if (req.includeSpeech) {
      const s = speechPool[0];
      if (!s) {
        warnings.push("No cleared speech matched the requested topic, so the session is music-only.");
      } else {
        const dur = Math.min(s.durationMs, Math.floor(D * 0.5));
        const start = Math.max(0, Math.floor(D / 2 - dur / 2));
        layers.push({
          id: `layer-${layers.length + 1}`,
          assetId: s.id,
          role: "speech",
          startMs: start,
          sourceInMs: 0,
          durationMs: Math.max(1000, dur),
          gainDb: 0,
          fadeInMs: 1500,
          fadeOutMs: 2500,
          loop: false,
          pan: 0,
        });
        if (dur < s.durationMs) warnings.push(`The speech "${s.title}" was trimmed to fit the session.`);
      }
    }

    const tempo =
      layers.map((l) => candidates.find((c) => c.id === l.assetId)?.tempoBpm).find((t) => !!t) ?? null;
    const title = req.mood ? `${req.mood[0]!.toUpperCase()}${req.mood.slice(1)} Fusion` : "Fusion Session";
    return {
      version: 1,
      title,
      description: req.prompt.slice(0, 200),
      durationMs: D,
      tempoBpm: tempo,
      masterGainDb: -3,
      ducking: {
        enabled: layers.some((l) => l.role === "speech"),
        amountDb: 9,
        attackMs: 300,
        releaseMs: 800,
      },
      layers: layers.length > 0 ? layers : [],
      transitions,
      warnings,
    };
  }
}
