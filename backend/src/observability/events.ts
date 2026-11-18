import crypto from "node:crypto";

/** Product analytics events (IMPLEMENTATION_PLAN §13). Anything else is dropped. */
export const EVENT_NAMES = new Set([
  "catalogue_viewed",
  "search_performed",
  "asset_play_requested",
  "playback_started",
  "playback_failed",
  "playback_completed",
  "playback_progress_saved",
  "asset_liked",
  "playlist_created",
  "episode_bookmarked",
  "fusion_prompt_submitted",
  "fusion_plan_generated",
  "fusion_plan_rejected",
  "fusion_preview_started",
  "fusion_recipe_saved",
  "stream_start_latency",
  "buffering",
  "mix_engine_underrun",
]);

/** Allow-listed, non-sensitive properties. Prompts, transcripts, emails and URLs are never accepted. */
const ALLOWED_PROPS: Record<string, "string" | "number" | "boolean"> = {
  assetId: "string",
  assetType: "string",
  screen: "string",
  resultCount: "number",
  latencyMs: "number",
  positionMs: "number",
  durationMs: "number",
  errorCode: "string",
  layerCount: "number",
  provider: "string",
  context: "string",
  route: "string",
  quality: "string",
  networkType: "string",
  appVersion: "string",
};

export interface IncomingEvent {
  name: string;
  occurredAt?: string;
  properties?: Record<string, unknown>;
}

export function sanitizeEvent(
  e: IncomingEvent,
): { name: string; occurredAt: Date; properties: Record<string, unknown> } | null {
  if (!e || typeof e.name !== "string" || !EVENT_NAMES.has(e.name)) return null;
  const props: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(e.properties ?? {})) {
    const type = ALLOWED_PROPS[k];
    if (!type || typeof v !== type) continue;
    if (typeof v === "string") {
      if (v.length > 64 || /https?:|@/.test(v)) continue;
    }
    props[k] = v;
  }
  const ts = e.occurredAt ? Date.parse(e.occurredAt) : NaN;
  return { name: e.name, occurredAt: Number.isNaN(ts) ? new Date() : new Date(ts), properties: props };
}

/** Pseudonymous id: keyed hash of the user id, rotated by secret. Not reversible without the secret. */
export function pseudonymize(userId: string, secret: string): string {
  return crypto.createHmac("sha256", `${secret}:analytics`).update(userId).digest("hex").slice(0, 24);
}
