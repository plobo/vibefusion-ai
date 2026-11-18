import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../common/context.js";
import { requireUser, territoryOf } from "../common/context.js";
import { ApiError, notFound } from "../common/errors.js";
import { isUuid } from "../common/ids.js";
import { queryAssets } from "../catalogue/repo.js";
import { showsList } from "../catalogue/routes.js";

export function libraryRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { db } = deps;

  const likedAssets = (userId: string, territory: string, typeSql: string) =>
    queryAssets(
      db,
      `JOIN likes l ON l.asset_id = a.id AND l.user_id = $1 WHERE ${typeSql} ORDER BY l.created_at DESC LIMIT 200`,
      [userId],
      territory,
      deps.now(),
    );

  app.get("/v1/library", async (req) => {
    const me = requireUser(req);
    const territory = territoryOf(req, deps.config.defaultTerritory);
    const [music, saved, playlists, mixes, follows] = await Promise.all([
      likedAssets(me.id, territory, `a.asset_type IN ('music','loop','stem','sound_effect')`),
      likedAssets(me.id, territory, `a.asset_type IN ('speech','podcast_episode')`),
      db.query(
        `SELECT p.id, p.name, p.description, p.visibility, p.version, p.updated_at AS "updatedAt",
           (SELECT count(*)::int FROM playlist_items i WHERE i.playlist_id = p.id) AS "itemCount"
         FROM playlists p WHERE p.owner_id = $1 AND p.deleted_at IS NULL ORDER BY p.updated_at DESC`,
        [me.id],
      ),
      db.query(
        `SELECT id, name, duration_ms AS "durationMs", rights_validation_status AS "rightsValidationStatus", updated_at AS "updatedAt"
         FROM mix_recipes WHERE owner_id = $1 AND deleted_at IS NULL ORDER BY updated_at DESC`,
        [me.id],
      ),
      showsList(
        deps,
        `AND s.id IN (SELECT target_id FROM follows WHERE user_id = $1 AND target_type = 'show')`,
        [me.id],
        100,
      ),
    ]);
    return {
      likedMusic: music,
      savedEpisodes: saved,
      playlists,
      mixes,
      followedShows: follows,
      syncedAt: deps.now().toISOString(),
    };
  });

  app.get("/v1/library/likes", async (req) => {
    const me = requireUser(req);
    const rows = await db.query<{ asset_id: string; created_at: Date }>(
      `SELECT asset_id, created_at FROM likes WHERE user_id = $1 ORDER BY created_at DESC`,
      [me.id],
    );
    return {
      items: rows.map((r) => ({ assetId: r.asset_id, likedAt: new Date(r.created_at).toISOString() })),
    };
  });

  app.put<{ Params: { assetId: string } }>("/v1/library/likes/:assetId", async (req, reply) => {
    const me = requireUser(req);
    if (
      !isUuid(req.params.assetId) ||
      !(await db.one(`SELECT 1 FROM audio_assets WHERE id = $1`, [req.params.assetId]))
    )
      throw notFound("Audio");
    await db.query(`INSERT INTO likes (user_id, asset_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [
      me.id,
      req.params.assetId,
    ]);
    reply.code(204);
    return null;
  });

  app.delete<{ Params: { assetId: string } }>("/v1/library/likes/:assetId", async (req, reply) => {
    const me = requireUser(req);
    if (!isUuid(req.params.assetId)) throw notFound("Audio");
    await db.query(`DELETE FROM likes WHERE user_id = $1 AND asset_id = $2`, [me.id, req.params.assetId]);
    reply.code(204);
    return null;
  });

  // Follows (shows and creators).
  for (const targetType of ["show", "creator"] as const) {
    const path = targetType === "show" ? "/v1/podcasts/:id/follow" : "/v1/creators/:id/follow";
    app.put<{ Params: { id: string } }>(path, async (req, reply) => {
      const me = requireUser(req);
      if (!isUuid(req.params.id)) throw notFound();
      const table = targetType === "show" ? "shows" : "creators";
      if (!(await db.one(`SELECT 1 FROM ${table} WHERE id = $1`, [req.params.id]))) throw notFound();
      await db.query(
        `INSERT INTO follows (user_id, target_type, target_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
        [me.id, targetType, req.params.id],
      );
      reply.code(204);
      return null;
    });
    app.delete<{ Params: { id: string } }>(path, async (req, reply) => {
      const me = requireUser(req);
      if (!isUuid(req.params.id)) throw new ApiError("NOT_FOUND", "Not found.");
      await db.query(`DELETE FROM follows WHERE user_id = $1 AND target_type = $2 AND target_id = $3`, [
        me.id,
        targetType,
        req.params.id,
      ]);
      reply.code(204);
      return null;
    });
  }
}
