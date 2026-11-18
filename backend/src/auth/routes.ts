import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AppDeps, AuthUser } from "../common/context.js";
import { requireUser } from "../common/context.js";
import { ApiError } from "../common/errors.js";
import { sha256, uuid } from "../common/ids.js";
import { hashPassword, randomToken, signJwt, verifyJwt, verifyPassword } from "./crypto.js";

interface UserRow {
  id: string;
  email: string;
  display_name: string;
  avatar_url: string | null;
  locale: string;
  territory: string;
  password_hash: string | null;
  is_guest: boolean;
  is_admin: boolean;
  created_at: Date | string;
  updated_at: Date | string;
}

export function userDto(u: UserRow) {
  return {
    id: u.id,
    email: u.is_guest ? null : u.email,
    displayName: u.display_name,
    avatarUrl: u.avatar_url,
    locale: u.locale,
    territory: u.territory,
    isGuest: u.is_guest,
    isAdmin: u.is_admin,
    createdAt: new Date(u.created_at).toISOString(),
    updatedAt: new Date(u.updated_at).toISOString(),
  };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Resolves the bearer token on every request (optional auth); routes decide whether auth is required. */
export function installAuthHook(app: FastifyInstance, deps: AppDeps): void {
  app.addHook("onRequest", async (req: FastifyRequest) => {
    const h = req.headers.authorization;
    if (!h?.startsWith("Bearer ")) return;
    const token = h.slice(7).trim();
    const res = verifyJwt(token, deps.config.jwtSecret, deps.now().getTime());
    if (res.ok) {
      req.user = {
        id: res.claims.sub,
        isGuest: !!res.claims.guest,
        isAdmin: !!res.claims.adm,
        territory: res.claims.ter ?? deps.config.defaultTerritory,
      };
      return;
    }
    if (res.reason === "expired")
      throw new ApiError("TOKEN_EXPIRED", "Your session expired. Refresh and try again.");
    // Managed-auth path: verify Supabase-issued tokens when configured.
    if (deps.config.supabaseJwtSecret) {
      const sb = verifyJwt(token, deps.config.supabaseJwtSecret, deps.now().getTime());
      if (sb.ok) {
        req.user = await upsertProviderUser(
          deps,
          "supabase",
          sb.claims.sub,
          (sb.claims as unknown as { email?: string }).email,
        );
        return;
      }
    }
    throw new ApiError("UNAUTHENTICATED", "Invalid access token.");
  });
}

async function upsertProviderUser(
  deps: AppDeps,
  provider: string,
  subject: string,
  email?: string,
): Promise<AuthUser> {
  const existing = await deps.db.one<UserRow>(
    `SELECT * FROM users WHERE auth_provider = $1 AND provider_subject = $2 AND deleted_at IS NULL`,
    [provider, subject],
  );
  const row =
    existing ??
    (await deps.db.one<UserRow>(
      `INSERT INTO users (id, email, display_name, auth_provider, provider_subject) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [
        uuid(),
        email ?? `${subject}@${provider}.invalid`,
        (email ?? "Listener").split("@")[0],
        provider,
        subject,
      ],
    ))!;
  return { id: row.id, isGuest: false, isAdmin: row.is_admin, territory: row.territory };
}

async function issueTokens(deps: AppDeps, u: UserRow) {
  const accessToken = signJwt(
    {
      sub: u.id,
      typ: "access",
      guest: u.is_guest || undefined,
      adm: u.is_admin || undefined,
      ter: u.territory,
    },
    deps.config.jwtSecret,
    deps.config.accessTokenTtlSec,
    deps.now().getTime(),
  );
  const refreshToken = randomToken(32);
  await deps.db.query(
    `INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at) VALUES ($1,$2,$3,$4)`,
    [
      uuid(),
      u.id,
      sha256(refreshToken),
      new Date(deps.now().getTime() + deps.config.refreshTokenTtlSec * 1000),
    ],
  );
  return {
    accessToken,
    refreshToken,
    expiresIn: deps.config.accessTokenTtlSec,
    tokenType: "Bearer",
    user: userDto(u),
  };
}

export function authRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { db, config } = deps;
  const strict = { config: { rateLimit: { max: config.authRateLimitPerMin, timeWindow: "1 minute" } } };

  app.post<{
    Body: { email: string; password: string; displayName?: string; locale?: string; territory?: string };
  }>(
    "/v1/auth/register",
    {
      ...strict,
      schema: {
        body: {
          type: "object",
          required: ["email", "password"],
          additionalProperties: false,
          properties: {
            email: { type: "string", maxLength: 254 },
            password: { type: "string", minLength: 8, maxLength: 200 },
            displayName: { type: "string", minLength: 1, maxLength: 80 },
            locale: { type: "string", maxLength: 10 },
            territory: { type: "string", pattern: "^[A-Z]{2}$" },
          },
        },
      },
    },
    async (req, reply) => {
      const email = req.body.email.trim().toLowerCase();
      if (!EMAIL_RE.test(email)) throw new ApiError("VALIDATION_FAILED", "Enter a valid email address.");
      const taken = await db.one(
        `SELECT 1 FROM users WHERE lower(email) = $1 AND deleted_at IS NULL AND is_guest = false`,
        [email],
      );
      if (taken) throw new ApiError("CONFLICT", "An account with this email already exists.");
      const u = (await db.one<UserRow>(
        `INSERT INTO users (id, email, display_name, password_hash, locale, territory, is_admin) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [
          uuid(),
          email,
          req.body.displayName ?? email.split("@")[0],
          await hashPassword(req.body.password),
          req.body.locale ?? "en-CA",
          req.body.territory ?? config.defaultTerritory,
          config.adminEmails.includes(email),
        ],
      ))!;
      await db.query(`INSERT INTO user_preferences (user_id) VALUES ($1) ON CONFLICT DO NOTHING`, [u.id]);
      reply.code(201);
      return issueTokens(deps, u);
    },
  );

  app.post<{ Body: { email: string; password: string } }>(
    "/v1/auth/login",
    {
      ...strict,
      schema: {
        body: {
          type: "object",
          required: ["email", "password"],
          properties: { email: { type: "string" }, password: { type: "string" } },
        },
      },
    },
    async (req) => {
      const u = await db.one<UserRow>(
        `SELECT * FROM users WHERE lower(email) = $1 AND deleted_at IS NULL AND is_guest = false`,
        [req.body.email.trim().toLowerCase()],
      );
      if (!u?.password_hash || !(await verifyPassword(req.body.password, u.password_hash))) {
        throw new ApiError("UNAUTHENTICATED", "Email or password is incorrect.");
      }
      return issueTokens(deps, u);
    },
  );

  app.post("/v1/auth/guest", strict, async (_req, reply) => {
    const u = (await db.one<UserRow>(
      `INSERT INTO users (id, email, display_name, is_guest) VALUES ($1,$2,'Guest',true) RETURNING *`,
      [uuid(), `guest-${uuid()}@guest.invalid`],
    ))!;
    await db.query(`INSERT INTO user_preferences (user_id) VALUES ($1) ON CONFLICT DO NOTHING`, [u.id]);
    reply.code(201);
    return issueTokens(deps, u);
  });

  app.post<{ Body: { refreshToken: string } }>(
    "/v1/auth/refresh",
    {
      schema: {
        body: {
          type: "object",
          required: ["refreshToken"],
          properties: { refreshToken: { type: "string", maxLength: 200 } },
        },
      },
    },
    async (req) => {
      const row = await db.one<{
        id: string;
        user_id: string;
        expires_at: Date | string;
        revoked_at: unknown;
      }>(`SELECT id, user_id, expires_at, revoked_at FROM refresh_tokens WHERE token_hash = $1`, [
        sha256(req.body.refreshToken),
      ]);
      if (!row || row.revoked_at || new Date(row.expires_at).getTime() <= deps.now().getTime()) {
        throw new ApiError("UNAUTHENTICATED", "Your session has ended. Please sign in again.");
      }
      await db.query(`UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1`, [row.id]); // rotation
      const u = await db.one<UserRow>(`SELECT * FROM users WHERE id = $1 AND deleted_at IS NULL`, [
        row.user_id,
      ]);
      if (!u) throw new ApiError("UNAUTHENTICATED", "Account not found.");
      return issueTokens(deps, u);
    },
  );

  app.post<{ Body: { refreshToken?: string } }>("/v1/auth/logout", async (req, reply) => {
    if (req.body?.refreshToken)
      await db.query(`UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1`, [
        sha256(req.body.refreshToken),
      ]);
    reply.code(204);
    return null;
  });

  /** Upgrade a guest session into a full account, keeping library data. */
  app.post<{ Body: { email: string; password: string; displayName?: string } }>(
    "/v1/auth/upgrade",
    {
      ...strict,
      schema: {
        body: {
          type: "object",
          required: ["email", "password"],
          properties: {
            email: { type: "string" },
            password: { type: "string", minLength: 8 },
            displayName: { type: "string" },
          },
        },
      },
    },
    async (req) => {
      const me = requireUser(req);
      if (!me.isGuest) throw new ApiError("BAD_REQUEST", "This session already belongs to an account.");
      const email = req.body.email.trim().toLowerCase();
      if (!EMAIL_RE.test(email)) throw new ApiError("VALIDATION_FAILED", "Enter a valid email address.");
      if (
        await db.one(
          `SELECT 1 FROM users WHERE lower(email) = $1 AND deleted_at IS NULL AND is_guest = false`,
          [email],
        )
      ) {
        throw new ApiError("CONFLICT", "An account with this email already exists.");
      }
      const u = (await db.one<UserRow>(
        `UPDATE users SET email = $2, password_hash = $3, display_name = $4, is_guest = false, updated_at = now() WHERE id = $1 RETURNING *`,
        [me.id, email, await hashPassword(req.body.password), req.body.displayName ?? email.split("@")[0]],
      ))!;
      return issueTokens(deps, u);
    },
  );
}

export async function loadUser(deps: AppDeps, id: string): Promise<UserRow | undefined> {
  return deps.db.one<UserRow>(`SELECT * FROM users WHERE id = $1 AND deleted_at IS NULL`, [id]);
}
