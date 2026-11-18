import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../common/context.js";
import { territoryOf } from "../common/context.js";
import { ApiError } from "../common/errors.js";
import { queryAssets, rightsSql } from "../catalogue/repo.js";
import { explicitAllowed } from "../catalogue/routes.js";

/** Build a prefix tsquery from free text; only letters/digits survive (no query injection into tsquery syntax). */
export function toPrefixTsQuery(q: string): string | null {
  const toks = q
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .slice(0, 8);
  return toks.length ? toks.map((t) => `${t}:*`).join(" & ") : null;
}

export function searchRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { db } = deps;
  app.get<{
    Querystring: {
      q?: string;
      types?: string;
      genre?: string;
      mood?: string;
      maxDurationMs?: string;
      minDurationMs?: string;
      language?: string;
      content?: string;
      limit?: string;
    };
  }>("/v1/search", { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } }, async (req) => {
    const q = (req.query.q ?? "").trim();
    if (q.length === 0) throw new ApiError("VALIDATION_FAILED", "Enter something to search for.");
    if (q.length > 200) throw new ApiError("VALIDATION_FAILED", "Search text is too long.");
    const ts = toPrefixTsQuery(q);
    const limit = Math.max(1, Math.min(30, Number(req.query.limit ?? 10)));
    const types = new Set((req.query.types ?? "music,episode,speech,show,artist").split(","));
    const territory = territoryOf(req, deps.config.defaultTerritory);
    const now = deps.now();
    const like = `%${q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
    const params: unknown[] = [territory, now, ts ?? "", like];
    const filters: string[] = [];
    if (req.query.genre) {
      params.push(req.query.genre.toLowerCase());
      filters.push(`$${params.length} = ANY(a.genres)`);
    }
    if (req.query.mood) {
      params.push(req.query.mood.toLowerCase());
      filters.push(`$${params.length} = ANY(a.moods)`);
    }
    if (req.query.maxDurationMs) {
      params.push(Number(req.query.maxDurationMs));
      filters.push(`a.duration_ms <= $${params.length}`);
    }
    if (req.query.minDurationMs) {
      params.push(Number(req.query.minDurationMs));
      filters.push(`a.duration_ms >= $${params.length}`);
    }
    if (req.query.language) {
      params.push(req.query.language);
      filters.push(`a.language = $${params.length}`);
    }
    if (req.query.content === "music") filters.push(`a.asset_type IN ('music','loop','stem')`);
    if (req.query.content === "spoken") filters.push(`a.asset_type IN ('speech','podcast_episode')`);
    if (!(await explicitAllowed(deps, req))) filters.push("NOT a.is_explicit");
    const match = `(${ts ? `a.search_vector @@ to_tsquery('simple', $3) OR ` : ""}a.title ILIKE $4 ESCAPE '\\' OR c.name ILIKE $4 ESCAPE '\\' OR s.title ILIKE $4 ESCAPE '\\')`;
    const base = `WHERE a.is_active AND ${rightsSql("stream", 1, 2)} AND ${match} ${filters.map((f) => `AND ${f}`).join(" ")}`;
    const order = `ORDER BY ${ts ? `ts_rank(a.search_vector, to_tsquery('simple', $3)) DESC,` : ""} a.popularity DESC, a.title LIMIT ${limit}`;
    const run = (typeSql: string) =>
      queryAssets(db, `${base} AND ${typeSql} ${order}`, params, territory, now);
    const [tracks, episodes, speeches] = await Promise.all([
      types.has("music") ? run(`a.asset_type IN ('music','loop','stem')`) : Promise.resolve([]),
      types.has("episode") ? run(`a.asset_type = 'podcast_episode'`) : Promise.resolve([]),
      types.has("speech") ? run(`a.asset_type = 'speech'`) : Promise.resolve([]),
    ]);
    const shows = types.has("show")
      ? await db.query(
          `SELECT s.id, s.title, s.description, s.artwork_url AS "artworkUrl", s.show_kind AS "showKind", c.name AS "creatorName" FROM shows s
             LEFT JOIN creators c ON c.id = s.creator_id WHERE s.is_active AND (s.title ILIKE $1 ESCAPE '\\' OR c.name ILIKE $1 ESCAPE '\\') ORDER BY s.title LIMIT ${limit}`,
          [like],
        )
      : [];
    const artists = types.has("artist")
      ? await db.query(
          `SELECT c.id, c.name, c.creator_type AS "creatorType", c.image_url AS "imageUrl" FROM creators c WHERE c.name ILIKE $1 ESCAPE '\\' ORDER BY c.name LIMIT ${limit}`,
          [like],
        )
      : [];
    const albums = types.has("music")
      ? await db.query(
          `SELECT al.id, al.title, al.artwork_url AS "artworkUrl", c.name AS "creatorName" FROM albums al LEFT JOIN creators c ON c.id = al.creator_id
             WHERE al.title ILIKE $1 ESCAPE '\\' ORDER BY al.title LIMIT ${limit}`,
          [like],
        )
      : [];
    deps.metrics.inc("search_performed_total");
    return { query: q, tracks, albums, artists, shows, episodes, speeches };
  });
}
