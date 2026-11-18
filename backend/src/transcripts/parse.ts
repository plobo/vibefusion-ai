export interface Cue {
  startMs: number;
  endMs: number;
  text: string;
  speaker: string | null;
}

const TS = /(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/;

function toMs(s: string): number {
  const m = s.match(TS);
  if (!m) return NaN;
  const [, h, mi, se, ms] = m;
  return ((Number(h ?? 0) * 60 + Number(mi)) * 60 + Number(se)) * 1000 + Number((ms ?? "0").padEnd(3, "0"));
}

/** Parses WebVTT or SRT (the formats Podcasting 2.0 `podcast:transcript` publishes). */
export function parseCaptions(body: string, maxCues = 5000): Cue[] {
  const blocks = body.replace(/\r/g, "").split(/\n{2,}/);
  const cues: Cue[] = [];
  for (const block of blocks) {
    const lines = block.split("\n").filter((l) => l.trim().length > 0);
    const idx = lines.findIndex((l) => l.includes("-->"));
    if (idx < 0) continue;
    const [a, b] = lines[idx]!.split("-->");
    const startMs = toMs(a ?? "");
    const endMs = toMs(b ?? "");
    if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs < startMs) continue;
    let text = lines
      .slice(idx + 1)
      .join(" ")
      .trim();
    let speaker: string | null = null;
    const v = text.match(/^<v(?:\.[^ >]*)?\s+([^>]+)>/);
    if (v) speaker = v[1]!.trim();
    const colon = !v ? text.match(/^([A-Z][\w .'-]{0,30}):\s/) : null;
    if (colon) {
      speaker = colon[1]!;
      text = text.slice(colon[0].length);
    }
    text = text
      .replace(/<[^>]+>/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) continue;
    cues.push({ startMs, endMs, text, speaker });
    if (cues.length >= maxCues) break;
  }
  return cues;
}
