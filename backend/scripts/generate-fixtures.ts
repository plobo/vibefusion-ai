import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "../src/config.js";
import { SYNTHETIC_SPECS, syntheticAssetId } from "../src/ingestion/synthetic.js";
import { buildEnvelopeCases } from "./fixture-data.js";

const dir = path.join(REPO_ROOT, "contracts", "fixtures");
fs.mkdirSync(dir, { recursive: true });
const write = (name: string, data: unknown) => {
  fs.writeFileSync(path.join(dir, name), JSON.stringify(data, null, 2) + "\n");
  console.log(`wrote contracts/fixtures/${name}`);
};

write("envelope-cases.json", buildEnvelopeCases());

const id = (k: string) => syntheticAssetId(k);
write("catalogue-synthetic.json", {
  description:
    "Synthetic, project-owned dev catalogue (served by the backend when SYNTHETIC_CATALOGUE=true).",
  items: SYNTHETIC_SPECS.map((s) => ({
    id: id(s.key),
    title: s.title,
    assetType: s.assetType,
    durationMs: s.seconds * 1000,
    genres: s.genres,
    moods: s.moods,
    topics: s.topics ?? [],
    key: s.key_,
    allowedUses: s.uses,
    licenseType: "owned",
  })),
});

const validPlan = {
  version: 1,
  title: "Rise with Purpose",
  description: "A gradual, uplifting session built from synthetic fixtures",
  durationMs: 120000,
  tempoBpm: 120,
  masterGainDb: -3,
  ducking: { enabled: true, amountDb: 9, attackMs: 300, releaseMs: 800 },
  layers: [
    {
      id: "layer-1",
      assetId: id("warm-pad"),
      role: "music",
      startMs: 0,
      sourceInMs: 0,
      durationMs: 120000,
      gainDb: -12,
      fadeInMs: 5000,
      fadeOutMs: 8000,
      loop: true,
      pan: 0,
    },
    {
      id: "layer-2",
      assetId: id("arp-lights"),
      role: "music",
      startMs: 20000,
      sourceInMs: 0,
      durationMs: 80000,
      gainDb: -8,
      fadeInMs: 10000,
      fadeOutMs: 12000,
      loop: true,
      pan: 0,
    },
    {
      id: "layer-3",
      assetId: id("voice-guide"),
      role: "speech",
      startMs: 40000,
      sourceInMs: 0,
      durationMs: 40000,
      gainDb: 0,
      fadeInMs: 1500,
      fadeOutMs: 2500,
      loop: false,
      pan: 0,
    },
  ],
  transitions: [],
  warnings: [],
};
write("mix-plan-valid.json", validPlan);
write("mix-plan-invalid.json", {
  description: "Each entry must be rejected by the validator with the listed issue code.",
  cases: [
    { expect: "SCHEMA", plan: { ...validPlan, layers: [{ ...validPlan.layers[0], gainDb: 40 }] } },
    { expect: "SCHEMA", plan: { ...validPlan, layers: [{ ...validPlan.layers[0], startMs: -5 }] } },
    {
      expect: "SCHEMA",
      plan: {
        ...validPlan,
        transitions: [
          { fromLayerId: "layer-1", toLayerId: "layer-2", startMs: 0, durationMs: 1000, curve: "s_curve" },
        ],
      },
    },
    {
      expect: "DUPLICATE_LAYER_ID",
      plan: { ...validPlan, layers: [validPlan.layers[0], { ...validPlan.layers[1], id: "layer-1" }] },
    },
    {
      expect: "UNKNOWN_ASSET",
      plan: {
        ...validPlan,
        layers: [{ ...validPlan.layers[0], assetId: "00000000-0000-4000-8000-000000000000" }],
      },
    },
    {
      expect: "NOT_CLEARED_FOR_MIX",
      plan: { ...validPlan, layers: [{ ...validPlan.layers[0], assetId: id("stream-only"), loop: true }] },
    },
    {
      expect: "LAYER_OUT_OF_RANGE",
      plan: { ...validPlan, layers: [{ ...validPlan.layers[0], startMs: 130000, durationMs: 10000 }] },
    },
    {
      expect: "SOURCE_TOO_SHORT",
      plan: {
        ...validPlan,
        layers: [{ ...validPlan.layers[2], loop: false, durationMs: 60000, startMs: 0 }],
      },
    },
    {
      expect: "BAD_TRANSITION",
      plan: {
        ...validPlan,
        transitions: [
          { fromLayerId: "layer-1", toLayerId: "ghost", startMs: 0, durationMs: 1000, curve: "linear" },
        ],
      },
    },
  ],
});
