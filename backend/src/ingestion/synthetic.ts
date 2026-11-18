import fs from "node:fs";
import path from "node:path";
import type { Db } from "../db/db.js";
import { stableUuid } from "../common/ids.js";
import { upsertGrant } from "../rights/repo.js";
import type { RightsUse } from "../rights/policy.js";
import { BACKEND_ROOT } from "../config.js";

/**
 * Locally generated, deterministic test audio owned by the project (no third-party rights).
 * Used for development, automated tests, and as always-available Fusion Studio material.
 */
export const SAMPLE_RATE = 44100;
const BPM = 120;
const BEAT = 60 / BPM;

type Kind = "pad" | "pulse" | "drone" | "arp" | "rain" | "bells" | "voice" | "plain";

export interface SyntheticSpec {
  key: string;
  title: string;
  kind: Kind;
  assetType: "music" | "loop" | "stem" | "speech";
  seconds: number;
  genres: string[];
  moods: string[];
  topics?: string[];
  key_: string | null;
  uses: RightsUse[];
}

export const SYNTHETIC_SPECS: SyntheticSpec[] = [
  {
    key: "warm-pad",
    title: "Warm Pad (A minor)",
    kind: "pad",
    assetType: "loop",
    seconds: 32,
    genres: ["ambient", "cinematic"],
    moods: ["calm", "uplifting"],
    key_: "Am",
    uses: ["stream", "offline_download", "mix", "derivative_render"],
  },
  {
    key: "pulse-groove",
    title: "Pulse Groove 120",
    kind: "pulse",
    assetType: "loop",
    seconds: 16,
    genres: ["electronic"],
    moods: ["energetic", "focus"],
    key_: null,
    uses: ["stream", "offline_download", "mix", "derivative_render"],
  },
  {
    key: "cinematic-drone",
    title: "Cinematic Drone",
    kind: "drone",
    assetType: "stem",
    seconds: 32,
    genres: ["cinematic", "ambient"],
    moods: ["calm", "dramatic"],
    key_: "A",
    uses: ["stream", "offline_download", "mix", "derivative_render"],
  },
  {
    key: "arp-lights",
    title: "Arpeggio Lights",
    kind: "arp",
    assetType: "loop",
    seconds: 16,
    genres: ["electronic", "cinematic"],
    moods: ["uplifting", "energetic"],
    key_: "Am",
    uses: ["stream", "offline_download", "mix", "derivative_render"],
  },
  {
    key: "rain-texture",
    title: "Rain Texture",
    kind: "rain",
    assetType: "loop",
    seconds: 20,
    genres: ["ambient"],
    moods: ["calm", "sleep"],
    key_: null,
    uses: ["stream", "offline_download", "mix", "derivative_render"],
  },
  {
    key: "bell-melody",
    title: "Bell Melody (Piano-style)",
    kind: "bells",
    assetType: "music",
    seconds: 48,
    genres: ["classical", "piano"],
    moods: ["calm", "uplifting"],
    key_: "Am",
    uses: ["stream", "offline_download", "mix", "derivative_render"],
  },
  {
    key: "stream-only",
    title: "Stream-Only Test Track",
    kind: "plain",
    assetType: "music",
    seconds: 30,
    genres: ["electronic"],
    moods: ["uplifting"],
    key_: "C",
    uses: ["stream"],
  },
  {
    key: "voice-guide",
    title: "Voice Guide Test Signal",
    kind: "voice",
    assetType: "speech",
    seconds: 40,
    genres: [],
    moods: ["uplifting"],
    topics: ["resilience", "discipline"],
    key_: null,
    uses: ["stream", "offline_download", "mix", "derivative_render"],
  },
];

export const syntheticAssetId = (key: string) => stableUuid(`synthetic:${key}`);

function prng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

const midi = (n: number) => 440 * Math.pow(2, (n - 69) / 12);
const AM_CHORDS = [
  [57, 60, 64],
  [53, 57, 60],
  [48, 52, 55],
  [55, 59, 62],
];

function render(spec: SyntheticSpec): Float32Array[] {
  const n = Math.round(spec.seconds * SAMPLE_RATE);
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  const rand = prng(spec.key.length * 7919 + spec.seconds);
  const TWO_PI = Math.PI * 2;
  const barLen = BEAT * 4;
  let lp = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    let l = 0;
    let r = 0;
    switch (spec.kind) {
      case "pad": {
        const chord = AM_CHORDS[Math.floor(t / (barLen * 2)) % 4]!;
        const lfo = 0.6 + 0.4 * Math.sin(TWO_PI * 0.125 * t);
        for (const note of chord) {
          const f = midi(note);
          l += Math.sin(TWO_PI * f * t) * 0.12 * lfo;
          r += Math.sin(TWO_PI * f * 1.003 * t) * 0.12 * lfo;
        }
        break;
      }
      case "pulse": {
        const beatT = t % BEAT;
        const kick =
          Math.sin(TWO_PI * (50 + 90 * Math.exp(-beatT * 30)) * beatT) * Math.exp(-beatT * 8) * 0.7;
        const hatT = (t + BEAT / 2) % BEAT;
        const hat = (rand() * 2 - 1) * Math.exp(-hatT * 60) * 0.18;
        l = kick + hat;
        r = kick + hat * 0.8;
        break;
      }
      case "drone": {
        const f = midi(45);
        const swell = 0.5 + 0.5 * Math.sin(TWO_PI * (1 / spec.seconds) * t - Math.PI / 2);
        const v =
          (Math.sin(TWO_PI * f * t) +
            0.5 * Math.sin(TWO_PI * f * 1.5 * t) +
            0.25 * Math.sin(TWO_PI * f * 2 * t)) *
          0.18 *
          (0.4 + 0.6 * swell);
        l = v;
        r = v * 0.95;
        break;
      }
      case "arp": {
        const step = BEAT / 4;
        const idx = Math.floor(t / step);
        const chord = AM_CHORDS[Math.floor(t / barLen) % 4]!;
        const note = chord[idx % 3]! + 12 * (Math.floor(idx / 3) % 2);
        const local = t - idx * step;
        const v = Math.sin(TWO_PI * midi(note) * t) * Math.exp(-local * 9) * 0.3;
        l = v * (idx % 2 === 0 ? 1 : 0.6);
        r = v * (idx % 2 === 0 ? 0.6 : 1);
        break;
      }
      case "rain": {
        lp = lp * 0.92 + (rand() * 2 - 1) * 0.08;
        const drop = rand() > 0.9995 ? 0.4 : 0;
        l = lp * 0.5 + drop;
        r = lp * 0.48 + (rand() > 0.9995 ? 0.4 : 0);
        break;
      }
      case "bells": {
        const noteLen = BEAT * 2;
        const idx = Math.floor(t / noteLen);
        const melody = [69, 72, 76, 74, 72, 69, 67, 69];
        const local = t - idx * noteLen;
        const f = midi(melody[idx % melody.length]!);
        const v =
          (Math.sin(TWO_PI * f * t) +
            0.3 * Math.sin(TWO_PI * f * 2 * t) +
            0.1 * Math.sin(TWO_PI * f * 3 * t)) *
          Math.exp(-local * 2.2) *
          0.25;
        l = v;
        r = v;
        break;
      }
      case "voice": {
        // Syllable-like bursts of a formant-ish tone: a recognisable speech-shaped test signal.
        const syl = 0.22;
        const idx = Math.floor(t / syl);
        const phrase = Math.floor(t / 4) % 2 === 0 ? 3.2 : 2.6;
        const inPhrase = t % 4 < phrase;
        const local = t - idx * syl;
        const env = inPhrase ? Math.sin(Math.PI * Math.min(1, local / syl)) : 0;
        const f0 = 140 + 30 * Math.sin(idx * 1.7);
        const v =
          (Math.sin(TWO_PI * f0 * t) * 0.5 +
            Math.sin(TWO_PI * f0 * 4 * t) * 0.2 +
            Math.sin(TWO_PI * f0 * 7 * t) * 0.08) *
          env *
          0.5;
        l = v;
        r = v;
        break;
      }
      case "plain": {
        const chord = AM_CHORDS[Math.floor(t / barLen) % 4]!;
        for (const note of chord) l += Math.sin(TWO_PI * midi(note + 12) * t) * 0.08;
        r = l;
        break;
      }
    }
    // Short edge fades keep loop boundaries click-free.
    const edge = Math.min(1, t / 0.005, (spec.seconds - t) / 0.005);
    L[i] = l * edge;
    R[i] = r * edge;
  }
  return [L, R];
}

export function encodeWav(channels: Float32Array[], sampleRate = SAMPLE_RATE): Buffer {
  const n = channels[0]!.length;
  const ch = channels.length;
  const data = Buffer.alloc(n * ch * 2);
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < ch; c++) {
      const v = Math.max(-1, Math.min(1, channels[c]![i]!));
      data.writeInt16LE(Math.round(v * 32767), (i * ch + c) * 2);
    }
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(ch, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * ch * 2, 28);
  header.writeUInt16LE(ch * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

const cacheDir = path.join(BACKEND_ROOT, ".data", "synthetic");
const memo = new Map<string, Buffer>();

export function syntheticWav(key: string): Buffer | null {
  const spec = SYNTHETIC_SPECS.find((s) => s.key === key);
  if (!spec) return null;
  const hit = memo.get(key);
  if (hit) return hit;
  const file = path.join(cacheDir, `${key}.wav`);
  let buf: Buffer;
  if (fs.existsSync(file)) buf = fs.readFileSync(file);
  else {
    buf = encodeWav(render(spec));
    try {
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(file, buf);
    } catch {
      /* cache is best-effort */
    }
  }
  memo.set(key, buf);
  return buf;
}

export async function seedSynthetic(db: Db): Promise<number> {
  const creatorId = stableUuid("creator:vibefusion-sound-lab");
  await db.query(
    `INSERT INTO creators (id, name, creator_type, bio, source_key) VALUES ($1,$2,'label',$3,$4) ON CONFLICT (id) DO NOTHING`,
    [
      creatorId,
      "VibeFusion Sound Lab",
      "Synthetic, project-owned test audio generated on the server.",
      "synthetic:lab",
    ],
  );
  let added = 0;
  for (const spec of SYNTHETIC_SPECS) {
    const id = syntheticAssetId(spec.key);
    const res = await db.query(
      `INSERT INTO audio_assets (id, title, subtitle, description, asset_type, creator_id, duration_ms, streaming_format, mime_type,
         genres, moods, topics, tempo_bpm, musical_key, is_dev_fixture, source_key, popularity)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'progressive','audio/wav',$8,$9,$10,$11,$12,true,$13,5)
       ON CONFLICT (id) DO NOTHING RETURNING id`,
      [
        id,
        spec.title,
        "VibeFusion Sound Lab",
        "Synthetic test audio for development and Fusion Studio.",
        spec.assetType,
        creatorId,
        spec.seconds * 1000,
        spec.genres,
        spec.moods,
        spec.topics ?? [],
        spec.kind === "voice" || spec.kind === "rain" ? null : BPM,
        spec.key_,
        `synthetic:${spec.key}`,
      ],
    );
    if (res.length > 0) {
      added++;
      await db.query(
        `INSERT INTO asset_storage (asset_id, storage_kind, storage_key) VALUES ($1,'synthetic',$2) ON CONFLICT DO NOTHING`,
        [id, spec.key],
      );
    }
    await upsertGrant(db, {
      assetId: id,
      rightsHolder: "VibeFusion AI",
      licenseType: "owned",
      allowedUses: spec.uses,
      attributionRequired: false,
      commercialUse: true,
      proofReference: `internal:synthetic:${spec.key}`,
    });
  }
  return added;
}
