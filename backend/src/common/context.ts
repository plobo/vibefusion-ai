import type { FastifyRequest } from "fastify";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/db.js";
import { ApiError } from "./errors.js";
import type { Metrics } from "../observability/metrics.js";
import type { PlannerGateway } from "../fusion/planner/gateway.js";
import type { RecommendationService } from "../recommendations/service.js";
import type { FetchLike } from "../ingestion/http.js";

export interface AuthUser {
  id: string;
  isGuest: boolean;
  isAdmin: boolean;
  territory: string;
}

export interface AppDeps {
  config: AppConfig;
  db: Db;
  metrics: Metrics;
  planner: PlannerGateway;
  recommendations: RecommendationService;
  fetch: FetchLike;
  now: () => Date;
}

declare module "fastify" {
  interface FastifyRequest {
    user?: AuthUser;
  }
}

export function requireUser(req: FastifyRequest): AuthUser {
  if (!req.user) throw new ApiError("UNAUTHENTICATED", "Sign in to continue.");
  return req.user;
}

export function requireAccount(req: FastifyRequest): AuthUser {
  const u = requireUser(req);
  if (u.isGuest) throw new ApiError("FORBIDDEN", "Create an account to use this feature.");
  return u;
}

export function requireAdmin(req: FastifyRequest): AuthUser {
  const u = requireUser(req);
  if (!u.isAdmin) throw new ApiError("FORBIDDEN", "Administrator access required.");
  return u;
}

/** Territory for rights checks: authenticated user's territory, else X-Territory header, else default. */
export function territoryOf(req: FastifyRequest, fallback: string): string {
  if (req.user?.territory) return req.user.territory;
  const h = req.headers["x-territory"];
  const t = Array.isArray(h) ? h[0] : h;
  return t && /^[A-Z]{2}$/.test(t) ? t : fallback;
}
