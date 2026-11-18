import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createPgliteDb } from "../src/db/db.js";
import type { AppDeps } from "../src/common/context.js";
import type { FetchLike } from "../src/ingestion/http.js";
import {
  DefaultPlannerGateway,
  type MixPlanner,
  type PlannerGateway,
} from "../src/fusion/planner/gateway.js";
import { RuleBasedPlanner } from "../src/fusion/planner/rule-based.js";

export interface TestCtx {
  app: FastifyInstance;
  deps: AppDeps;
  clock: { now: Date };
  close: () => Promise<void>;
}

export const noNetwork: FetchLike = async (url) => {
  throw new Error(`network disabled in tests: ${url}`);
};

export async function makeApp(
  opts: { planner?: PlannerGateway; primary?: MixPlanner | null; fetch?: FetchLike } = {},
): Promise<TestCtx> {
  const clock = { now: new Date("2026-06-01T12:00:00Z") };
  const db = await createPgliteDb();
  const config = loadConfig({
    pgliteDir: undefined,
    syntheticCatalogue: true,
    ingestOnStart: false,
    adminEmails: ["admin@test.dev"],
    publicBaseUrl: "http://test.local",
    authRateLimitPerMin: 10000,
  });
  const planner =
    opts.planner ?? new DefaultPlannerGateway(opts.primary ?? null, new RuleBasedPlanner(), 2000);
  const { app, deps } = await buildApp({
    config,
    db,
    fetch: opts.fetch ?? noNetwork,
    planner,
    now: () => clock.now,
    logger: false,
  });
  await app.ready();
  return {
    app,
    deps,
    clock,
    close: async () => {
      await app.close();
      await db.close();
    },
  };
}

export async function register(
  app: FastifyInstance,
  email = `u${Math.random().toString(36).slice(2)}@test.dev`,
) {
  const res = await app.inject({
    method: "POST",
    url: "/v1/auth/register",
    payload: { email, password: "correct horse battery", displayName: "Tester" },
  });
  if (res.statusCode !== 201) throw new Error(`register failed ${res.statusCode} ${res.body}`);
  const body = res.json() as { accessToken: string; refreshToken: string; user: { id: string } };
  return { ...body, headers: { authorization: `Bearer ${body.accessToken}` } };
}
