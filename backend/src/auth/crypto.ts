import crypto from "node:crypto";

const SCRYPT_N = 16384;

function scrypt(password: string, salt: Buffer, len: number, n: number): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    crypto.scrypt(password, salt, len, { N: n, r: 8, p: 1 }, (e, k) => (e ? reject(e) : resolve(k))),
  );
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, 64, SCRYPT_N);
  return `scrypt$${SCRYPT_N}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, n, saltB64, keyB64] = stored.split("$");
  if (alg !== "scrypt" || !n || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, "base64");
  const key = await scrypt(password, Buffer.from(saltB64, "base64"), expected.length, Number(n));
  return crypto.timingSafeEqual(key, expected);
}

const b64u = (b: Buffer | string) => Buffer.from(b).toString("base64url");

export interface JwtClaims {
  sub: string;
  iat: number;
  exp: number;
  typ: "access";
  guest?: boolean;
  adm?: boolean;
  ter?: string;
}

export function signJwt(
  claims: Omit<JwtClaims, "iat" | "exp">,
  secret: string,
  ttlSec: number,
  now = Date.now(),
): string {
  const header = b64u(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const iat = Math.floor(now / 1000);
  const payload = b64u(JSON.stringify({ ...claims, iat, exp: iat + ttlSec }));
  const sig = crypto.createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${sig}`;
}

export type JwtResult =
  { ok: true; claims: JwtClaims } | { ok: false; reason: "malformed" | "signature" | "expired" };

export function verifyJwt(token: string, secret: string, now = Date.now()): JwtResult {
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [h, p, s] = parts as [string, string, string];
  let header: { alg?: string };
  try {
    header = JSON.parse(Buffer.from(h, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (header.alg !== "HS256") return { ok: false, reason: "malformed" };
  const expected = crypto.createHmac("sha256", secret).update(`${h}.${p}`).digest();
  const given = Buffer.from(s, "base64url");
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    return { ok: false, reason: "signature" };
  }
  let claims: JwtClaims;
  try {
    claims = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (typeof claims.exp !== "number" || claims.exp * 1000 <= now) return { ok: false, reason: "expired" };
  return { ok: true, claims };
}

export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString("base64url");
