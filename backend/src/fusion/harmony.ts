/** Camelot-wheel harmonic compatibility (same key, relative major/minor, ±1 step). */
const MAJOR = ["C", "G", "D", "A", "E", "B", "F#", "Db", "Ab", "Eb", "Bb", "F"];
const MINOR = ["Am", "Em", "Bm", "F#m", "C#m", "G#m", "D#m", "Bbm", "Fm", "Cm", "Gm", "Dm"];
const ALIASES: Record<string, string> = {
  Gb: "F#",
  "C#": "Db",
  "G#": "Ab",
  "D#": "Eb",
  "A#": "Bb",
  Gbm: "F#m",
  Dbm: "C#m",
  Abm: "G#m",
  Ebm: "D#m",
  "A#m": "Bbm",
};

export function normalizeKey(k: string): string {
  const t = k
    .trim()
    .replace(/\s*(major|maj)$/i, "")
    .replace(/\s*(minor|min)$/i, "m");
  return ALIASES[t] ?? t;
}

export function compatibleKeys(key: string): string[] {
  const k = normalizeKey(key);
  let i = MAJOR.indexOf(k);
  const out = new Set<string>();
  const add = (arr: string[], idx: number) => out.add(arr[(idx + 12) % 12]!);
  if (i >= 0) {
    [i - 1, i, i + 1].forEach((x) => add(MAJOR, x));
    add(MINOR, i);
  } else {
    i = MINOR.indexOf(k);
    if (i < 0) return [k];
    [i - 1, i, i + 1].forEach((x) => add(MINOR, x));
    add(MAJOR, i);
  }
  return [...out];
}
