import crypto from "node:crypto";
import type { RightsUse } from "../rights/policy.js";

export interface MediaClaims {
  a: string; // asset id
  u: string; // user id
  p: RightsUse; // purpose the URL was authorized for
  e: number; // expiry (unix seconds)
}

export function signMedia(claims: MediaClaims, secret: string): string {
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export type MediaVerify = { ok: true; claims: MediaClaims } | { ok: false; reason: "invalid" | "expired" };

export function verifyMedia(token: string, secret: string, nowMs: number): MediaVerify {
  const [body, sig] = token.split(".");
  if (!body || !sig) return { ok: false, reason: "invalid" };
  const expected = crypto.createHmac("sha256", secret).update(body).digest();
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected))
    return { ok: false, reason: "invalid" };
  try {
    const claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as MediaClaims;
    if (typeof claims.e !== "number" || claims.e * 1000 <= nowMs) return { ok: false, reason: "expired" };
    return { ok: true, claims };
  } catch {
    return { ok: false, reason: "invalid" };
  }
}
