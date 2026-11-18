import crypto from "node:crypto";

export const uuid = () => crypto.randomUUID();

/** Deterministic UUIDv5-style id from a namespace + name (used for idempotent ingestion). */
export function stableUuid(name: string): string {
  const h = crypto.createHash("sha1").update(`vibefusion:${name}`).digest();
  h[6] = (h[6]! & 0x0f) | 0x50;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const hex = h.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export const isUuid = (s: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

export function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ o: offset })).toString("base64url");
}
export function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const v = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { o?: unknown };
    return typeof v.o === "number" && v.o >= 0 ? Math.floor(v.o) : 0;
  } catch {
    return 0;
  }
}
export const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
export const randomTokenId = (bytes = 16) => crypto.randomBytes(bytes).toString("base64url");
