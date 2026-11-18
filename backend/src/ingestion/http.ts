export type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}>;

export const defaultFetch: FetchLike = (url, init) => fetch(url, init);

const UA = "VibeFusionCatalogueBot/0.1 (+https://vibefusion.app/bot)";

export async function getJson<T>(f: FetchLike, url: string, timeoutMs = 20000): Promise<T> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await f(url, {
      headers: { "User-Agent": UA, Accept: "application/json" },
      signal: ctl.signal,
    });
    if (!res.ok) throw new Error(`GET ${new URL(url).host} failed: ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

export async function getText(f: FetchLike, url: string, timeoutMs = 20000): Promise<string> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await f(url, { headers: { "User-Agent": UA }, signal: ctl.signal });
    if (!res.ok) throw new Error(`GET ${new URL(url).host} failed: ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/** Parse "420.24", "07:00", "1:02:03" into milliseconds. */
export function parseDurationMs(v: unknown): number {
  if (typeof v === "number") return Math.round(v * 1000);
  if (typeof v !== "string" || !v.trim()) return 0;
  const s = v.trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(parseFloat(s) * 1000);
  const parts = s.split(":").map((p) => parseFloat(p));
  if (parts.some((p) => Number.isNaN(p))) return 0;
  return Math.round(parts.reduce((acc, p) => acc * 60 + p, 0) * 1000);
}
