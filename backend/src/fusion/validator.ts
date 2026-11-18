import fs from "node:fs";
import path from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ErrorObject } from "ajv";
import { REPO_ROOT } from "../config.js";
import type { Db } from "../db/db.js";
import { assetsByIds, type AssetDto } from "../catalogue/repo.js";
import { grantsFor } from "../rights/repo.js";
import { evaluate, useMessage, type RightsUse } from "../rights/policy.js";
import { DEFAULT_ATTACK_MS, DEFAULT_DUCK_DB, DEFAULT_RELEASE_MS, type MixPlan } from "./envelope.js";

export const PRODUCT_MAX_LAYERS = 6;

const schemaPath = path.join(REPO_ROOT, "contracts", "schemas", "mix-plan.schema.json");
export const mixPlanSchema = JSON.parse(fs.readFileSync(schemaPath, "utf8")) as Record<string, unknown>;
export const fusionRequestSchema = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, "contracts", "schemas", "fusion-request.schema.json"), "utf8"),
) as Record<string, unknown>;

const ajv = new Ajv2020({ allErrors: true, strict: false });
const validateSchemaFn = ajv.compile(mixPlanSchema);

export type IssueCode =
  | "SCHEMA"
  | "DUPLICATE_LAYER_ID"
  | "UNKNOWN_ASSET"
  | "ASSET_INACTIVE"
  | "NOT_CLEARED_FOR_MIX"
  | "TOO_MANY_LAYERS"
  | "LAYER_OUT_OF_RANGE"
  | "SOURCE_TOO_SHORT"
  | "LOOP_NOT_PERMITTED"
  | "BAD_TRANSITION"
  | "EXPORT_NOT_PERMITTED";

export interface Issue {
  code: IssueCode;
  message: string;
  path?: string;
  layerId?: string;
  assetId?: string;
}

export interface ValidationResult {
  schemaValid: boolean;
  valid: boolean;
  rightsStatus: "valid" | "invalid" | "needs_review";
  errors: Issue[];
  warnings: string[];
  plan: MixPlan | null;
  assets: AssetDto[];
}

export interface ValidateOptions {
  territory: string;
  now: Date;
  maxLayers?: number;
  allowLoops?: boolean;
  requireExport?: boolean;
  /** When set, only these asset ids may be referenced (e.g. ids the catalogue returned to the planner). */
  allowedAssetIds?: Set<string>;
}

function schemaIssues(errors: ErrorObject[] | null | undefined): Issue[] {
  return (errors ?? []).slice(0, 20).map((e) => ({
    code: "SCHEMA" as const,
    path: e.instancePath || "/",
    message: `${e.instancePath || "plan"} ${e.message ?? "is invalid"}`,
  }));
}

export function checkSchema(plan: unknown): Issue[] {
  return validateSchemaFn(plan) ? [] : schemaIssues(validateSchemaFn.errors);
}

/**
 * Full validation: JSON Schema, cross-field rules, catalogue lookup and rights (fail closed).
 * Returns a normalized copy of the plan (defaults applied, safe repairs made with warnings).
 */
export async function validatePlan(db: Db, input: unknown, opts: ValidateOptions): Promise<ValidationResult> {
  const errors: Issue[] = checkSchema(input);
  if (errors.length > 0) {
    return {
      schemaValid: false,
      valid: false,
      rightsStatus: "invalid",
      errors,
      warnings: [],
      plan: null,
      assets: [],
    };
  }
  const plan = structuredClone(input) as MixPlan;
  const warnings: string[] = [...(plan.warnings ?? [])];
  const maxLayers = Math.min(opts.maxLayers ?? PRODUCT_MAX_LAYERS, PRODUCT_MAX_LAYERS);

  if (plan.layers.length > maxLayers) {
    errors.push({ code: "TOO_MANY_LAYERS", message: `A session can have at most ${maxLayers} layers.` });
  }
  const ids = new Set<string>();
  for (const l of plan.layers) {
    if (ids.has(l.id))
      errors.push({
        code: "DUPLICATE_LAYER_ID",
        layerId: l.id,
        message: `Layer id "${l.id}" is used more than once.`,
      });
    ids.add(l.id);
  }

  // Beat-grid snapping (deterministic, applied before bounds checks).
  if (plan.snapToBeat && plan.tempoBpm) {
    const beat = 60000 / plan.tempoBpm;
    for (const l of plan.layers) l.startMs = Math.round(Math.round(l.startMs / beat) * beat);
  }

  for (const l of plan.layers) {
    if (l.startMs >= plan.durationMs) {
      errors.push({
        code: "LAYER_OUT_OF_RANGE",
        layerId: l.id,
        message: `Layer "${l.id}" starts after the session ends.`,
      });
      continue;
    }
    if (l.startMs + l.durationMs > plan.durationMs) {
      l.durationMs = plan.durationMs - l.startMs;
      warnings.push(`Layer "${l.id}" was trimmed to end with the session.`);
    }
    if (l.fadeInMs + l.fadeOutMs > l.durationMs) {
      const scale = l.durationMs / (l.fadeInMs + l.fadeOutMs);
      l.fadeInMs = Math.floor(l.fadeInMs * scale);
      l.fadeOutMs = Math.floor(l.fadeOutMs * scale);
      warnings.push(`Fades on layer "${l.id}" were shortened to fit the layer.`);
    }
    if (l.loop && opts.allowLoops === false) {
      errors.push({
        code: "LOOP_NOT_PERMITTED",
        layerId: l.id,
        message: `Looping is disabled for this session.`,
      });
    }
  }

  for (const t of plan.transitions ?? []) {
    if (!ids.has(t.fromLayerId) || !ids.has(t.toLayerId) || t.fromLayerId === t.toLayerId) {
      errors.push({
        code: "BAD_TRANSITION",
        message: `Transition ${t.fromLayerId} → ${t.toLayerId} references unknown layers.`,
      });
    } else if (t.startMs + t.durationMs > plan.durationMs) {
      errors.push({
        code: "BAD_TRANSITION",
        message: `Transition ${t.fromLayerId} → ${t.toLayerId} runs past the session end.`,
      });
    }
  }

  const hasSpeech = plan.layers.some((l) => l.role === "speech");
  if (hasSpeech && !plan.ducking) {
    plan.ducking = {
      enabled: true,
      amountDb: DEFAULT_DUCK_DB,
      attackMs: DEFAULT_ATTACK_MS,
      releaseMs: DEFAULT_RELEASE_MS,
    };
  }
  if (plan.masterGainDb === undefined) plan.masterGainDb = -3;

  // Catalogue + rights. Unknown ids are rejected; the client never supplies URLs.
  const assetIds = [...new Set(plan.layers.map((l) => l.assetId))];
  const validIds = assetIds.filter((id) => /^[0-9a-f-]{36}$/i.test(id));
  const assets = await assetsByIds(db, validIds, opts.territory, opts.now);
  const grants = await grantsFor(db, validIds);
  const byId = new Map(assets.map((a) => [a.id, a]));
  let needsReview = false;
  for (const l of plan.layers) {
    const asset = byId.get(l.assetId);
    if (!asset || (opts.allowedAssetIds && !opts.allowedAssetIds.has(l.assetId))) {
      errors.push({
        code: "UNKNOWN_ASSET",
        layerId: l.id,
        assetId: l.assetId,
        message: `Layer "${l.id}" references audio that is not in the catalogue.`,
      });
      continue;
    }
    if (!asset.isActive) {
      errors.push({
        code: "ASSET_INACTIVE",
        layerId: l.id,
        assetId: l.assetId,
        message: `"${asset.title}" is no longer available.`,
      });
      continue;
    }
    const uses: RightsUse[] = opts.requireExport ? ["mix", "derivative_render"] : ["mix"];
    for (const use of uses) {
      const d = evaluate(grants.get(asset.id) ?? [], use, opts.territory, opts.now);
      if (!d.allowed) {
        if (d.reason === "RIGHTS_UNDER_REVIEW") needsReview = true;
        errors.push({
          code: use === "mix" ? "NOT_CLEARED_FOR_MIX" : "EXPORT_NOT_PERMITTED",
          layerId: l.id,
          assetId: l.assetId,
          message: `"${asset.title}": ${useMessage(use, d.reason)}`,
        });
      }
    }
    if (!l.loop && asset.durationMs > 0 && l.sourceInMs + l.durationMs > asset.durationMs + 250) {
      errors.push({
        code: "SOURCE_TOO_SHORT",
        layerId: l.id,
        assetId: l.assetId,
        message: `"${asset.title}" is only ${Math.round(asset.durationMs / 1000)}s long; enable looping or shorten layer "${l.id}".`,
      });
    }
    if (l.loop && asset.durationMs > 0 && l.sourceInMs >= asset.durationMs) {
      errors.push({
        code: "SOURCE_TOO_SHORT",
        layerId: l.id,
        message: `Layer "${l.id}" trims past the end of its source.`,
      });
    }
  }

  plan.warnings = [...new Set(warnings)].slice(0, 20);
  const rightsErrors = errors.some((e) =>
    ["NOT_CLEARED_FOR_MIX", "EXPORT_NOT_PERMITTED", "UNKNOWN_ASSET", "ASSET_INACTIVE"].includes(e.code),
  );
  return {
    schemaValid: true,
    valid: errors.length === 0,
    rightsStatus: rightsErrors ? (needsReview ? "needs_review" : "invalid") : "valid",
    errors,
    warnings: plan.warnings,
    plan,
    assets,
  };
}
