import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import type { AppConfig } from "./config.js";
import type { AppDeps } from "./common/context.js";
import { ApiError, errorEnvelope } from "./common/errors.js";
import { uuid } from "./common/ids.js";
import { createPgDb, createPgliteDb, migrate, type Db } from "./db/db.js";
import { Metrics } from "./observability/metrics.js";
import { DefaultPlannerGateway, type PlannerGateway } from "./fusion/planner/gateway.js";
import { RuleBasedPlanner } from "./fusion/planner/rule-based.js";
import { AnthropicPlanner } from "./fusion/planner/anthropic.js";
import { RuleBasedRecommendations } from "./recommendations/service.js";
import { defaultFetch, type FetchLike } from "./ingestion/http.js";
import { installAuthHook, authRoutes } from "./auth/routes.js";
import { meRoutes } from "./me/routes.js";
import { catalogueRoutes } from "./catalogue/routes.js";
import { searchRoutes } from "./search/routes.js";
import { playbackRoutes } from "./playback/routes.js";
import { libraryRoutes } from "./library/routes.js";
import { playlistRoutes } from "./playlists/routes.js";
import { podcastRoutes, seedSyntheticTranscript } from "./podcasts/routes.js";
import { fusionRoutes } from "./fusion/routes.js";
import { adminRoutes } from "./admin/routes.js";
import { seedSynthetic } from "./ingestion/synthetic.js";
import { rebuildCollections } from "./ingestion/sources.js";

export interface BuildOptions {
  config: AppConfig;
  db?: Db;
  fetch?: FetchLike;
  planner?: PlannerGateway;
  now?: () => Date;
  logger?: boolean;
}

export function createPlanner(config: AppConfig, metrics: Metrics): PlannerGateway {
  const fallback = new RuleBasedPlanner();
  const wantsLlm =
    config.llmProvider === "anthropic" || (config.llmProvider === "auto" && !!process.env.ANTHROPIC_API_KEY);
  const primary =
    config.llmProvider === "rules" || !wantsLlm
      ? null
      : new AnthropicPlanner(config.anthropicModel, process.env.ANTHROPIC_API_KEY);
  return new DefaultPlannerGateway(primary, fallback, 45000, (provider) =>
    metrics.inc("ai_provider_errors_total", { provider }),
  );
}

export async function buildApp(
  opts: BuildOptions,
): Promise<{ app: FastifyInstance; deps: AppDeps; routes: { method: string; url: string }[] }> {
  const { config } = opts;
  const db =
    opts.db ??
    (config.databaseUrl ? await createPgDb(config.databaseUrl) : await createPgliteDb(config.pgliteDir));
  await migrate(db);
  const metrics = new Metrics();
  const now = opts.now ?? (() => new Date());
  const deps: AppDeps = {
    config,
    db,
    metrics,
    planner: opts.planner ?? createPlanner(config, metrics),
    recommendations: new RuleBasedRecommendations(db, now),
    fetch: opts.fetch ?? defaultFetch,
    now,
  };

  if (config.syntheticCatalogue) {
    await seedSynthetic(db);
    await seedSyntheticTranscript(deps);
    await rebuildCollections(db);
  }

  const app = Fastify({
    logger:
      opts.logger === false
        ? false
        : { level: config.logLevel, redact: ["req.headers.authorization", "req.headers.cookie"] },
    genReqId: (req) => {
      const h = req.headers["x-request-id"];
      return typeof h === "string" && /^[\w-]{8,64}$/.test(h) ? h : uuid();
    },
    bodyLimit: 512 * 1024,
    routerOptions: { maxParamLength: 1024 },
    trustProxy: true,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false, allErrors: false } },
  });

  await app.register(cors, { origin: true, exposedHeaders: ["ETag", "X-Request-Id", "Idempotent-Replay"] });
  await app.register(rateLimit, {
    global: true,
    max: 600,
    timeWindow: "1 minute",
    keyGenerator: (req) => req.headers.authorization?.slice(-24) ?? req.ip,
    errorResponseBuilder: (_req, ctx) =>
      new ApiError("RATE_LIMITED", `Too many requests. Try again in ${Math.ceil(ctx.ttl / 1000)}s.`),
  });

  app.addHook("onRequest", async (req, reply) => {
    reply.header("X-Request-Id", req.id);
    (req as unknown as { _t: number })._t = Date.now();
  });
  installAuthHook(app, deps);
  app.addHook("onResponse", async (req, reply) => {
    const t = (req as unknown as { _t?: number })._t;
    const route = req.routeOptions?.url ?? "unknown";
    metrics.inc("http_requests_total", { route, status: String(reply.statusCode) });
    if (t) metrics.observe("http_request_duration_ms", Date.now() - t, { route });
  });

  app.setErrorHandler((err, req, reply) => {
    let apiErr: ApiError;
    if (err instanceof ApiError) apiErr = err;
    else if ((err as { validation?: unknown }).validation)
      apiErr = new ApiError("VALIDATION_FAILED", `Invalid request: ${(err as Error).message}`);
    else if ((err as { statusCode?: number }).statusCode === 429)
      apiErr = new ApiError("RATE_LIMITED", "Too many requests.");
    else if ((err as { statusCode?: number }).statusCode && (err as { statusCode: number }).statusCode < 500)
      apiErr = new ApiError("BAD_REQUEST", (err as Error).message);
    else {
      req.log.error({ err }, "unhandled error");
      if (process.env.VF_DEBUG_ERRORS) console.error(err);
      apiErr = new ApiError("INTERNAL", "Something went wrong on our side. Please try again.");
    }
    if (apiErr.status >= 500) metrics.inc("http_errors_total", { code: apiErr.code });
    reply.code(apiErr.status).send(errorEnvelope(apiErr, req.id));
  });
  app.setNotFoundHandler((req, reply) => {
    reply.code(404).send(errorEnvelope(new ApiError("NOT_FOUND", "Route not found."), req.id));
  });

  app.get("/healthz", async () => ({ status: "ok" }));
  app.get("/readyz", async () => {
    await db.query("SELECT 1");
    return { status: "ready" };
  });
  app.get("/metrics", async (_req, reply) => {
    reply.type("text/plain; version=0.0.4");
    return metrics.render();
  });

  const routes: { method: string; url: string }[] = [];
  app.addHook("onRoute", (r) => {
    for (const m of [r.method].flat()) if (m !== "HEAD") routes.push({ method: m, url: r.url });
  });
  authRoutes(app, deps);
  meRoutes(app, deps);
  catalogueRoutes(app, deps);
  searchRoutes(app, deps);
  playbackRoutes(app, deps);
  libraryRoutes(app, deps);
  playlistRoutes(app, deps);
  podcastRoutes(app, deps);
  fusionRoutes(app, deps);
  adminRoutes(app, deps);

  app.addHook("onClose", async () => {
    if (!opts.db) await db.close();
  });
  return { app, deps, routes };
}
