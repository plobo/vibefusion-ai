import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AppDeps } from "../common/context.js";
import { territoryOf } from "../common/context.js";
import { notFound, ApiError } from "../common/errors.js";
import { decodeCursor, encodeCursor, isUuid } from "../common/ids.js";
import { queryAssets, rightsSql, type AssetDto } from "./repo.js";
import { loadPrefs } from "../me/routes.js";
import { MOTIVATION_TOPICS } from "../ingestion/sources.js";

export const ASSET_TYPES = ["music", "speech", "podcast_episode", "loop", "stem", "sound_effect"] as const;

export async function explicitAllowed(deps: AppDeps, req: FastifyRequest): Promise<boolean> {
  if (!req.user) return false;
  return (await loadPrefs(deps, req.user.id)).explicitAllowed;
}

export interface Shelf {
  id: string;
  title: string;
  kind: "assets" | "shows" | "mixes" | "topics";
  items: unknown[];
}

export async function showsList(deps: AppDeps, where: string, params: unknown[], limit: number) {
  return deps.db.query(
    `SELECT s.id, s.title, s.description, s.artwork_url AS "artworkUrl", s.categories, s.show_kind AS "showKind", s.language,
       c.name AS "creatorName", s.creator_id AS "creatorId",
       (SELECT count(*)::int FROM audio_assets a WHERE a.show_id = s.id AND a.is_active) AS "episodeCount"
     FROM shows s LEFT JOIN creators c ON c.id = s.creator_id
     WHERE s.is_active ${where} ORDER BY s.title LIMIT ${Math.min(100, limit)}`,
    params,
  );
}

export function catalogueRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { db } = deps;

  app.get("/v1/genres", async () => {
    const rows = await db.query<{ genre: string; n: number }>(
      `SELECT unnest(genres) AS genre, count(*)::int AS n FROM audio_assets WHERE is_active GROUP BY 1 ORDER BY n DESC, genre LIMIT 40`,
    );
    return {
      items: rows.map((r) => ({
        id: r.genre,
        name: r.genre.replace(/(^|[-\s])\w/g, (m) => m.toUpperCase()),
        assetCount: r.n,
      })),
    };
  });

  app.get("/v1/moods", async () => {
    const rows = await db.query<{ mood: string; n: number }>(
      `SELECT unnest(moods) AS mood, count(*)::int AS n FROM audio_assets WHERE is_active GROUP BY 1 ORDER BY n DESC, mood LIMIT 40`,
    );
    return {
      items: rows.map((r) => ({
        id: r.mood,
        name: r.mood[0]!.toUpperCase() + r.mood.slice(1),
        assetCount: r.n,
      })),
    };
  });

  app.get<{
    Querystring: {
      type?: string;
      genre?: string;
      mood?: string;
      topic?: string;
      mixable?: string;
      cursor?: string;
      limit?: string;
      language?: string;
      maxDurationMs?: string;
      minDurationMs?: string;
    };
  }>("/v1/catalogue", async (req) => {
    const q = req.query;
    const limit = Math.max(1, Math.min(50, Number(q.limit ?? 20)));
    const offset = decodeCursor(q.cursor);
    const territory = territoryOf(req, deps.config.defaultTerritory);
    const params: unknown[] = [territory, deps.now()];
    const where: string[] = ["a.is_active", rightsSql("stream", 1, 2)];
    if (q.type) {
      const types = q.type.split(",").filter((t) => (ASSET_TYPES as readonly string[]).includes(t));
      if (types.length === 0) throw new ApiError("VALIDATION_FAILED", "Unknown asset type.");
      params.push(types);
      where.push(`a.asset_type = ANY($${params.length}::text[])`);
    }
    if (q.genre) {
      params.push(q.genre.toLowerCase());
      where.push(`$${params.length} = ANY(a.genres)`);
    }
    if (q.mood) {
      params.push(q.mood.toLowerCase());
      where.push(`$${params.length} = ANY(a.moods)`);
    }
    if (q.topic) {
      params.push(q.topic.toLowerCase());
      where.push(`$${params.length} = ANY(a.topics)`);
    }
    if (q.language) {
      params.push(q.language);
      where.push(`a.language = $${params.length}`);
    }
    if (q.maxDurationMs) {
      params.push(Number(q.maxDurationMs));
      where.push(`a.duration_ms <= $${params.length}`);
    }
    if (q.minDurationMs) {
      params.push(Number(q.minDurationMs));
      where.push(`a.duration_ms >= $${params.length}`);
    }
    if (q.mixable === "true") where.push(rightsSql("mix", 1, 2));
    if (!(await explicitAllowed(deps, req))) where.push("NOT a.is_explicit");
    const items = await queryAssets(
      db,
      `WHERE ${where.join(" AND ")} ORDER BY a.is_dev_fixture ASC, a.popularity DESC, a.release_date DESC NULLS LAST, a.title, a.id LIMIT ${limit + 1} OFFSET ${offset}`,
      params,
      territory,
      deps.now(),
    );
    return {
      items: items.slice(0, limit),
      nextCursor: items.length > limit ? encodeCursor(offset + limit) : null,
    };
  });

  app.get<{ Params: { assetId: string } }>("/v1/assets/:assetId", async (req) => {
    if (!isUuid(req.params.assetId)) throw notFound("Audio");
    const territory = territoryOf(req, deps.config.defaultTerritory);
    const [asset] = await queryAssets(db, `WHERE a.id = $1`, [req.params.assetId], territory, deps.now());
    if (!asset) throw notFound("Audio");
    const chapters = await db.query(
      `SELECT start_ms AS "startMs", title FROM chapters WHERE asset_id = $1 ORDER BY start_ms`,
      [asset.id],
    );
    const hasTranscript = !!(await db.one(
      `SELECT 1 FROM transcript_segments WHERE asset_id = $1 UNION ALL SELECT 1 FROM asset_storage WHERE asset_id = $1 AND transcript_url IS NOT NULL LIMIT 1`,
      [asset.id],
    ));
    let liked = false;
    if (req.user)
      liked = !!(await db.one(`SELECT 1 FROM likes WHERE user_id = $1 AND asset_id = $2`, [
        req.user.id,
        asset.id,
      ]));
    return { ...asset, chapters, hasTranscript, liked };
  });

  app.get<{ Params: { creatorId: string } }>("/v1/creators/:creatorId", async (req) => {
    if (!isUuid(req.params.creatorId)) throw notFound("Creator");
    const c = await db.one(
      `SELECT id, name, creator_type AS "creatorType", bio, image_url AS "imageUrl", website_url AS "websiteUrl" FROM creators WHERE id = $1`,
      [req.params.creatorId],
    );
    if (!c) throw notFound("Creator");
    const territory = territoryOf(req, deps.config.defaultTerritory);
    const assets = await queryAssets(
      db,
      `WHERE a.creator_id = $3 AND a.is_active AND ${rightsSql("stream", 1, 2)} ORDER BY a.popularity DESC, a.title LIMIT 50`,
      [territory, deps.now(), req.params.creatorId],
      territory,
      deps.now(),
    );
    const shows = await showsList(deps, `AND s.creator_id = $1`, [req.params.creatorId], 20);
    let following = false;
    if (req.user)
      following = !!(await db.one(
        `SELECT 1 FROM follows WHERE user_id = $1 AND target_type = 'creator' AND target_id = $2`,
        [req.user.id, req.params.creatorId],
      ));
    return { ...c, assets, shows, following };
  });

  app.get<{ Params: { collectionId: string } }>("/v1/collections/:collectionId", async (req) => {
    const key = req.params.collectionId;
    const col = await db.one<{
      id: string;
      slug: string;
      title: string;
      description: string | null;
      artwork_url: string | null;
    }>(
      isUuid(key) ? `SELECT * FROM collections WHERE id = $1` : `SELECT * FROM collections WHERE slug = $1`,
      [key],
    );
    if (!col) throw notFound("Collection");
    const territory = territoryOf(req, deps.config.defaultTerritory);
    const items = await queryAssets(
      db,
      `JOIN collection_items ci ON ci.asset_id = a.id WHERE ci.collection_id = $3 AND a.is_active AND ${rightsSql("stream", 1, 2)} ORDER BY ci.position`,
      [territory, deps.now(), col.id],
      territory,
      deps.now(),
    );
    return {
      id: col.id,
      slug: col.slug,
      title: col.title,
      description: col.description,
      artworkUrl: col.artwork_url ?? items[0]?.artworkUrl ?? null,
      items,
    };
  });

  app.get("/v1/collections", async () => {
    const rows = await db.query(
      `SELECT c.id, c.slug, c.title, c.description,
         (SELECT a.artwork_url FROM collection_items ci JOIN audio_assets a ON a.id = ci.asset_id WHERE ci.collection_id = c.id AND a.artwork_url IS NOT NULL ORDER BY ci.position LIMIT 1) AS "artworkUrl",
         (SELECT count(*)::int FROM collection_items ci WHERE ci.collection_id = c.id) AS "itemCount"
       FROM collections c ORDER BY c.title`,
    );
    return { items: rows };
  });

  app.get("/v1/home", async (req) => {
    const territory = territoryOf(req, deps.config.defaultTerritory);
    const now = deps.now();
    const explicitOk = await explicitAllowed(deps, req);
    const base = `a.is_active AND ${rightsSql("stream", 1, 2)} ${explicitOk ? "" : "AND NOT a.is_explicit"}`;
    const shelves: Shelf[] = [];
    if (req.user) {
      const cont = await queryAssets(
        db,
        `JOIN playback_progress p ON p.asset_id = a.id AND p.user_id = $3 WHERE ${base} AND NOT p.completed AND p.position_ms > 5000 ORDER BY p.updated_at DESC LIMIT 10`,
        [territory, now, req.user.id],
        territory,
        now,
      );
      if (cont.length)
        shelves.push({ id: "continue", title: "Continue listening", kind: "assets", items: cont });
      const recs = await deps.recommendations.forUser(req.user.id, territory, 12);
      if (recs.length)
        shelves.push({ id: "for-you", title: "Made for your mood", kind: "assets", items: recs });
    }
    const featured = await dailyFeaturedSpeech(deps, territory);
    if (featured)
      shelves.push({ id: "daily-motivation", title: "Daily motivation", kind: "assets", items: [featured] });
    const popular = await queryAssets(
      db,
      `WHERE ${base} AND a.asset_type = 'music' ORDER BY a.popularity DESC, a.title LIMIT 12`,
      [territory, now],
      territory,
      now,
    );
    if (popular.length)
      shelves.push({ id: "popular", title: "Free & open music", kind: "assets", items: popular });
    const genres = await db.query<{ genre: string }>(
      `SELECT unnest(genres) AS genre, count(*) n FROM audio_assets WHERE is_active GROUP BY 1 ORDER BY n DESC LIMIT 10`,
    );
    shelves.push({
      id: "genres",
      title: "Popular genres",
      kind: "topics",
      items: genres.map((g) => ({ id: g.genre, name: g.genre })),
    });
    const shows = await showsList(deps, `AND s.show_kind = 'podcast'`, [], 10);
    if (shows.length)
      shelves.push({ id: "podcasts", title: "Recommended podcasts", kind: "shows", items: shows });
    const loops = await queryAssets(
      db,
      `WHERE ${base} AND ${rightsSql("mix", 1, 2)} AND a.asset_type IN ('loop','stem') ORDER BY a.title LIMIT 10`,
      [territory, now],
      territory,
      now,
    );
    if (loops.length)
      shelves.push({ id: "fusion-ready", title: "Fusion-ready sounds", kind: "assets", items: loops });
    if (req.user) {
      const mixes = await db.query(
        `SELECT id, name, duration_ms AS "durationMs", updated_at AS "updatedAt", rights_validation_status AS "rightsValidationStatus" FROM mix_recipes WHERE owner_id = $1 AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 10`,
        [req.user.id],
      );
      if (mixes.length)
        shelves.push({ id: "recent-mixes", title: "Recently created AI mixes", kind: "mixes", items: mixes });
    }
    const hour = now.getUTCHours();
    return { greeting: hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening", shelves };
  });

  app.get("/v1/motivation/topics", async () => {
    const rows = await db.query<{ topic: string; n: number }>(
      `SELECT unnest(topics) AS topic, count(*)::int AS n FROM audio_assets WHERE is_active AND asset_type IN ('speech','podcast_episode') GROUP BY 1`,
    );
    const counts = new Map(rows.map((r) => [r.topic, r.n]));
    return {
      items: MOTIVATION_TOPICS.map((t) => ({
        id: t,
        name: t[0]!.toUpperCase() + t.slice(1),
        assetCount: counts.get(t) ?? 0,
      })),
    };
  });

  app.get<{ Querystring: { topic?: string } }>("/v1/motivation/featured", async (req) => {
    const territory = territoryOf(req, deps.config.defaultTerritory);
    const now = deps.now();
    const featured = await dailyFeaturedSpeech(deps, territory);
    const params: unknown[] = [territory, now];
    let topicSql = "";
    if (req.query.topic) {
      params.push(req.query.topic.toLowerCase());
      topicSql = `AND $3 = ANY(a.topics)`;
    }
    const base = `WHERE a.is_active AND ${rightsSql("stream", 1, 2)} AND a.asset_type IN ('speech','podcast_episode') AND cardinality(a.topics) > 0 ${topicSql}`;
    const short = await queryAssets(
      db,
      `${base} AND a.duration_ms <= 600000 ORDER BY a.popularity DESC, a.title LIMIT 12`,
      params,
      territory,
      now,
    );
    const long = await queryAssets(
      db,
      `${base} AND a.duration_ms > 600000 ORDER BY a.popularity DESC, a.title LIMIT 12`,
      params,
      territory,
      now,
    );
    const speakers = await db.query(
      `SELECT DISTINCT c.id, c.name, c.creator_type AS "creatorType" FROM creators c JOIN audio_assets a ON a.creator_id = c.id
       WHERE a.asset_type = 'speech' AND a.is_active ORDER BY c.name LIMIT 20`,
    );
    return { featured, short, long, speakers };
  });
}

/** Deterministic "speech of the day": rotates daily through streamable speeches. */
export async function dailyFeaturedSpeech(deps: AppDeps, territory: string): Promise<AssetDto | null> {
  const now = deps.now();
  const all = await queryAssets(
    deps.db,
    `WHERE a.is_active AND a.asset_type = 'speech' AND NOT a.is_dev_fixture AND ${rightsSql("stream", 1, 2)} ORDER BY a.id`,
    [territory, now],
    territory,
    now,
  );
  const pool =
    all.length > 0
      ? all
      : await queryAssets(
          deps.db,
          `WHERE a.is_active AND a.asset_type = 'speech' AND ${rightsSql("stream", 1, 2)} ORDER BY a.id`,
          [territory, now],
          territory,
          now,
        );
  if (pool.length === 0) return null;
  const day = Math.floor(now.getTime() / 86_400_000);
  return pool[day % pool.length]!;
}
