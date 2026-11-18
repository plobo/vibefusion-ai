import type { FastifyReply, FastifyRequest } from "fastify";
import type { AppDeps } from "./context.js";

/**
 * Replays the stored response for a repeated Idempotency-Key (per user + route).
 * Keys are retained for 24 hours.
 */
export async function idempotent<T>(
  deps: AppDeps,
  req: FastifyRequest,
  reply: FastifyReply,
  route: string,
  userId: string,
  fn: () => Promise<{ status: number; body: T }>,
): Promise<T> {
  const raw = req.headers["idempotency-key"];
  const key = typeof raw === "string" && raw.length > 0 && raw.length <= 128 ? raw : null;
  if (key) {
    const hit = await deps.db.one<{ status_code: number; response: T }>(
      `SELECT status_code, response FROM idempotency_keys WHERE key = $1 AND user_id = $2 AND route = $3 AND created_at > now() - interval '24 hours'`,
      [key, userId, route],
    );
    if (hit) {
      reply.code(hit.status_code).header("Idempotent-Replay", "true");
      return hit.response;
    }
  }
  const out = await fn();
  if (key) {
    await deps.db.query(
      `INSERT INTO idempotency_keys (key, user_id, route, status_code, response) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
      [key, userId, route, out.status, JSON.stringify(out.body)],
    );
  }
  reply.code(out.status);
  return out.body;
}
