import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../common/context.js";
import { requireUser } from "../common/context.js";
import { notFound } from "../common/errors.js";
import { loadUser, userDto } from "../auth/routes.js";

interface PrefRow {
  genres: string[];
  moods: string[];
  speech_topics: string[];
  explicit_allowed: boolean;
  analytics_opt_in: boolean;
  ai_processing_consent: boolean;
}

export const prefsDto = (p: PrefRow | undefined) => ({
  genres: p?.genres ?? [],
  moods: p?.moods ?? [],
  speechTopics: p?.speech_topics ?? [],
  explicitAllowed: p?.explicit_allowed ?? false,
  analyticsOptIn: p?.analytics_opt_in ?? true,
  aiProcessingConsent: p?.ai_processing_consent ?? false,
});

export async function loadPrefs(deps: AppDeps, userId: string) {
  return prefsDto(await deps.db.one<PrefRow>(`SELECT * FROM user_preferences WHERE user_id = $1`, [userId]));
}

export function meRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { db } = deps;

  app.get("/v1/me", async (req) => {
    const me = requireUser(req);
    const u = await loadUser(deps, me.id);
    if (!u) throw notFound("Account");
    return { ...userDto(u), preferences: await loadPrefs(deps, me.id) };
  });

  app.patch<{ Body: { displayName?: string; locale?: string; territory?: string } }>(
    "/v1/me",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          properties: {
            displayName: { type: "string", minLength: 1, maxLength: 80 },
            locale: { type: "string", maxLength: 10 },
            territory: { type: "string", pattern: "^[A-Z]{2}$" },
          },
        },
      },
    },
    async (req) => {
      const me = requireUser(req);
      await db.query(
        `UPDATE users SET display_name = COALESCE($2, display_name), locale = COALESCE($3, locale), territory = COALESCE($4, territory), updated_at = now() WHERE id = $1`,
        [me.id, req.body.displayName ?? null, req.body.locale ?? null, req.body.territory ?? null],
      );
      const u = await loadUser(deps, me.id);
      return userDto(u!);
    },
  );

  app.get("/v1/me/preferences", async (req) => loadPrefs(deps, requireUser(req).id));

  app.put<{
    Body: {
      genres?: string[];
      moods?: string[];
      speechTopics?: string[];
      explicitAllowed?: boolean;
      analyticsOptIn?: boolean;
      aiProcessingConsent?: boolean;
    };
  }>(
    "/v1/me/preferences",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          properties: {
            genres: { type: "array", maxItems: 20, items: { type: "string", maxLength: 40 } },
            moods: { type: "array", maxItems: 20, items: { type: "string", maxLength: 40 } },
            speechTopics: { type: "array", maxItems: 20, items: { type: "string", maxLength: 40 } },
            explicitAllowed: { type: "boolean" },
            analyticsOptIn: { type: "boolean" },
            aiProcessingConsent: { type: "boolean" },
          },
        },
      },
    },
    async (req) => {
      const me = requireUser(req);
      const cur = await loadPrefs(deps, me.id);
      const b = req.body;
      await db.query(
        `INSERT INTO user_preferences (user_id, genres, moods, speech_topics, explicit_allowed, analytics_opt_in, ai_processing_consent, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7, now())
         ON CONFLICT (user_id) DO UPDATE SET genres = EXCLUDED.genres, moods = EXCLUDED.moods, speech_topics = EXCLUDED.speech_topics,
           explicit_allowed = EXCLUDED.explicit_allowed, analytics_opt_in = EXCLUDED.analytics_opt_in,
           ai_processing_consent = EXCLUDED.ai_processing_consent, updated_at = now()`,
        [
          me.id,
          b.genres ?? cur.genres,
          b.moods ?? cur.moods,
          b.speechTopics ?? cur.speechTopics,
          b.explicitAllowed ?? cur.explicitAllowed,
          b.analyticsOptIn ?? cur.analyticsOptIn,
          b.aiProcessingConsent ?? cur.aiProcessingConsent,
        ],
      );
      return loadPrefs(deps, me.id);
    },
  );

  /** Data export (privacy): everything the service stores about the user. */
  app.get("/v1/me/export", async (req) => {
    const me = requireUser(req);
    const u = await loadUser(deps, me.id);
    if (!u) throw notFound("Account");
    const [likes, playlists, items, progress, bookmarks, recipes, follows] = await Promise.all([
      db.query(`SELECT asset_id, created_at FROM likes WHERE user_id = $1`, [me.id]),
      db.query(
        `SELECT id, name, description, visibility, created_at, updated_at FROM playlists WHERE owner_id = $1 AND deleted_at IS NULL`,
        [me.id],
      ),
      db.query(
        `SELECT pi.playlist_id, pi.asset_id, pi.position FROM playlist_items pi JOIN playlists p ON p.id = pi.playlist_id WHERE p.owner_id = $1`,
        [me.id],
      ),
      db.query(
        `SELECT asset_id, position_ms, completed, updated_at FROM playback_progress WHERE user_id = $1`,
        [me.id],
      ),
      db.query(`SELECT asset_id, position_ms, note, created_at FROM bookmarks WHERE user_id = $1`, [me.id]),
      db.query(
        `SELECT id, name, prompt, mix_plan, created_at FROM mix_recipes WHERE owner_id = $1 AND deleted_at IS NULL`,
        [me.id],
      ),
      db.query(`SELECT target_type, target_id, created_at FROM follows WHERE user_id = $1`, [me.id]),
    ]);
    return {
      exportedAt: deps.now().toISOString(),
      account: userDto(u),
      preferences: await loadPrefs(deps, me.id),
      likes,
      playlists,
      playlistItems: items,
      progress,
      bookmarks,
      recipes,
      follows,
    };
  });

  /** Account deletion: personal data is purged; the account row is tombstoned for audit. */
  app.delete("/v1/me", async (req, reply) => {
    const me = requireUser(req);
    await db.tx(async (t) => {
      for (const sql of [
        `DELETE FROM likes WHERE user_id = $1`,
        `DELETE FROM follows WHERE user_id = $1`,
        `DELETE FROM playback_progress WHERE user_id = $1`,
        `DELETE FROM bookmarks WHERE user_id = $1`,
        `DELETE FROM playlists WHERE owner_id = $1`,
        `DELETE FROM mix_recipes WHERE owner_id = $1`,
        `DELETE FROM user_preferences WHERE user_id = $1`,
        `DELETE FROM ai_usage WHERE user_id = $1`,
        `UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1`,
        `UPDATE users SET deleted_at = now(), email = 'deleted-' || id || '@deleted.invalid', display_name = 'Deleted', password_hash = NULL, avatar_url = NULL WHERE id = $1`,
      ]) {
        await t.query(sql, [me.id]);
      }
      await t.query(
        `INSERT INTO audit_log (actor_id, action, target_type, target_id) VALUES ($1::uuid,'account_deleted','user',$1::text)`,
        [me.id],
      );
    });
    reply.code(204);
    return null;
  });
}
