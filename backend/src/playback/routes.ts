import { Readable } from "node:stream";
import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../common/context.js";
import { requireUser, territoryOf } from "../common/context.js";
import { ApiError, notFound } from "../common/errors.js";
import { isUuid, uuid } from "../common/ids.js";
import { queryAssets } from "../catalogue/repo.js";
import { grantsFor } from "../rights/repo.js";
import { evaluate, useMessage, type RightsUse } from "../rights/policy.js";
import { signMedia, verifyMedia } from "./signer.js";
import { syntheticWav } from "../ingestion/synthetic.js";
import { pseudonymize, sanitizeEvent, type IncomingEvent } from "../observability/events.js";
import { loadPrefs } from "../me/routes.js";

const CONTEXT_USE: Record<string, RightsUse> = {
  stream: "stream",
  offline_download: "offline_download",
  fusion_preview: "mix",
};

export interface AuthorizedMedia {
  assetId: string;
  url: string;
  expiresAt: string;
  mimeType: string;
  format: string;
  purpose: RightsUse;
}

/** Revalidate rights (fail closed) and mint a short-lived, scoped media URL. */
export async function authorizeMedia(
  deps: AppDeps,
  userId: string,
  assetId: string,
  use: RightsUse,
  territory: string,
): Promise<AuthorizedMedia> {
  const now = deps.now();
  const [asset] = await queryAssets(deps.db, `WHERE a.id = $1`, [assetId], territory, now);
  if (!asset) throw notFound("Audio");
  if (!asset.isActive) throw new ApiError("ASSET_NOT_AVAILABLE", "This audio is no longer available.");
  const grants = (await grantsFor(deps.db, [assetId])).get(assetId) ?? [];
  const d = evaluate(grants, use, territory, now);
  if (!d.allowed) {
    deps.metrics.inc("rights_validation_failures_total", { use, reason: d.reason });
    throw new ApiError(
      use === "stream" ? "ASSET_NOT_AVAILABLE" : "RIGHTS_NOT_GRANTED",
      useMessage(use, d.reason),
      { reason: d.reason, assetId },
    );
  }
  // Downloads may be stored on device, so their URL lives a little longer than a streaming URL.
  const ttl = use === "offline_download" ? deps.config.mediaUrlTtlSec * 4 : deps.config.mediaUrlTtlSec;
  const exp = Math.floor(now.getTime() / 1000) + ttl;
  const token = signMedia({ a: assetId, u: userId, p: use, e: exp }, deps.config.mediaSigningSecret);
  const ext =
    asset.streamingFormat === "hls"
      ? "m3u8"
      : (
            await deps.db.one<{ mime_type: string }>(`SELECT mime_type FROM audio_assets WHERE id = $1`, [
              assetId,
            ])
          )?.mime_type === "audio/wav"
        ? "wav"
        : "mp3";
  const mime = ext === "wav" ? "audio/wav" : ext === "m3u8" ? "application/vnd.apple.mpegurl" : "audio/mpeg";
  return {
    assetId,
    url: `${deps.config.publicBaseUrl}/v1/media/${token}.${ext}`,
    expiresAt: new Date(exp * 1000).toISOString(),
    mimeType: mime,
    format: asset.streamingFormat,
    purpose: use,
  };
}

export function playbackRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { db } = deps;

  app.post<{ Body: { assetId: string; context?: string; quality?: string } }>(
    "/v1/playback/authorize",
    {
      config: { rateLimit: { max: 240, timeWindow: "1 minute" } },
      schema: {
        body: {
          type: "object",
          required: ["assetId"],
          additionalProperties: false,
          properties: {
            assetId: { type: "string", maxLength: 64 },
            context: { enum: ["stream", "offline_download", "fusion_preview"] },
            quality: { enum: ["auto", "high", "data_saver"] },
          },
        },
      },
    },
    async (req) => {
      const me = requireUser(req);
      if (!isUuid(req.body.assetId)) throw notFound("Audio");
      const use = CONTEXT_USE[req.body.context ?? "stream"]!;
      if (use === "offline_download" && me.isGuest)
        throw new ApiError("FORBIDDEN", "Create an account to download audio.");
      const territory = territoryOf(req, deps.config.defaultTerritory);
      const media = await authorizeMedia(deps, me.id, req.body.assetId, use, territory);
      const progress = await db.one<{ position_ms: number; completed: boolean }>(
        `SELECT position_ms, completed FROM playback_progress WHERE user_id = $1 AND asset_id = $2`,
        [me.id, req.body.assetId],
      );
      const [asset] = await queryAssets(db, `WHERE a.id = $1`, [req.body.assetId], territory, deps.now());
      deps.metrics.inc("playback_authorized_total", { context: req.body.context ?? "stream" });
      return {
        ...media,
        quality: req.body.quality ?? "auto",
        capabilities: {
          seek: true,
          background: true,
          speedControl: asset?.assetType === "speech" || asset?.assetType === "podcast_episode",
          ...asset!.capabilities,
        },
        resumePositionMs: progress && !progress.completed ? progress.position_ms : 0,
        attribution: asset?.license?.attribution ?? null,
      };
    },
  );

  /** Signed media endpoint. Rights are rechecked on every fetch so revocations take effect immediately. */
  app.get<{ Params: { token: string } }>("/v1/media/:token", async (req, reply) => {
    const raw = req.params.token.replace(/\.(mp3|wav|m3u8|m4a)$/, "");
    const v = verifyMedia(raw, deps.config.mediaSigningSecret, deps.now().getTime());
    if (!v.ok) {
      deps.metrics.inc("signed_url_failures_total", { reason: v.reason });
      throw v.reason === "expired"
        ? new ApiError("MEDIA_URL_EXPIRED", "This playback link expired. Request a new one.")
        : new ApiError("FORBIDDEN", "Invalid playback link.");
    }
    const { a: assetId, p: purpose } = v.claims;
    const territory =
      (await db.one<{ territory: string }>(`SELECT territory FROM users WHERE id = $1`, [v.claims.u]))
        ?.territory ?? deps.config.defaultTerritory;
    const asset = await db.one<{ is_active: boolean; mime_type: string }>(
      `SELECT is_active, mime_type FROM audio_assets WHERE id = $1`,
      [assetId],
    );
    const grants = (await grantsFor(db, [assetId])).get(assetId) ?? [];
    const d = evaluate(grants, purpose, territory, deps.now());
    if (!asset?.is_active || !d.allowed)
      throw new ApiError("ASSET_NOT_AVAILABLE", "This audio is no longer available.");
    const storage = await db.one<{ storage_kind: string; storage_key: string }>(
      `SELECT storage_kind, storage_key FROM asset_storage WHERE asset_id = $1`,
      [assetId],
    );
    if (!storage) throw notFound("Audio");
    reply.header("Cache-Control", "private, max-age=300");
    if (storage.storage_kind === "synthetic") {
      const buf = syntheticWav(storage.storage_key);
      if (!buf) throw notFound("Audio");
      reply.header("Accept-Ranges", "bytes").header("Content-Type", "audio/wav");
      const range = req.headers.range?.match(/^bytes=(\d*)-(\d*)$/);
      if (range) {
        const start = range[1] ? Number(range[1]) : 0;
        const end = range[2] ? Math.min(Number(range[2]), buf.length - 1) : buf.length - 1;
        if (start >= buf.length || start > end) {
          reply.code(416).header("Content-Range", `bytes */${buf.length}`);
          return reply.send();
        }
        reply
          .code(206)
          .header("Content-Range", `bytes ${start}-${end}/${buf.length}`)
          .header("Content-Length", end - start + 1);
        return reply.send(buf.subarray(start, end + 1));
      }
      reply.header("Content-Length", buf.length);
      return reply.send(buf);
    }
    if (process.env.MEDIA_DELIVERY === "proxy") {
      const upstream = await fetch(storage.storage_key, {
        headers: req.headers.range ? { Range: req.headers.range } : {},
        redirect: "follow",
      });
      if (!upstream.ok && upstream.status !== 206)
        throw new ApiError("ASSET_NOT_AVAILABLE", "The audio source is unavailable right now.");
      reply.code(upstream.status);
      for (const h of ["content-type", "content-length", "content-range", "accept-ranges"]) {
        const val = upstream.headers.get(h);
        if (val) reply.header(h, val);
      }
      return reply.send(Readable.fromWeb(upstream.body as never));
    }
    // Default: short-lived redirect to the open-licence origin (never stored by clients).
    return reply.redirect(storage.storage_key, 302);
  });

  app.post<{ Body: { assetId: string; positionMs: number; completed?: boolean; durationMs?: number } }>(
    "/v1/playback/progress",
    {
      schema: {
        body: {
          type: "object",
          required: ["assetId", "positionMs"],
          properties: {
            assetId: { type: "string" },
            positionMs: { type: "integer", minimum: 0 },
            completed: { type: "boolean" },
            durationMs: { type: "integer", minimum: 0 },
          },
        },
      },
    },
    async (req) => {
      const me = requireUser(req);
      if (!isUuid(req.body.assetId)) throw notFound("Audio");
      const exists = await db.one<{ duration_ms: number }>(
        `SELECT duration_ms FROM audio_assets WHERE id = $1`,
        [req.body.assetId],
      );
      if (!exists) throw notFound("Audio");
      const dur = req.body.durationMs ?? exists.duration_ms;
      const completed = req.body.completed ?? (dur > 0 && req.body.positionMs >= dur - 15000);
      const row = await db.one<{ updated_at: Date }>(
        `INSERT INTO playback_progress (id, user_id, asset_id, position_ms, completed, updated_at) VALUES ($1,$2,$3,$4,$5, now())
         ON CONFLICT (user_id, asset_id) DO UPDATE SET position_ms = EXCLUDED.position_ms, completed = EXCLUDED.completed, updated_at = now()
         RETURNING updated_at`,
        [uuid(), me.id, req.body.assetId, req.body.positionMs, completed],
      );
      return {
        assetId: req.body.assetId,
        positionMs: req.body.positionMs,
        completed,
        updatedAt: new Date(row!.updated_at).toISOString(),
      };
    },
  );

  app.get<{ Params: { assetId: string } }>("/v1/playback/progress/:assetId", async (req) => {
    const me = requireUser(req);
    if (!isUuid(req.params.assetId)) throw notFound("Audio");
    const p = await db.one<{ position_ms: number; completed: boolean; updated_at: Date }>(
      `SELECT position_ms, completed, updated_at FROM playback_progress WHERE user_id = $1 AND asset_id = $2`,
      [me.id, req.params.assetId],
    );
    return {
      assetId: req.params.assetId,
      positionMs: p?.position_ms ?? 0,
      completed: p?.completed ?? false,
      updatedAt: p ? new Date(p.updated_at).toISOString() : null,
    };
  });

  app.get<{ Querystring: { limit?: string } }>("/v1/playback/recent", async (req) => {
    const me = requireUser(req);
    const territory = territoryOf(req, deps.config.defaultTerritory);
    const limit = Math.max(1, Math.min(100, Number(req.query.limit ?? 30)));
    const rows = await db.query<{
      asset_id: string;
      position_ms: number;
      completed: boolean;
      updated_at: Date;
    }>(
      `SELECT asset_id, position_ms, completed, updated_at FROM playback_progress WHERE user_id = $1 ORDER BY updated_at DESC LIMIT ${limit}`,
      [me.id],
    );
    const assets = await queryAssets(
      db,
      `WHERE a.id = ANY($1::uuid[])`,
      [rows.map((r) => r.asset_id)],
      territory,
      deps.now(),
    );
    const byId = new Map(assets.map((a) => [a.id, a]));
    return {
      items: rows
        .filter((r) => byId.has(r.asset_id))
        .map((r) => ({
          asset: byId.get(r.asset_id),
          positionMs: r.position_ms,
          completed: r.completed,
          playedAt: new Date(r.updated_at).toISOString(),
        })),
    };
  });

  app.post<{ Body: { events: IncomingEvent[]; platform?: string } }>(
    "/v1/playback/events",
    {
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
      schema: {
        body: {
          type: "object",
          required: ["events"],
          properties: {
            events: { type: "array", maxItems: 100 },
            platform: { enum: ["ios", "android", "web"] },
          },
        },
      },
    },
    async (req, reply) => {
      const me = requireUser(req);
      const prefs = await loadPrefs(deps, me.id);
      let accepted = 0;
      if (prefs.analyticsOptIn) {
        const pid = pseudonymize(me.id, deps.config.jwtSecret);
        for (const raw of req.body.events) {
          const e = sanitizeEvent(raw);
          if (!e) continue;
          await db.query(
            `INSERT INTO product_events (pseudonymous_id, name, properties, platform, occurred_at) VALUES ($1,$2,$3,$4,$5)`,
            [pid, e.name, JSON.stringify(e.properties), req.body.platform ?? null, e.occurredAt],
          );
          deps.metrics.inc("product_events_total", { name: e.name });
          if (e.name === "stream_start_latency" && typeof e.properties.latencyMs === "number")
            deps.metrics.observe("stream_start_latency_ms", e.properties.latencyMs);
          if (e.name === "playback_failed")
            deps.metrics.inc("playback_failures_total", {
              code: String(e.properties.errorCode ?? "unknown"),
            });
          accepted++;
        }
      }
      reply.code(202);
      return { accepted, dropped: req.body.events.length - accepted };
    },
  );
}
