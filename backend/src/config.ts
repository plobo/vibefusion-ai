import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
/** Repository root of the backend package (works from src/ via tsx and from dist/src/ when compiled). */
export const BACKEND_ROOT = here.includes(`${path.sep}dist${path.sep}`)
  ? path.resolve(here, "..", "..")
  : path.resolve(here, "..");
export const REPO_ROOT = path.resolve(BACKEND_ROOT, "..");

export interface AppConfig {
  port: number;
  host: string;
  databaseUrl?: string;
  pgliteDir?: string; // undefined => in-memory
  jwtSecret: string;
  mediaSigningSecret: string;
  publicBaseUrl: string;
  accessTokenTtlSec: number;
  refreshTokenTtlSec: number;
  mediaUrlTtlSec: number;
  llmProvider: "auto" | "anthropic" | "rules" | "disabled";
  anthropicModel: string;
  aiDailyQuota: number;
  ingestOnStart: boolean;
  syntheticCatalogue: boolean;
  adminEmails: string[];
  defaultTerritory: string;
  logLevel: string;
  supabaseJwtSecret?: string;
  authRateLimitPerMin: number;
}

function bool(v: string | undefined, def: boolean): boolean {
  if (v === undefined || v === "") return def;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const env = process.env;
  const isProd = env.NODE_ENV === "production";
  const jwtSecret = env.JWT_SECRET ?? (isProd ? "" : "dev-only-jwt-secret-change-me");
  const mediaSigningSecret = env.MEDIA_SIGNING_SECRET ?? (isProd ? "" : "dev-only-media-secret-change-me");
  if (isProd && (!jwtSecret || !mediaSigningSecret)) {
    throw new Error(
      "JWT_SECRET and MEDIA_SIGNING_SECRET must be provided from the secret store in production",
    );
  }
  const port = Number(env.PORT ?? 8080);
  return {
    port,
    host: env.HOST ?? "0.0.0.0",
    databaseUrl: env.DATABASE_URL || undefined,
    pgliteDir: env.PGLITE_DIR ?? path.join(BACKEND_ROOT, ".data", "pglite"),
    jwtSecret,
    mediaSigningSecret,
    publicBaseUrl: (env.PUBLIC_BASE_URL ?? `http://localhost:${port}`).replace(/\/$/, ""),
    accessTokenTtlSec: Number(env.ACCESS_TOKEN_TTL_SEC ?? 3600),
    refreshTokenTtlSec: Number(env.REFRESH_TOKEN_TTL_SEC ?? 60 * 60 * 24 * 30),
    mediaUrlTtlSec: Number(env.MEDIA_URL_TTL_SEC ?? 900),
    llmProvider: (env.LLM_PROVIDER as AppConfig["llmProvider"]) ?? "auto",
    anthropicModel: env.ANTHROPIC_MODEL ?? "claude-opus-5-5",
    aiDailyQuota: Number(env.AI_DAILY_QUOTA ?? 50),
    ingestOnStart: bool(env.INGEST_ON_START, true),
    syntheticCatalogue: bool(env.SYNTHETIC_CATALOGUE, true),
    adminEmails: (env.ADMIN_EMAILS ?? "admin@vibefusion.local").split(",").map((s) => s.trim().toLowerCase()),
    defaultTerritory: env.DEFAULT_TERRITORY ?? "CA",
    logLevel: env.LOG_LEVEL ?? "info",
    supabaseJwtSecret: env.SUPABASE_JWT_SECRET || undefined,
    authRateLimitPerMin: Number(env.AUTH_RATE_LIMIT_PER_MIN ?? 10),
    ...overrides,
  };
}
