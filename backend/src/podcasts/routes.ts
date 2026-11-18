import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../common/context.js";
import { requireUser, territoryOf } from "../common/context.js";
import { ApiError, notFound } from "../common/errors.js";
import { decodeCursor, encodeCursor, isUuid, uuid } from "../common/ids.js";
import { queryAssets, rightsSql } from "../catalogue/repo.js";
import { showsList } from "../catalogue/routes.js";
import { getJson, getText } from "../ingestion/http.js";
import { parseCaptions } from "../transcripts/parse.js";
import { SYNTHETIC_SPECS, syntheticAssetId } from "../ingestion/synthetic.js";

export function podcastRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { db } = deps;

  app.get<{ Querystring: { category?: string; kind?: string } }>("/v1/podcasts", async (req) => {
    const params: unknown[] = [];
    let where = "";
    if (req.query.category) {
      params.push(req.query.category.toLowerCase());
      where += ` AND $${params.length} = ANY(s.categories)`;
    }
    if (req.query.kind === "podcast" || req.query.kind === "speech_series") {
      params.push(req.query.kind);
      where += ` AND s.show_kind = $${params.length}`;
    }
    let followed: string[] = [];
    if (req.user)
      followed = (
        await db.query<{ target_id: string }>(
          `SELECT target_id FROM follows WHERE user_id = $1 AND target_type = 'show'`,
          [req.user.id],
        )
      ).map((r) => r.target_id);
    const items = (await showsList(deps, where, params, 100)) as { id: string }[];
    return { items: items.map((s) => ({ ...s, following: followed.includes(s.id) })) };
  });

  app.get<{ Params: { showId: string } }>("/v1/podcasts/:showId", async (req) => {
    if (!isUuid(req.params.showId)) throw notFound("Show");
    const [show] = (await showsList(deps, `AND s.id = $1`, [req.params.showId], 1)) as Record<
      string,
      unknown
    >[];
    if (!show) throw notFound("Show");
    let following = false;
    if (req.user)
      following = !!(await db.one(
        `SELECT 1 FROM follows WHERE user_id = $1 AND target_type = 'show' AND target_id = $2`,
        [req.user.id, req.params.showId],
      ));
    return { ...show, following };
  });

  app.get<{ Params: { showId: string }; Querystring: { cursor?: string; limit?: string } }>(
    "/v1/podcasts/:showId/episodes",
    async (req) => {
      if (!isUuid(req.params.showId)) throw notFound("Show");
      const territory = territoryOf(req, deps.config.defaultTerritory);
      const limit = Math.max(1, Math.min(50, Number(req.query.limit ?? 20)));
      const offset = decodeCursor(req.query.cursor);
      const items = await queryAssets(
        db,
        `WHERE a.show_id = $3 AND a.is_active AND ${rightsSql("stream", 1, 2)} ORDER BY a.release_date DESC NULLS LAST, a.episode_number ASC NULLS LAST, a.title LIMIT ${limit + 1} OFFSET ${offset}`,
        [territory, deps.now(), req.params.showId],
        territory,
        deps.now(),
      );
      let progress = new Map<string, { positionMs: number; completed: boolean }>();
      if (req.user && items.length) {
        const rows = await db.query<{ asset_id: string; position_ms: number; completed: boolean }>(
          `SELECT asset_id, position_ms, completed FROM playback_progress WHERE user_id = $1 AND asset_id = ANY($2::uuid[])`,
          [req.user.id, items.map((i) => i.id)],
        );
        progress = new Map(
          rows.map((r) => [r.asset_id, { positionMs: r.position_ms, completed: r.completed }]),
        );
      }
      return {
        items: items.slice(0, limit).map((i) => ({ ...i, progress: progress.get(i.id) ?? null })),
        nextCursor: items.length > limit ? encodeCursor(offset + limit) : null,
      };
    },
  );

  app.get<{ Params: { episodeId: string } }>("/v1/episodes/:episodeId", async (req) => {
    if (!isUuid(req.params.episodeId)) throw notFound("Episode");
    const territory = territoryOf(req, deps.config.defaultTerritory);
    const [ep] = await queryAssets(
      db,
      `WHERE a.id = $1 AND a.asset_type IN ('podcast_episode','speech')`,
      [req.params.episodeId],
      territory,
      deps.now(),
    );
    if (!ep) throw notFound("Episode");
    const chapters = await loadChapters(deps, ep.id);
    let bookmarks: unknown[] = [];
    let progress = null;
    if (req.user) {
      bookmarks = await db.query(
        `SELECT id, asset_id AS "assetId", position_ms AS "positionMs", note, created_at AS "createdAt" FROM bookmarks WHERE user_id = $1 AND asset_id = $2 ORDER BY position_ms`,
        [req.user.id, ep.id],
      );
      const p = await db.one<{ position_ms: number; completed: boolean }>(
        `SELECT position_ms, completed FROM playback_progress WHERE user_id = $1 AND asset_id = $2`,
        [req.user.id, ep.id],
      );
      progress = p ? { positionMs: p.position_ms, completed: p.completed } : null;
    }
    const hasTranscript = !!(await db.one(
      `SELECT 1 FROM transcript_segments WHERE asset_id = $1 UNION ALL SELECT 1 FROM asset_storage WHERE asset_id = $1 AND transcript_url IS NOT NULL LIMIT 1`,
      [ep.id],
    ));
    return { ...ep, chapters, bookmarks, progress, hasTranscript };
  });

  app.get<{ Params: { assetId: string } }>("/v1/assets/:assetId/transcript", async (req) => {
    if (!isUuid(req.params.assetId)) throw notFound("Transcript");
    const segments = await loadTranscript(deps, req.params.assetId);
    if (segments.length === 0) throw notFound("Transcript");
    return { assetId: req.params.assetId, segments };
  });

  app.get<{ Params: { assetId: string } }>("/v1/assets/:assetId/bookmarks", async (req) => {
    const me = requireUser(req);
    if (!isUuid(req.params.assetId)) throw notFound("Audio");
    const items = await db.query(
      `SELECT id, asset_id AS "assetId", position_ms AS "positionMs", note, created_at AS "createdAt" FROM bookmarks WHERE user_id = $1 AND asset_id = $2 ORDER BY position_ms`,
      [me.id, req.params.assetId],
    );
    return { items };
  });

  app.post<{ Params: { assetId: string }; Body: { positionMs: number; note?: string } }>(
    "/v1/assets/:assetId/bookmarks",
    {
      schema: {
        body: {
          type: "object",
          required: ["positionMs"],
          additionalProperties: false,
          properties: {
            positionMs: { type: "integer", minimum: 0 },
            note: { type: "string", maxLength: 280 },
          },
        },
      },
    },
    async (req, reply) => {
      const me = requireUser(req);
      if (!isUuid(req.params.assetId)) throw notFound("Audio");
      const asset = await db.one<{ duration_ms: number }>(
        `SELECT duration_ms FROM audio_assets WHERE id = $1`,
        [req.params.assetId],
      );
      if (!asset) throw notFound("Audio");
      if (asset.duration_ms > 0 && req.body.positionMs > asset.duration_ms)
        throw new ApiError("VALIDATION_FAILED", "Bookmark is past the end of the audio.");
      const id = uuid();
      const row = await db.one(
        `INSERT INTO bookmarks (id, user_id, asset_id, position_ms, note) VALUES ($1,$2,$3,$4,$5)
         RETURNING id, asset_id AS "assetId", position_ms AS "positionMs", note, created_at AS "createdAt"`,
        [id, me.id, req.params.assetId, req.body.positionMs, req.body.note ?? null],
      );
      reply.code(201);
      return {
        ...row,
        shareUrl: `${deps.config.publicBaseUrl}/listen/${req.params.assetId}?t=${Math.floor(req.body.positionMs / 1000)}`,
      };
    },
  );

  app.delete<{ Params: { bookmarkId: string } }>("/v1/bookmarks/:bookmarkId", async (req, reply) => {
    const me = requireUser(req);
    if (!isUuid(req.params.bookmarkId)) throw notFound("Bookmark");
    const res = await db.query(`DELETE FROM bookmarks WHERE id = $1 AND user_id = $2 RETURNING id`, [
      req.params.bookmarkId,
      me.id,
    ]);
    if (res.length === 0) throw notFound("Bookmark");
    reply.code(204);
    return null;
  });
}

/** Transcripts: cached segments, else fetched once from the publisher's podcast:transcript (VTT/SRT). */
export async function loadTranscript(deps: AppDeps, assetId: string) {
  const sel = () =>
    deps.db.query<{ id: string; startMs: number; endMs: number; text: string; speaker: string | null }>(
      `SELECT id, start_ms AS "startMs", end_ms AS "endMs", text, speaker FROM transcript_segments WHERE asset_id = $1 ORDER BY start_ms`,
      [assetId],
    );
  const cached = await sel();
  if (cached.length) return cached;
  const st = await deps.db.one<{ transcript_url: string | null }>(
    `SELECT transcript_url FROM asset_storage WHERE asset_id = $1`,
    [assetId],
  );
  if (!st?.transcript_url) return [];
  try {
    const cues = parseCaptions(await getText(deps.fetch, st.transcript_url, 15000));
    await deps.db.tx(async (t) => {
      for (const c of cues) {
        await t.query(
          `INSERT INTO transcript_segments (id, asset_id, start_ms, end_ms, text, speaker) VALUES ($1,$2,$3,$4,$5,$6)`,
          [uuid(), assetId, c.startMs, c.endMs, c.text, c.speaker],
        );
      }
    });
  } catch {
    return [];
  }
  return sel();
}

export async function loadChapters(deps: AppDeps, assetId: string) {
  const sel = () =>
    deps.db.query<{ startMs: number; title: string }>(
      `SELECT start_ms AS "startMs", title FROM chapters WHERE asset_id = $1 ORDER BY start_ms`,
      [assetId],
    );
  const cached = await sel();
  if (cached.length) return cached;
  const st = await deps.db.one<{ chapters_url: string | null }>(
    `SELECT chapters_url FROM asset_storage WHERE asset_id = $1`,
    [assetId],
  );
  if (!st?.chapters_url) return [];
  try {
    const json = await getJson<{ chapters?: { startTime?: number; title?: string }[] }>(
      deps.fetch,
      st.chapters_url,
      10000,
    );
    for (const c of (json.chapters ?? []).slice(0, 200)) {
      if (typeof c.startTime !== "number" || !c.title) continue;
      await deps.db.query(`INSERT INTO chapters (id, asset_id, start_ms, title) VALUES ($1,$2,$3,$4)`, [
        uuid(),
        assetId,
        Math.round(c.startTime * 1000),
        c.title.slice(0, 200),
      ]);
    }
  } catch {
    return [];
  }
  return sel();
}

/** Synthetic transcript + chapters for the dev "Voice Guide" fixture so transcript UI is testable offline. */
export async function seedSyntheticTranscript(deps: AppDeps): Promise<void> {
  const spec = SYNTHETIC_SPECS.find((s) => s.key === "voice-guide");
  if (!spec) return;
  const id = syntheticAssetId(spec.key);
  if (await deps.db.one(`SELECT 1 FROM transcript_segments WHERE asset_id = $1`, [id])) return;
  const lines = [
    "This is the VibeFusion voice guide test signal.",
    "Each phrase is a synthetic speech-shaped tone.",
    "Use it to check transcripts, bookmarks and ducking.",
    "Keep moving forward, one step at a time.",
    "Discipline is choosing what you want most over what you want now.",
    "Breathe in, and begin again.",
    "Small actions repeated daily become who you are.",
    "Session complete. Well done.",
    "End of test signal.",
    "Thank you for listening.",
  ];
  for (let i = 0; i < lines.length; i++) {
    await deps.db.query(
      `INSERT INTO transcript_segments (id, asset_id, start_ms, end_ms, text, speaker) VALUES ($1,$2,$3,$4,$5,'Guide')`,
      [uuid(), id, i * 4000, i * 4000 + 3200, lines[i]],
    );
  }
  await deps.db.query(
    `INSERT INTO chapters (id, asset_id, start_ms, title) VALUES ($1,$2,0,'Introduction'),($3,$2,12000,'Mindset'),($4,$2,28000,'Close')`,
    [uuid(), id, uuid(), uuid()],
  );
}
