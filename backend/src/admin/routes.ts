import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../common/context.js";
import { requireAdmin } from "../common/context.js";
import { notFound } from "../common/errors.js";
import { isUuid, uuid } from "../common/ids.js";
import { runIngestion, type IngestSource } from "../ingestion/run.js";
import { ALL_USES } from "../rights/policy.js";

export function adminRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { db } = deps;
  const audit = (
    actor: string,
    action: string,
    targetType: string,
    targetId: string,
    details: unknown = {},
  ) =>
    db.query(
      `INSERT INTO audit_log (actor_id, action, target_type, target_id, details) VALUES ($1,$2,$3,$4,$5)`,
      [actor, action, targetType, targetId, JSON.stringify(details)],
    );

  app.get("/v1/admin/stats", async (req) => {
    requireAdmin(req);
    const [assets, grants, runs, events] = await Promise.all([
      db.query(
        `SELECT asset_type AS "assetType", count(*)::int AS count, sum(CASE WHEN is_active THEN 1 ELSE 0 END)::int AS active FROM audio_assets GROUP BY 1 ORDER BY 1`,
      ),
      db.query(
        `SELECT license_type AS "licenseType", status, count(*)::int AS count FROM rights_grants GROUP BY 1, 2 ORDER BY 1, 2`,
      ),
      db.query(
        `SELECT source, status, added, skipped, error, started_at AS "startedAt", finished_at AS "finishedAt" FROM ingestion_runs ORDER BY started_at DESC LIMIT 20`,
      ),
      db.query(
        `SELECT name, count(*)::int AS count FROM product_events WHERE occurred_at > now() - interval '7 days' GROUP BY 1 ORDER BY 2 DESC`,
      ),
    ]);
    const unverified = await db.query(
      `SELECT a.id, a.title FROM audio_assets a WHERE a.is_active AND NOT EXISTS (SELECT 1 FROM rights_grants g WHERE g.asset_id = a.id AND g.status = 'active') LIMIT 50`,
    );
    return {
      assets,
      grants,
      ingestionRuns: runs,
      events7d: events,
      activeAssetsWithoutVerifiedRights: unverified,
      planner: deps.planner.status(),
    };
  });

  app.post<{ Body: { sources?: IngestSource[] } }>("/v1/admin/ingest", async (req, reply) => {
    const me = requireAdmin(req);
    const sources = req.body?.sources ?? ["internet_archive_music", "librivox", "podcasts"];
    await audit(me.id, "ingest_started", "catalogue", "*", { sources });
    void runIngestion(deps, sources).catch((e) => app.log.error({ err: e }, "ingestion failed"));
    reply.code(202);
    return { status: "started", sources };
  });

  app.get<{ Params: { assetId: string } }>("/v1/admin/assets/:assetId/rights", async (req) => {
    requireAdmin(req);
    if (!isUuid(req.params.assetId)) throw notFound("Audio");
    // Admin-only view: includes the private proof reference, never exposed to listener clients.
    const grants = await db.query(
      `SELECT id, rights_holder AS "rightsHolder", license_type AS "licenseType", license_url AS "licenseUrl", territories, valid_from AS "validFrom",
         valid_until AS "validUntil", allowed_uses AS "allowedUses", attribution_required AS "attributionRequired", attribution_text AS "attributionText",
         proof_reference AS "proofReference", status, updated_at AS "updatedAt" FROM rights_grants WHERE asset_id = $1 ORDER BY created_at`,
      [req.params.assetId],
    );
    const log = await db.query(
      `SELECT action, details, actor_id AS "actorId", created_at AS "createdAt" FROM audit_log WHERE target_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [req.params.assetId],
    );
    return { assetId: req.params.assetId, grants, audit: log };
  });

  app.post<{
    Params: { assetId: string };
    Body: {
      rightsHolder: string;
      licenseType: string;
      licenseUrl?: string;
      territories?: string[];
      allowedUses: string[];
      attributionText?: string;
      proofReference: string;
      validUntil?: string;
    };
  }>(
    "/v1/admin/assets/:assetId/rights",
    {
      schema: {
        body: {
          type: "object",
          required: ["rightsHolder", "licenseType", "allowedUses", "proofReference"],
          properties: {
            rightsHolder: { type: "string", maxLength: 200 },
            licenseType: {
              enum: [
                "owned",
                "royalty_free",
                "direct_license",
                "public_domain_verified",
                "creative_commons",
                "publisher_feed",
              ],
            },
            licenseUrl: { type: "string", maxLength: 500 },
            territories: { type: "array", items: { type: "string", pattern: "^(\\*|[A-Z]{2})$" } },
            allowedUses: { type: "array", items: { enum: ALL_USES } },
            attributionText: { type: "string", maxLength: 500 },
            proofReference: { type: "string", maxLength: 500 },
            validUntil: { type: "string", format: "date-time" },
          },
        },
      },
    },
    async (req, reply) => {
      const me = requireAdmin(req);
      if (
        !isUuid(req.params.assetId) ||
        !(await db.one(`SELECT 1 FROM audio_assets WHERE id = $1`, [req.params.assetId]))
      )
        throw notFound("Audio");
      const id = uuid();
      const b = req.body;
      await db.query(
        `INSERT INTO rights_grants (id, asset_id, rights_holder, license_type, license_url, territories, allowed_uses, attribution_required, attribution_text, proof_reference, status, valid_until)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'active',$11)`,
        [
          id,
          req.params.assetId,
          b.rightsHolder,
          b.licenseType,
          b.licenseUrl ?? null,
          b.territories ?? ["*"],
          b.allowedUses,
          !!b.attributionText,
          b.attributionText ?? null,
          b.proofReference,
          b.validUntil ?? null,
        ],
      );
      await audit(me.id, "grant_added", "asset", req.params.assetId, {
        grantId: id,
        allowedUses: b.allowedUses,
      });
      reply.code(201);
      return { id };
    },
  );

  app.post<{
    Params: { grantId: string };
    Body: {
      status: "active" | "revoked" | "under_review" | "expired";
      reason?: string;
      allowedUses?: string[];
    };
  }>(
    "/v1/admin/rights/:grantId",
    {
      schema: {
        body: {
          type: "object",
          required: ["status"],
          properties: {
            status: { enum: ["active", "revoked", "under_review", "expired"] },
            reason: { type: "string", maxLength: 500 },
            allowedUses: { type: "array", items: { enum: ALL_USES } },
          },
        },
      },
    },
    async (req) => {
      const me = requireAdmin(req);
      if (!isUuid(req.params.grantId)) throw notFound("Grant");
      const g = await db.one<{ asset_id: string }>(
        `UPDATE rights_grants SET status = $2, allowed_uses = COALESCE($3, allowed_uses), updated_at = now() WHERE id = $1 RETURNING asset_id`,
        [req.params.grantId, req.body.status, req.body.allowedUses ?? null],
      );
      if (!g) throw notFound("Grant");
      await audit(me.id, `grant_${req.body.status}`, "asset", g.asset_id, {
        grantId: req.params.grantId,
        reason: req.body.reason ?? null,
        allowedUses: req.body.allowedUses ?? null,
      });
      return { grantId: req.params.grantId, status: req.body.status };
    },
  );

  /** Takedown: deactivates the asset immediately (new authorizations fail closed) and revokes its grants. */
  app.post<{ Params: { assetId: string }; Body: { reason: string } }>(
    "/v1/admin/assets/:assetId/takedown",
    {
      schema: {
        body: {
          type: "object",
          required: ["reason"],
          properties: { reason: { type: "string", minLength: 3, maxLength: 1000 } },
        },
      },
    },
    async (req) => {
      const me = requireAdmin(req);
      if (!isUuid(req.params.assetId)) throw notFound("Audio");
      const res = await db.query(
        `UPDATE audio_assets SET is_active = false, updated_at = now() WHERE id = $1 RETURNING id`,
        [req.params.assetId],
      );
      if (res.length === 0) throw notFound("Audio");
      await db.query(`UPDATE rights_grants SET status = 'revoked', updated_at = now() WHERE asset_id = $1`, [
        req.params.assetId,
      ]);
      await audit(me.id, "takedown", "asset", req.params.assetId, { reason: req.body.reason });
      return { assetId: req.params.assetId, status: "taken_down" };
    },
  );

  app.post<{ Params: { assetId: string } }>("/v1/admin/assets/:assetId/restore", async (req) => {
    const me = requireAdmin(req);
    if (!isUuid(req.params.assetId)) throw notFound("Audio");
    const res = await db.query(`UPDATE audio_assets SET is_active = true WHERE id = $1 RETURNING id`, [
      req.params.assetId,
    ]);
    if (res.length === 0) throw notFound("Audio");
    await audit(me.id, "restore", "asset", req.params.assetId);
    return {
      assetId: req.params.assetId,
      status: "active",
      note: "Grants remain revoked until re-verified and re-activated.",
    };
  });

  app.get<{ Querystring: { limit?: string } }>("/v1/admin/audit", async (req) => {
    requireAdmin(req);
    const limit = Math.min(500, Number(req.query.limit ?? 100));
    return {
      items: await db.query(
        `SELECT id, actor_id AS "actorId", action, target_type AS "targetType", target_id AS "targetId", details, created_at AS "createdAt" FROM audit_log ORDER BY id DESC LIMIT ${limit}`,
      ),
    };
  });

  app.post("/v1/admin/retention", async (req) => {
    const me = requireAdmin(req);
    const ev = await db.query(
      `DELETE FROM product_events WHERE occurred_at < now() - interval '90 days' RETURNING id`,
    );
    const idem = await db.query(
      `DELETE FROM idempotency_keys WHERE created_at < now() - interval '1 day' RETURNING key`,
    );
    const rt = await db.query(
      `DELETE FROM refresh_tokens WHERE expires_at < now() OR revoked_at < now() - interval '7 days' RETURNING id`,
    );
    await audit(me.id, "retention_run", "system", "*", {
      events: ev.length,
      idempotency: idem.length,
      refreshTokens: rt.length,
    });
    return { deletedEvents: ev.length, deletedIdempotencyKeys: idem.length, deletedRefreshTokens: rt.length };
  });
}
