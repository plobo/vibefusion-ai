import type { MixPlan } from "../envelope.js";

/** Catalogue candidate given to a planner. Metadata is untrusted data, never instructions. */
export interface CandidateAsset {
  id: string;
  title: string;
  assetType: string;
  role: "music" | "speech" | "ambience" | "percussion" | "effect";
  durationMs: number;
  genres: string[];
  moods: string[];
  topics: string[];
  tempoBpm: number | null;
  key: string | null;
  loopable: boolean;
}

export interface PlanRequest {
  prompt: string;
  targetDurationMs: number;
  mood?: string;
  energyCurve?: "steady" | "gradual_build" | "wind_down" | "peak_middle";
  genres?: string[];
  includeSpeech?: boolean;
  speechTopic?: string;
  speechLanguage?: string;
  maxLayers: number;
  allowLoops: boolean;
}

export interface PlannerOutput {
  plan: MixPlan;
  provider: string;
}

/** Provider-neutral planner interface. Implementations: Anthropic (LLM) and rule-based (deterministic). */
export interface MixPlanner {
  readonly name: string;
  available(): boolean;
  plan(req: PlanRequest, candidates: CandidateAsset[], signal?: AbortSignal): Promise<MixPlan>;
}

export class PlannerUnavailableError extends Error {}

export interface PlannerGateway {
  /** Ordered planner list; the first available one that succeeds wins. */
  plan(
    req: PlanRequest,
    candidates: CandidateAsset[],
    opts?: { allowFallback?: boolean },
  ): Promise<PlannerOutput>;
  status(): { primary: string; available: boolean; fallback: string };
}

export class DefaultPlannerGateway implements PlannerGateway {
  constructor(
    private readonly primary: MixPlanner | null,
    private readonly fallback: MixPlanner,
    private readonly timeoutMs = 45000,
    private readonly onError: (provider: string, err: unknown) => void = () => {},
  ) {}

  status() {
    return {
      primary: this.primary?.name ?? this.fallback.name,
      available: this.primary ? this.primary.available() : true,
      fallback: this.fallback.name,
    };
  }

  async plan(
    req: PlanRequest,
    candidates: CandidateAsset[],
    opts: { allowFallback?: boolean } = {},
  ): Promise<PlannerOutput> {
    const allowFallback = opts.allowFallback ?? true;
    if (this.primary && this.primary.available()) {
      // One retry for transient failures, each attempt bounded by a timeout.
      for (let attempt = 0; attempt < 2; attempt++) {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
        try {
          const plan = await this.primary.plan(req, candidates, ctl.signal);
          return { plan, provider: this.primary.name };
        } catch (e) {
          this.onError(this.primary.name, e);
        } finally {
          clearTimeout(timer);
        }
      }
      if (!allowFallback) throw new PlannerUnavailableError("AI planner unavailable");
    } else if (this.primary && !allowFallback) {
      throw new PlannerUnavailableError("AI planner not configured");
    }
    return { plan: await this.fallback.plan(req, candidates), provider: this.fallback.name };
  }
}
