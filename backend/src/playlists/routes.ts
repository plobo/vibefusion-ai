import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppDeps } from "../common/context.js";
import { requireUser, territoryOf } from "../common/context.js";
import { ApiError, notFound } from "../common/errors.js";
import { isUuid, uuid } from "../common/ids.js";
import type { Db } from "../db/db.js";
import { queryAssets } from "../catalogue/repo.js";
import { idempotent } from "../common/idempotency.js";

interface PlaylistRow {
  id: string;
  owner_id: string;
  name: string;
  description: string | null;
  artwork_url: string | null;
  visibility: string;
  version: number;
  created_at: Date;
  updated_at: Date;
}

/** Version check: client supplies If-Match: "<version>" or body.version. Server-authoritative ordering. */
function expectedVersion(req: FastifyRequest, body?: { version?: number }): number | null {
  const h = req.headers["if-match"];
  if (typeof h === "string" && h.trim()) {
    const n = Number(h.replace(/W\/|"/g, ""));
    if (Number.isInteger(n)) return n;
  }
  return typeof body?.version === "number" ? body.version : null;
}

async function loadOwned(db: Db, id: string, userId: string): Promise<PlaylistRow> {
  if (!isUuid(id)) throw notFound("Playlist");
  const p = await db.one<PlaylistRow>(`SELECT * FROM playlists WHERE id = $1 AND deleted_at IS NULL`, [id]);
  if (!p || p.owner_id !== userId) throw notFound("Playlist"); // do not reveal other users' playlists
  return p;
}

async function bump(db: Db, p: PlaylistRow, expected: number | null): Promise<void> {
  if (expected !== null && expected !== p.version) {
    throw new ApiError(
      "VERSION_CONFLICT",
      "This playlist changed on another device. Refresh to see the latest version.",
      { currentVersion: p.version },
    );
  }
  const res = await db.query(
    `UPDATE playlists SET version = version + 1, updated_at = now() WHERE id = $1 AND version = $2 RETURNING id`,
    [p.id, p.version],
  );
  if (res.length === 0)
    throw new ApiError(
      "VERSION_CONFLICT",
      "This playlist changed on another device. Refresh to see the latest version.",
    );
}

async function renumber(db: Db, playlistId: string, orderedIds: string[]): Promise<void> {
  // Two-phase renumber avoids transient unique(position) collisions.
  await db.query(`UPDATE playlist_items SET position = position + 100000 WHERE playlist_id = $1`, [
    playlistId,
  ]);
  for (let i = 0; i < orderedIds.length; i++) {
    await db.query(`UPDATE playlist_items SET position = $3 WHERE playlist_id = $1 AND id = $2`, [
      playlistId,
      orderedIds[i],
      i,
    ]);
  }
}

export function playlistRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { db } = deps;

  async function detail(req: FastifyRequest, reply: FastifyReply, id: string, userId: string) {
    const p = await loadOwned(db, id, userId);
    const items = await db.query<{ id: string; asset_id: string; position: number; added_at: Date }>(
      `SELECT id, asset_id, position, added_at FROM playlist_items WHERE playlist_id = $1 ORDER BY position`,
      [p.id],
    );
    const territory = territoryOf(req, deps.config.defaultTerritory);
    const assets = await queryAssets(
      db,
      `WHERE a.id = ANY($1::uuid[])`,
      [items.map((i) => i.asset_id)],
      territory,
      deps.now(),
    );
    const byId = new Map(assets.map((a) => [a.id, a]));
    reply.header("ETag", `"${p.version}"`);
    return {
      id: p.id,
      ownerId: p.owner_id,
      name: p.name,
      description: p.description,
      artworkUrl: p.artwork_url ?? assets.find((a) => a.artworkUrl)?.artworkUrl ?? null,
      visibility: p.visibility,
      version: p.version,
      createdAt: new Date(p.created_at).toISOString(),
      updatedAt: new Date(p.updated_at).toISOString(),
      items: items.map((i) => ({
        id: i.id,
        playlistId: p.id,
        assetId: i.asset_id,
        position: i.position,
        addedAt: new Date(i.added_at).toISOString(),
        asset: byId.get(i.asset_id) ?? null,
      })),
    };
  }

  app.get("/v1/playlists", async (req) => {
    const me = requireUser(req);
    const rows = await db.query(
      `SELECT p.id, p.name, p.description, p.visibility, p.version, p.created_at AS "createdAt", p.updated_at AS "updatedAt",
         (SELECT count(*)::int FROM playlist_items i WHERE i.playlist_id = p.id) AS "itemCount"
       FROM playlists p WHERE p.owner_id = $1 AND p.deleted_at IS NULL ORDER BY p.updated_at DESC`,
      [me.id],
    );
    return { items: rows };
  });

  app.post<{ Body: { name: string; description?: string; visibility?: string; assetIds?: string[] } }>(
    "/v1/playlists",
    {
      schema: {
        body: {
          type: "object",
          required: ["name"],
          additionalProperties: false,
          properties: {
            name: { type: "string", minLength: 1, maxLength: 100 },
            description: { type: "string", maxLength: 500 },
            visibility: { enum: ["private", "unlisted", "public"] },
            assetIds: { type: "array", maxItems: 200, items: { type: "string" } },
          },
        },
      },
    },
    async (req, reply) => {
      const me = requireUser(req);
      return idempotent(deps, req, reply, "POST /v1/playlists", me.id, async () => {
        const id = uuid();
        await db.tx(async (t) => {
          await t.query(
            `INSERT INTO playlists (id, owner_id, name, description, visibility) VALUES ($1,$2,$3,$4,$5)`,
            [id, me.id, req.body.name.trim(), req.body.description ?? null, req.body.visibility ?? "private"],
          );
          const ids = (req.body.assetIds ?? []).filter(isUuid);
          for (let i = 0; i < ids.length; i++) {
            await t.query(
              `INSERT INTO playlist_items (id, playlist_id, asset_id, position) SELECT $1,$2,$3,$4 WHERE EXISTS (SELECT 1 FROM audio_assets WHERE id = $3)`,
              [uuid(), id, ids[i], i],
            );
          }
          if (ids.length) {
            const kept = await t.query<{ id: string }>(
              `SELECT id FROM playlist_items WHERE playlist_id = $1 ORDER BY position`,
              [id],
            );
            await renumber(
              t,
              id,
              kept.map((k) => k.id),
            );
          }
        });
        return { status: 201, body: await detail(req, reply, id, me.id) };
      });
    },
  );

  app.get<{ Params: { playlistId: string } }>("/v1/playlists/:playlistId", async (req, reply) =>
    detail(req, reply, req.params.playlistId, requireUser(req).id),
  );

  app.patch<{
    Params: { playlistId: string };
    Body: { name?: string; description?: string | null; visibility?: string; version?: number };
  }>(
    "/v1/playlists/:playlistId",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          properties: {
            name: { type: "string", minLength: 1, maxLength: 100 },
            description: { type: ["string", "null"], maxLength: 500 },
            visibility: { enum: ["private", "unlisted", "public"] },
            version: { type: "integer" },
          },
        },
      },
    },
    async (req, reply) => {
      const me = requireUser(req);
      await db.tx(async (t) => {
        const p = await loadOwned(t, req.params.playlistId, me.id);
        await bump(t, p, expectedVersion(req, req.body));
        await t.query(
          `UPDATE playlists SET name = COALESCE($2, name), description = CASE WHEN $4 THEN $3 ELSE description END, visibility = COALESCE($5, visibility) WHERE id = $1`,
          [
            p.id,
            req.body.name?.trim() ?? null,
            req.body.description ?? null,
            "description" in req.body,
            req.body.visibility ?? null,
          ],
        );
      });
      return detail(req, reply, req.params.playlistId, me.id);
    },
  );

  app.delete<{ Params: { playlistId: string } }>("/v1/playlists/:playlistId", async (req, reply) => {
    const me = requireUser(req);
    const p = await loadOwned(db, req.params.playlistId, me.id);
    await db.query(`UPDATE playlists SET deleted_at = now(), version = version + 1 WHERE id = $1`, [p.id]);
    reply.code(204);
    return null;
  });

  app.post<{
    Params: { playlistId: string };
    Body: { assetId: string; position?: number; version?: number };
  }>(
    "/v1/playlists/:playlistId/items",
    {
      schema: {
        body: {
          type: "object",
          required: ["assetId"],
          properties: {
            assetId: { type: "string" },
            position: { type: "integer", minimum: 0 },
            version: { type: "integer" },
          },
        },
      },
    },
    async (req, reply) => {
      const me = requireUser(req);
      if (
        !isUuid(req.body.assetId) ||
        !(await db.one(`SELECT 1 FROM audio_assets WHERE id = $1`, [req.body.assetId]))
      )
        throw notFound("Audio");
      await db.tx(async (t) => {
        const p = await loadOwned(t, req.params.playlistId, me.id);
        await bump(t, p, expectedVersion(req, req.body));
        const items = await t.query<{ id: string }>(
          `SELECT id FROM playlist_items WHERE playlist_id = $1 ORDER BY position`,
          [p.id],
        );
        if (items.length >= 500)
          throw new ApiError("VALIDATION_FAILED", "Playlists can hold up to 500 items.");
        const newId = uuid();
        await t.query(
          `INSERT INTO playlist_items (id, playlist_id, asset_id, position) VALUES ($1,$2,$3,$4)`,
          [newId, p.id, req.body.assetId, items.length + 200000],
        );
        const order = items.map((i) => i.id);
        const pos = Math.min(req.body.position ?? order.length, order.length);
        order.splice(pos, 0, newId);
        await renumber(t, p.id, order);
      });
      reply.code(201);
      return detail(req, reply, req.params.playlistId, me.id);
    },
  );

  app.patch<{ Params: { playlistId: string }; Body: { itemIds: string[]; version?: number } }>(
    "/v1/playlists/:playlistId/items/reorder",
    {
      schema: {
        body: {
          type: "object",
          required: ["itemIds"],
          properties: {
            itemIds: { type: "array", items: { type: "string" }, maxItems: 500 },
            version: { type: "integer" },
          },
        },
      },
    },
    async (req, reply) => {
      const me = requireUser(req);
      await db.tx(async (t) => {
        const p = await loadOwned(t, req.params.playlistId, me.id);
        await bump(t, p, expectedVersion(req, req.body));
        const items = await t.query<{ id: string }>(`SELECT id FROM playlist_items WHERE playlist_id = $1`, [
          p.id,
        ]);
        const current = new Set(items.map((i) => i.id));
        const given = req.body.itemIds;
        if (
          given.length !== current.size ||
          new Set(given).size !== given.length ||
          !given.every((i) => current.has(i))
        ) {
          throw new ApiError("VERSION_CONFLICT", "The playlist items changed. Refresh and reorder again.");
        }
        await renumber(t, p.id, given);
      });
      return detail(req, reply, req.params.playlistId, me.id);
    },
  );

  app.delete<{ Params: { playlistId: string; itemId: string }; Querystring: { version?: string } }>(
    "/v1/playlists/:playlistId/items/:itemId",
    async (req, reply) => {
      const me = requireUser(req);
      await db.tx(async (t) => {
        const p = await loadOwned(t, req.params.playlistId, me.id);
        await bump(
          t,
          p,
          expectedVersion(req, req.query.version ? { version: Number(req.query.version) } : undefined),
        );
        const del = await t.query(
          `DELETE FROM playlist_items WHERE id = $1 AND playlist_id = $2 RETURNING id`,
          [req.params.itemId, p.id],
        );
        if (del.length === 0) throw notFound("Playlist item");
        const rest = await t.query<{ id: string }>(
          `SELECT id FROM playlist_items WHERE playlist_id = $1 ORDER BY position`,
          [p.id],
        );
        await renumber(
          t,
          p.id,
          rest.map((r) => r.id),
        );
      });
      return detail(req, reply, req.params.playlistId, me.id);
    },
  );
}
