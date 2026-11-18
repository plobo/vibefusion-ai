import { Ajv2020 } from "ajv/dist/2020.js";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AppDeps } from "../common/context.js";
import { requireAccount, requireUser, territoryOf } from "../common/context.js";
import { ApiError, notFound } from "../common/errors.js";
import { isUuid, randomTokenId, uuid } from "../common/ids.js";
import { idempotent } from "../common/idempotency.js";
import type { Db } from "../db/db.js";
import { queryAssets, rightsSql, type AssetDto } from "../catalogue/repo.js";
import { grantsFor } from "../rights/repo.js";
import { evaluate, useMessage } from "../rights/policy.js";
import { authorizeMedia } from "../playback/routes.js";
import { fusionRequestSchema, PRODUCT_MAX_LAYERS, validatePlan, type ValidationResult } from "./validator.js";
import type { CandidateAsset, PlanRequest } from "./planner/gateway.js";
import { RuleBasedPlanner } from "./planner/rule-based.js";
import type { MixPlan } from "./envelope.js";
import { compatibleKeys } from "./harmony.js";

const ajv = new Ajv2020({ allErrors: true, strict: false });
const validateRequest = ajv.compile(fusionRequestSchema);
const rules = new RuleBasedPlanner();

interface FusionBody {
  prompt: string;
  targetDurationMs: number;
  mood?: string;
  energyCurve?: PlanRequest["energyCurve"];
  genres?: string[];
  includeSpeech?: boolean;
  speechTopic?: string;
  speechLanguage?: string;
  availableAssetIds?: string[];
  constraints?: {
    maxLayers?: number;
    allowLoops?: boolean;
    allowStemMixing?: boolean;
    allowRenderedExport?: boolean;
  };
}

interface RecipeRow {
  id: string;
  owner_id: string;
  name: string;
  prompt: string | null;
  duration_ms: number;
  mix_plan_version: number;
  mix_plan: MixPlan;
  rights_validation_status: string;
  planner: string;
  version: number;
  created_at: Date;
  updated_at: Date;
}

const recipeDto = (r: RecipeRow) => ({
  id: r.id,
  ownerId: r.owner_id,
  name: r.name,
  prompt: r.prompt,
  durationMs: r.duration_ms,
  mixPlanVersion: r.mix_plan_version,
  mixPlan: r.mix_plan,
  rightsValidationStatus: r.rights_validation_status,
  planner: r.planner,
  version: r.version,
  createdAt: new Date(r.created_at).toISOString(),
  updatedAt: new Date(r.updated_at).toISOString(),
});

export function roleFor(a: AssetDto): CandidateAsset["role"] {
  if (a.assetType === "speech" || a.assetType === "podcast_episode") return "speech";
  if (a.assetType === "sound_effect") return "effect";
  if (
    (a.assetType === "loop" || a.assetType === "stem") &&
    a.genres.includes("ambient") &&
    !a.genres.includes("electronic") &&
    a.tempoBpm === null
  )
    return "ambience";
  if (a.assetType === "loop" && a.genres.includes("electronic") && a.moods.includes("energetic") && !a.key)
    return "percussion";
  return "music";
}

const toCandidate = (a: AssetDto): CandidateAsset => ({
  id: a.id,
  title: a.title,
  assetType: a.assetType,
  role: roleFor(a),
  durationMs: a.durationMs,
  genres: a.genres,
  moods: a.moods,
  topics: a.topics,
  tempoBpm: a.tempoBpm,
  key: a.key,
  loopable: a.assetType === "loop" || a.assetType === "stem" || a.assetType === "music",
});

async function saveLayers(db: Db, recipeId: string, plan: MixPlan) {
  await db.query(`DELETE FROM mix_layers WHERE recipe_id = $1`, [recipeId]);
  for (const l of plan.layers) {
    if (!isUuid(l.assetId)) continue;
    await db.query(
      `INSERT INTO mix_layers (recipe_id, layer_id, asset_id, role, start_ms, duration_ms, gain_db) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [recipeId, l.id, l.assetId, l.role, l.startMs, l.durationMs, l.gainDb],
    );
  }
}

const validationDto = (v: ValidationResult) => ({
  schemaValid: v.schemaValid,
  valid: v.valid,
  rightsStatus: v.rightsStatus,
  errors: v.errors,
  warnings: v.warnings,
});

export function fusionRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { db } = deps;
  const opts = (req: FastifyRequest) => ({
    territory: territoryOf(req, deps.config.defaultTerritory),
    now: deps.now(),
  });

  app.get("/v1/fusion/status", async () => {
    const s = deps.planner.status();
    return {
      aiAvailable: s.available && s.primary !== "rules",
      provider: s.primary,
      fallback: s.fallback,
      manualEditorAvailable: true,
      maxLayers: PRODUCT_MAX_LAYERS,
      disclosure:
        s.primary === "anthropic"
          ? "Prompts and catalogue metadata (never your personal data or audio) are sent to Anthropic to draft a mix plan. Prompts are kept with saved recipes only."
          : "Mix plans are generated on VibeFusion servers by a deterministic planner. No third-party AI provider is used.",
    };
  });

  app.post<{ Body: FusionBody }>(
    "/v1/fusion/plan",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (req) => {
      const me = requireUser(req);
      if (!validateRequest(req.body)) {
        throw new ApiError(
          "VALIDATION_FAILED",
          "The fusion request is invalid.",
          validateRequest.errors?.slice(0, 10).map((e) => `${e.instancePath} ${e.message}`),
        );
      }
      const b = req.body;
      // Per-user daily quota.
      const day = deps.now().toISOString().slice(0, 10);
      const usage = await db.one<{ requests: number }>(
        `INSERT INTO ai_usage (user_id, day, requests) VALUES ($1,$2,1) ON CONFLICT (user_id, day) DO UPDATE SET requests = ai_usage.requests + 1 RETURNING requests`,
        [me.id, day],
      );
      if ((usage?.requests ?? 0) > deps.config.aiDailyQuota)
        throw new ApiError(
          "QUOTA_EXCEEDED",
          "You've reached today's AI planning limit. Manual mixing is still available.",
        );
      deps.metrics.inc("fusion_prompt_submitted_total");
      const { territory, now } = opts(req);
      const params: unknown[] = [territory, now];
      let idFilter = "";
      if (b.availableAssetIds?.length) {
        params.push(b.availableAssetIds.filter(isUuid));
        idFilter = `AND a.id = ANY($3::uuid[])`;
      }
      const pool = await queryAssets(
        db,
        `WHERE a.is_active AND ${rightsSql("mix", 1, 2)} AND a.asset_type IN ('music','loop','stem','speech','sound_effect') ${idFilter}
       ORDER BY a.is_dev_fixture DESC, a.popularity DESC, a.title LIMIT 200`,
        params,
        territory,
        now,
      );
      const want = new Set([...(b.genres ?? []), b.mood ?? ""].map((s) => s.toLowerCase()).filter(Boolean));
      const scored = pool
        .map((a) => ({ a, s: [...a.genres, ...a.moods, ...a.topics].filter((t) => want.has(t)).length }))
        .sort((x, y) => y.s - x.s || x.a.id.localeCompare(y.a.id));
      const music = scored
        .filter((x) => roleFor(x.a) !== "speech")
        .slice(0, 30)
        .map((x) => x.a);
      const speech = scored
        .filter((x) => roleFor(x.a) === "speech")
        .slice(0, 10)
        .map((x) => x.a);
      const candidates = [...music, ...speech].map(toCandidate);
      const extraWarnings: string[] = [];
      for (const g of b.genres ?? []) {
        if (!pool.some((a) => a.genres.includes(g.toLowerCase())))
          extraWarnings.push(
            `No mix-cleared audio is available for "${g}" yet, so similar sounds were used.`,
          );
      }
      if (candidates.filter((c) => c.role !== "speech").length === 0) {
        throw new ApiError(
          "MIX_PLAN_INVALID",
          "No audio cleared for mixing is available right now. Try again later.",
        );
      }
      const planReq: PlanRequest = {
        prompt: b.prompt,
        targetDurationMs: b.targetDurationMs,
        mood: b.mood,
        energyCurve: b.energyCurve,
        genres: b.genres,
        includeSpeech: b.includeSpeech,
        speechTopic: b.speechTopic,
        speechLanguage: b.speechLanguage,
        maxLayers: Math.min(b.constraints?.maxLayers ?? 4, PRODUCT_MAX_LAYERS),
        allowLoops: b.constraints?.allowLoops ?? true,
      };
      const started = Date.now();
      let out = await deps.planner.plan(planReq, candidates);
      deps.metrics.observe("fusion_plan_latency_ms", Date.now() - started, { provider: out.provider });
      const vopts = {
        ...opts(req),
        maxLayers: planReq.maxLayers,
        allowLoops: planReq.allowLoops,
        allowedAssetIds: new Set(candidates.map((c) => c.id)),
        requireExport: b.constraints?.allowRenderedExport ?? false,
      };
      let result = await validatePlan(db, out.plan, vopts);
      if (!result.valid && out.provider !== rules.name) {
        // Repair path: the LLM output failed validation; fall back to the deterministic planner.
        deps.metrics.inc("fusion_plan_rejected_total", {
          provider: out.provider,
          reason: result.schemaValid ? "semantic" : "schema",
        });
        out = { plan: await rules.plan(planReq, candidates), provider: rules.name };
        result = await validatePlan(db, out.plan, vopts);
        result.warnings.unshift(
          "The AI draft didn't pass validation, so a rule-based plan was generated instead.",
        );
      }
      if (!result.valid || !result.plan) {
        deps.metrics.inc("fusion_plan_rejected_total", { provider: out.provider, reason: "final" });
        throw new ApiError(
          "MIX_PLAN_INVALID",
          "We couldn't build a valid session from the available audio.",
          validationDto(result),
        );
      }
      result.plan.warnings = [...new Set([...extraWarnings, ...result.warnings])].slice(0, 20);
      deps.metrics.inc("fusion_plan_generated_total", { provider: out.provider });
      return {
        plan: result.plan,
        provider: out.provider,
        warnings: result.plan.warnings,
        assets: result.assets,
        validation: validationDto(result),
      };
    },
  );

  app.post<{ Body: { plan: unknown; requireExport?: boolean } }>("/v1/fusion/validate", async (req) => {
    requireUser(req);
    if (!req.body || typeof req.body !== "object" || !("plan" in req.body))
      throw new ApiError("VALIDATION_FAILED", "Provide a plan to validate.");
    const r = await validatePlan(db, req.body.plan, {
      ...opts(req),
      requireExport: !!req.body.requireExport,
    });
    return { ...validationDto(r), plan: r.plan, assets: r.assets };
  });

  app.get("/v1/fusion/recipes", async (req) => {
    const me = requireUser(req);
    const rows = await db.query<RecipeRow>(
      `SELECT * FROM mix_recipes WHERE owner_id = $1 AND deleted_at IS NULL ORDER BY updated_at DESC`,
      [me.id],
    );
    return { items: rows.map(recipeDto) };
  });

  app.post<{ Body: { name: string; prompt?: string; plan: unknown; planner?: string } }>(
    "/v1/fusion/recipes",
    {
      schema: {
        body: {
          type: "object",
          required: ["name", "plan"],
          properties: {
            name: { type: "string", minLength: 1, maxLength: 100 },
            prompt: { type: "string", maxLength: 1000 },
            plan: { type: "object" },
            planner: { type: "string", maxLength: 20 },
          },
        },
      },
    },
    async (req, reply) => {
      const me = requireUser(req);
      return idempotent(deps, req, reply, "POST /v1/fusion/recipes", me.id, async () => {
        const v = await validatePlan(db, req.body.plan, opts(req));
        if (!v.schemaValid || !v.plan)
          throw new ApiError("MIX_PLAN_INVALID", "This mix plan is not valid.", validationDto(v));
        const id = uuid();
        const row = await db.tx(async (t) => {
          const r = await t.one<RecipeRow>(
            `INSERT INTO mix_recipes (id, owner_id, name, prompt, duration_ms, mix_plan, rights_validation_status, planner) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
            [
              id,
              me.id,
              req.body.name.trim(),
              req.body.prompt ?? null,
              v.plan!.durationMs,
              JSON.stringify(v.plan),
              v.rightsStatus,
              req.body.planner ?? "manual",
            ],
          );
          await saveLayers(t, id, v.plan!);
          return r!;
        });
        deps.metrics.inc("fusion_recipe_saved_total");
        return { status: 201, body: { ...recipeDto(row), validation: validationDto(v) } };
      });
    },
  );

  async function ownedRecipe(id: string, userId: string): Promise<RecipeRow> {
    if (!isUuid(id)) throw notFound("Mix");
    const r = await db.one<RecipeRow>(`SELECT * FROM mix_recipes WHERE id = $1 AND deleted_at IS NULL`, [id]);
    if (!r || r.owner_id !== userId) throw notFound("Mix");
    return r;
  }

  app.get<{ Params: { recipeId: string } }>("/v1/fusion/recipes/:recipeId", async (req) => {
    const me = requireUser(req);
    const r = await ownedRecipe(req.params.recipeId, me.id);
    const v = await validatePlan(db, r.mix_plan, opts(req));
    if (v.rightsStatus !== r.rights_validation_status) {
      await db.query(`UPDATE mix_recipes SET rights_validation_status = $2 WHERE id = $1`, [
        r.id,
        v.rightsStatus,
      ]);
      r.rights_validation_status = v.rightsStatus;
    }
    return { ...recipeDto(r), validation: validationDto(v), assets: v.assets };
  });

  app.patch<{ Params: { recipeId: string }; Body: { name?: string; plan?: unknown; version?: number } }>(
    "/v1/fusion/recipes/:recipeId",
    async (req) => {
      const me = requireUser(req);
      const r = await ownedRecipe(req.params.recipeId, me.id);
      const expected =
        req.body.version ??
        (typeof req.headers["if-match"] === "string"
          ? Number(req.headers["if-match"].replace(/"/g, ""))
          : null);
      if (expected !== null && expected !== r.version)
        throw new ApiError("VERSION_CONFLICT", "This mix was changed elsewhere. Reload it first.", {
          currentVersion: r.version,
        });
      let plan = r.mix_plan;
      let status = r.rights_validation_status;
      let validation: ValidationResult | null = null;
      if (req.body.plan !== undefined) {
        validation = await validatePlan(db, req.body.plan, opts(req));
        if (!validation.schemaValid || !validation.plan)
          throw new ApiError("MIX_PLAN_INVALID", "This mix plan is not valid.", validationDto(validation));
        plan = validation.plan;
        status = validation.rightsStatus;
      }
      const row = await db.tx(async (t) => {
        const u = await t.one<RecipeRow>(
          `UPDATE mix_recipes SET name = COALESCE($2, name), mix_plan = $3, duration_ms = $4, rights_validation_status = $5, version = version + 1, updated_at = now()
         WHERE id = $1 AND version = $6 RETURNING *`,
          [r.id, req.body.name?.trim() ?? null, JSON.stringify(plan), plan.durationMs, status, r.version],
        );
        if (!u) throw new ApiError("VERSION_CONFLICT", "This mix was changed elsewhere. Reload it first.");
        await saveLayers(t, r.id, plan);
        return u;
      });
      return { ...recipeDto(row), validation: validation ? validationDto(validation) : null };
    },
  );

  app.delete<{ Params: { recipeId: string } }>("/v1/fusion/recipes/:recipeId", async (req, reply) => {
    const me = requireUser(req);
    const r = await ownedRecipe(req.params.recipeId, me.id);
    await db.query(`UPDATE mix_recipes SET deleted_at = now() WHERE id = $1`, [r.id]);
    await db.query(`UPDATE recipe_shares SET revoked_at = now() WHERE recipe_id = $1`, [r.id]);
    reply.code(204);
    return null;
  });

  /** Revalidates rights for every layer at play time (Scenario G). Policy: block affected layers, or whole recipe. */
  app.post<{ Params: { recipeId: string }; Body: { policy?: "block_layer" | "block_recipe" } }>(
    "/v1/fusion/recipes/:recipeId/playback-authorize",
    async (req) => {
      const me = requireUser(req);
      const r = await ownedRecipe(req.params.recipeId, me.id);
      return authorizePlan(
        deps,
        me.id,
        r.mix_plan,
        opts(req).territory,
        req.body?.policy ??
          (process.env.FUSION_REVOKED_POLICY === "block_recipe" ? "block_recipe" : "block_layer"),
      );
    },
  );

  /** Authorize an unsaved (editor) plan for preview. */
  app.post<{ Body: { plan: unknown } }>("/v1/fusion/preview-authorize", async (req) => {
    const me = requireUser(req);
    const v = await validatePlan(db, req.body?.plan, opts(req));
    if (!v.schemaValid || !v.plan)
      throw new ApiError("MIX_PLAN_INVALID", "This mix plan is not valid.", validationDto(v));
    deps.metrics.inc("fusion_preview_started_total");
    return authorizePlan(deps, me.id, v.plan, opts(req).territory, "block_layer");
  });

  // Offline render (Phase 6): server authorizes, device renders locally; output stays private on device.
  app.post<{ Body: { recipeId: string } }>(
    "/v1/fusion/render",
    {
      schema: {
        body: { type: "object", required: ["recipeId"], properties: { recipeId: { type: "string" } } },
      },
    },
    async (req, reply) => {
      const me = requireAccount(req);
      const r = await ownedRecipe(req.body.recipeId, me.id);
      return idempotent(deps, req, reply, "POST /v1/fusion/render", me.id, async () => {
        const v = await validatePlan(db, r.mix_plan, { ...opts(req), requireExport: true });
        const jobId = uuid();
        if (!v.valid) {
          await db.query(
            `INSERT INTO render_jobs (id, recipe_id, owner_id, status, error) VALUES ($1,$2,$3,'rejected',$4)`,
            [
              jobId,
              r.id,
              me.id,
              v.errors
                .map((e) => e.message)
                .join("; ")
                .slice(0, 1000),
            ],
          );
          throw new ApiError(
            "RIGHTS_NOT_GRANTED",
            "This mix can't be exported because not every layer is licensed for rendered derivatives.",
            validationDto(v),
          );
        }
        const attribution =
          v.assets
            .map((a) => a.license?.attribution)
            .filter(Boolean)
            .join("\n") || null;
        await db.query(
          `INSERT INTO render_jobs (id, recipe_id, owner_id, status, attribution) VALUES ($1,$2,$3,'authorized',$4)`,
          [jobId, r.id, me.id, attribution],
        );
        const layers = [];
        for (const assetId of new Set(v.plan!.layers.map((l) => l.assetId))) {
          layers.push(await authorizeMedia(deps, me.id, assetId, "derivative_render", opts(req).territory));
        }
        return {
          status: 202,
          body: {
            jobId,
            status: "authorized",
            mode: "client_offline",
            attribution,
            media: layers,
            plan: v.plan,
          },
        };
      });
    },
  );

  app.get<{ Params: { jobId: string } }>("/v1/fusion/render-jobs/:jobId", async (req) => {
    const me = requireUser(req);
    if (!isUuid(req.params.jobId)) throw notFound("Render job");
    const j = await db.one(
      `SELECT id, recipe_id AS "recipeId", status, mode, attribution, error, created_at AS "createdAt", updated_at AS "updatedAt" FROM render_jobs WHERE id = $1 AND owner_id = $2`,
      [req.params.jobId, me.id],
    );
    if (!j) throw notFound("Render job");
    return j;
  });

  app.post<{ Params: { jobId: string }; Body: { status: "completed" | "failed"; error?: string } }>(
    "/v1/fusion/render-jobs/:jobId/complete",
    async (req) => {
      const me = requireUser(req);
      if (!isUuid(req.params.jobId)) throw notFound("Render job");
      const status = req.body?.status === "failed" ? "failed" : "completed";
      const j = await db.one(
        `UPDATE render_jobs SET status = $3, error = $4, updated_at = now() WHERE id = $1 AND owner_id = $2 AND status = 'authorized' RETURNING id, status`,
        [req.params.jobId, me.id, status, req.body?.error?.slice(0, 500) ?? null],
      );
      if (!j) throw notFound("Render job");
      return j;
    },
  );

  /** Tempo/key-aware suggestions (Phase 6). Uses measured metadata only; never claims a match it can't support. */
  app.get<{ Querystring: { assetId: string } }>("/v1/fusion/suggestions", async (req) => {
    requireUser(req);
    const { territory, now } = opts(req);
    if (!req.query.assetId || !isUuid(req.query.assetId))
      throw new ApiError("VALIDATION_FAILED", "assetId is required.");
    const [seed] = await queryAssets(db, `WHERE a.id = $1`, [req.query.assetId], territory, now);
    if (!seed) throw notFound("Audio");
    const pool = await queryAssets(
      db,
      `WHERE a.is_active AND a.id <> $3 AND ${rightsSql("mix", 1, 2)} AND a.asset_type IN ('music','loop','stem') LIMIT 300`,
      [territory, now, seed.id],
      territory,
      now,
    );
    const keys = seed.key ? compatibleKeys(seed.key) : [];
    const items = pool
      .map((a) => {
        const reasons: string[] = [];
        let score = 0;
        if (seed.tempoBpm && a.tempoBpm) {
          const ratio = a.tempoBpm / seed.tempoBpm;
          if ([0.5, 1, 2].some((r) => Math.abs(ratio - r) < 0.04)) {
            score += 2;
            reasons.push(`Tempo ${a.tempoBpm} BPM fits ${seed.tempoBpm} BPM`);
          }
        }
        if (a.key && keys.includes(a.key)) {
          score += 2;
          reasons.push(`Key ${a.key} is harmonically compatible with ${seed.key}`);
        }
        const shared = a.genres.filter((g) => seed.genres.includes(g));
        if (shared.length) {
          score += 1;
          reasons.push(`Shares genre: ${shared.join(", ")}`);
        }
        return { asset: a, score, reasons };
      })
      .filter((x) => x.score > 0)
      .sort((x, y) => y.score - x.score || x.asset.title.localeCompare(y.asset.title))
      .slice(0, 12);
    return {
      seed,
      items,
      note:
        seed.tempoBpm || seed.key
          ? null
          : "This track has no measured tempo or key, so suggestions are based on genre only.",
    };
  });

  app.post<{ Params: { recipeId: string } }>("/v1/fusion/recipes/:recipeId/share", async (req, reply) => {
    const me = requireAccount(req);
    const r = await ownedRecipe(req.params.recipeId, me.id);
    const v = await validatePlan(db, r.mix_plan, opts(req));
    if (!v.valid)
      throw new ApiError(
        "RIGHTS_NOT_GRANTED",
        "Only mixes whose every layer is cleared can be shared.",
        validationDto(v),
      );
    const existing = await db.one<{ token: string }>(
      `SELECT token FROM recipe_shares WHERE recipe_id = $1 AND revoked_at IS NULL`,
      [r.id],
    );
    const token = existing?.token ?? randomTokenId();
    if (!existing)
      await db.query(`INSERT INTO recipe_shares (token, recipe_id, created_by) VALUES ($1,$2,$3)`, [
        token,
        r.id,
        me.id,
      ]);
    reply.code(201);
    return {
      token,
      url: `${deps.config.publicBaseUrl}/mix/${token}`,
      note: "Shared links contain the recipe only. Listeners stream each layer under their own rights checks.",
    };
  });

  app.delete<{ Params: { recipeId: string } }>("/v1/fusion/recipes/:recipeId/share", async (req, reply) => {
    const me = requireUser(req);
    const r = await ownedRecipe(req.params.recipeId, me.id);
    await db.query(`UPDATE recipe_shares SET revoked_at = now() WHERE recipe_id = $1`, [r.id]);
    reply.code(204);
    return null;
  });

  app.get<{ Params: { token: string } }>("/v1/shared/recipes/:token", async (req) => {
    const row = await db.one<RecipeRow & { revoked_at: Date | null }>(
      `SELECT m.*, s.revoked_at FROM recipe_shares s JOIN mix_recipes m ON m.id = s.recipe_id WHERE s.token = $1 AND m.deleted_at IS NULL`,
      [req.params.token],
    );
    if (!row || row.revoked_at) throw notFound("Shared mix");
    const v = await validatePlan(db, row.mix_plan, opts(req));
    return {
      name: row.name,
      durationMs: row.duration_ms,
      mixPlan: v.plan,
      rightsStatus: v.rightsStatus,
      assets: v.assets,
    };
  });

  app.post("/v1/fusion/stems", async () => {
    throw new ApiError(
      "NOT_IMPLEMENTED",
      "Stem separation is only offered for assets whose licence explicitly permits it, and none in the current catalogue do.",
    );
  });
}

export async function authorizePlan(
  deps: AppDeps,
  userId: string,
  plan: MixPlan,
  territory: string,
  policy: "block_layer" | "block_recipe",
) {
  const now = deps.now();
  const ids = [...new Set(plan.layers.map((l) => l.assetId))].filter(isUuid);
  const grants = await grantsFor(deps.db, ids);
  const active = new Set(
    (
      await deps.db.query<{ id: string }>(
        `SELECT id FROM audio_assets WHERE id = ANY($1::uuid[]) AND is_active`,
        [ids],
      )
    ).map((r) => r.id),
  );
  const blocked: { layerId: string; assetId: string; reason: string; message: string }[] = [];
  for (const l of plan.layers) {
    if (!active.has(l.assetId)) {
      blocked.push({
        layerId: l.id,
        assetId: l.assetId,
        reason: "ASSET_INACTIVE",
        message: "This audio is no longer available.",
      });
      continue;
    }
    const d = evaluate(grants.get(l.assetId) ?? [], "mix", territory, now);
    if (!d.allowed)
      blocked.push({
        layerId: l.id,
        assetId: l.assetId,
        reason: d.reason,
        message: useMessage("mix", d.reason),
      });
  }
  if (blocked.length > 0)
    deps.metrics.inc("rights_validation_failures_total", { use: "mix", reason: "playback_revalidation" });
  if (blocked.length > 0 && (policy === "block_recipe" || blocked.length === plan.layers.length)) {
    throw new ApiError(
      "RIGHTS_NOT_GRANTED",
      "This mix can't play because some of its audio is no longer cleared for mixing.",
      { blockedLayers: blocked },
    );
  }
  const blockedIds = new Set(blocked.map((b) => b.layerId));
  const media: Record<string, unknown> = {};
  for (const assetId of new Set(plan.layers.filter((l) => !blockedIds.has(l.id)).map((l) => l.assetId))) {
    media[assetId] = await authorizeMedia(deps, userId, assetId, "mix", territory);
  }
  const assets = await queryAssets(deps.db, `WHERE a.id = ANY($1::uuid[])`, [ids], territory, now);
  return {
    plan: { ...plan, layers: plan.layers.filter((l) => !blockedIds.has(l.id)) },
    media,
    blockedLayers: blocked,
    assets: assets.map((a) => ({
      id: a.id,
      title: a.title,
      durationMs: a.durationMs,
      artworkUrl: a.artworkUrl,
      attribution: a.license?.attribution ?? null,
    })),
  };
}
