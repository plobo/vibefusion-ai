import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeApp, register, type TestCtx } from "./helpers.js";
import { syntheticAssetId } from "../src/ingestion/synthetic.js";
import { REPO_ROOT } from "../src/config.js";
import type { MixPlanner } from "../src/fusion/planner/gateway.js";

const PAD = syntheticAssetId("warm-pad");
const ARP = syntheticAssetId("arp-lights");
const VOICE = syntheticAssetId("voice-guide");
const STREAM_ONLY = syntheticAssetId("stream-only");
const validPlan = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, "contracts/fixtures/mix-plan-valid.json"), "utf8"),
);
const invalidCases = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, "contracts/fixtures/mix-plan-invalid.json"), "utf8"),
).cases as { expect: string; plan: unknown }[];

let ctx: TestCtx;
beforeAll(async () => {
  ctx = await makeApp();
});
afterAll(async () => ctx.close());

describe("auth", () => {
  it("registers, logs in, refreshes with rotation, and rejects bad credentials", async () => {
    const email = "auth@test.dev";
    const reg = await register(ctx.app, email);
    expect(reg.user.id).toBeTruthy();
    const dup = await ctx.app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email, password: "another password" },
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe("CONFLICT");
    const bad = await ctx.app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email, password: "wrong" },
    });
    expect(bad.statusCode).toBe(401);
    expect(bad.json().error).toMatchObject({ code: "UNAUTHENTICATED", retryable: false });
    expect(bad.json().error.requestId).toBeTruthy();
    const login = await ctx.app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email, password: "correct horse battery" },
    });
    expect(login.statusCode).toBe(200);
    const r1 = await ctx.app.inject({
      method: "POST",
      url: "/v1/auth/refresh",
      payload: { refreshToken: login.json().refreshToken },
    });
    expect(r1.statusCode).toBe(200);
    const reuse = await ctx.app.inject({
      method: "POST",
      url: "/v1/auth/refresh",
      payload: { refreshToken: login.json().refreshToken },
    });
    expect(reuse.statusCode).toBe(401);
    const me = await ctx.app.inject({
      url: "/v1/me",
      headers: { authorization: `Bearer ${r1.json().accessToken}` },
    });
    expect(me.json().email).toBe(email);
  });

  it("expired access tokens return TOKEN_EXPIRED", async () => {
    const u = await register(ctx.app);
    ctx.clock.now = new Date(ctx.clock.now.getTime() + 2 * 3600_000);
    const res = await ctx.app.inject({ url: "/v1/me", headers: u.headers });
    ctx.clock.now = new Date("2026-06-01T12:00:00Z");
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("TOKEN_EXPIRED");
  });

  it("supports guest sessions and upgrades", async () => {
    const g = await ctx.app.inject({ method: "POST", url: "/v1/auth/guest" });
    expect(g.statusCode).toBe(201);
    const headers = { authorization: `Bearer ${g.json().accessToken}` };
    const dl = await ctx.app.inject({
      method: "POST",
      url: "/v1/playback/authorize",
      headers,
      payload: { assetId: PAD, context: "offline_download" },
    });
    expect(dl.statusCode).toBe(403);
    const up = await ctx.app.inject({
      method: "POST",
      url: "/v1/auth/upgrade",
      headers,
      payload: { email: "upgraded@test.dev", password: "long enough pw" },
    });
    expect(up.statusCode).toBe(200);
    expect(up.json().user.isGuest).toBe(false);
  });
});

describe("catalogue & search", () => {
  it("guest browsing works without auth and hides storage keys", async () => {
    const res = await ctx.app.inject({ url: "/v1/catalogue?type=loop,music&limit=3" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items.length).toBe(3);
    expect(body.nextCursor).toBeTruthy();
    expect(JSON.stringify(body)).not.toContain("storage");
    const next = await ctx.app.inject({
      url: `/v1/catalogue?type=loop,music&limit=3&cursor=${body.nextCursor}`,
    });
    expect(next.json().items[0].id).not.toBe(body.items[0].id);
  });
  it("returns home shelves, genres, moods, collections", async () => {
    const home = await ctx.app.inject({ url: "/v1/home" });
    expect(home.json().shelves.map((s: { id: string }) => s.id)).toEqual(
      expect.arrayContaining(["daily-motivation", "genres", "fusion-ready"]),
    );
    expect((await ctx.app.inject({ url: "/v1/genres" })).json().items.length).toBeGreaterThan(0);
    expect((await ctx.app.inject({ url: "/v1/moods" })).json().items.length).toBeGreaterThan(0);
    const col = await ctx.app.inject({ url: "/v1/collections/fusion-ready" });
    expect(col.statusCode).toBe(200);
    expect(col.json().items.some((a: { id: string }) => a.id === STREAM_ONLY)).toBe(false);
  });
  it("searches with prefix matching and grouping", async () => {
    const res = await ctx.app.inject({ url: "/v1/search?q=arpeg" });
    expect(res.statusCode).toBe(200);
    expect(res.json().tracks[0].id).toBe(ARP);
    const speech = await ctx.app.inject({ url: "/v1/search?q=voice&content=spoken" });
    expect(speech.json().speeches[0].id).toBe(VOICE);
    expect((await ctx.app.inject({ url: "/v1/search?q=" })).statusCode).toBe(400);
  });
  it("asset detail exposes capabilities and chapters", async () => {
    const res = await ctx.app.inject({ url: `/v1/assets/${STREAM_ONLY}` });
    expect(res.json().capabilities).toEqual({ stream: true, download: false, mix: false, render: false });
    const voice = await ctx.app.inject({ url: `/v1/assets/${VOICE}` });
    expect(voice.json().chapters.length).toBe(3);
    expect(voice.json().hasTranscript).toBe(true);
    expect((await ctx.app.inject({ url: `/v1/assets/not-a-uuid` })).statusCode).toBe(404);
  });
});

describe("playback (Scenario A, B)", () => {
  it("authorizes, streams with range support, and resumes progress", async () => {
    const u = await register(ctx.app);
    const auth = await ctx.app.inject({
      method: "POST",
      url: "/v1/playback/authorize",
      headers: u.headers,
      payload: { assetId: PAD },
    });
    expect(auth.statusCode).toBe(200);
    const body = auth.json();
    expect(body.url).toMatch(/^http:\/\/test\.local\/v1\/media\/.+\.wav$/);
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(ctx.clock.now.getTime());
    const mediaPath = new URL(body.url).pathname;
    const full = await ctx.app.inject({ url: mediaPath });
    expect(full.statusCode).toBe(200);
    expect(full.headers["content-type"]).toBe("audio/wav");
    expect(full.rawPayload.subarray(0, 4).toString()).toBe("RIFF");
    const part = await ctx.app.inject({ url: mediaPath, headers: { range: "bytes=0-99" } });
    expect(part.statusCode).toBe(206);
    expect(part.rawPayload.length).toBe(100);

    // Scenario B: progress persisted at 12 minutes equivalent, resumed on next authorize.
    await ctx.app.inject({
      method: "POST",
      url: "/v1/playback/progress",
      headers: u.headers,
      payload: { assetId: VOICE, positionMs: 12000 },
    });
    const again = await ctx.app.inject({
      method: "POST",
      url: "/v1/playback/authorize",
      headers: u.headers,
      payload: { assetId: VOICE },
    });
    expect(again.json().resumePositionMs).toBe(12000);
    const recent = await ctx.app.inject({ url: "/v1/playback/recent", headers: u.headers });
    expect(recent.json().items[0].asset.id).toBe(VOICE);
    const home = await ctx.app.inject({ url: "/v1/home", headers: u.headers });
    expect(home.json().shelves[0].id).toBe("continue");
  });

  it("expired signed URLs fail with a retryable error and can be re-authorized", async () => {
    const u = await register(ctx.app);
    const auth = (
      await ctx.app.inject({
        method: "POST",
        url: "/v1/playback/authorize",
        headers: u.headers,
        payload: { assetId: PAD },
      })
    ).json();
    ctx.clock.now = new Date(ctx.clock.now.getTime() + 16 * 60_000);
    const expired = await ctx.app.inject({ url: new URL(auth.url).pathname });
    expect(expired.statusCode).toBe(410);
    expect(expired.json().error).toMatchObject({ code: "MEDIA_URL_EXPIRED", retryable: true });
    ctx.clock.now = new Date("2026-06-01T12:00:00Z");
    const tampered = await ctx.app.inject({ url: new URL(auth.url).pathname.replace(/.\.wav$/, "x.wav") });
    expect(tampered.statusCode).toBe(403);
  });

  it("filters analytics events to the allow-list", async () => {
    const u = await register(ctx.app);
    const res = await ctx.app.inject({
      method: "POST",
      url: "/v1/playback/events",
      headers: u.headers,
      payload: {
        platform: "ios",
        events: [
          { name: "playback_started", properties: { assetId: PAD, email: "x@y.z", latencyMs: 300 } },
          { name: "evil_event" },
        ],
      },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ accepted: 1, dropped: 1 });
    const row = await ctx.deps.db.one<{ properties: Record<string, unknown>; pseudonymous_id: string }>(
      `SELECT properties, pseudonymous_id FROM product_events ORDER BY id DESC LIMIT 1`,
    );
    expect(row?.properties).toEqual({ assetId: PAD, latencyMs: 300 });
    expect(row?.pseudonymous_id).not.toBe(u.user.id);
  });
});

describe("library & playlists", () => {
  it("likes, playlists with version conflicts, reorder, delete", async () => {
    const u = await register(ctx.app);
    expect(
      (await ctx.app.inject({ method: "PUT", url: `/v1/library/likes/${PAD}`, headers: u.headers }))
        .statusCode,
    ).toBe(204);
    expect(
      (await ctx.app.inject({ method: "PUT", url: `/v1/library/likes/${PAD}`, headers: u.headers }))
        .statusCode,
    ).toBe(204);
    const lib = await ctx.app.inject({ url: "/v1/library", headers: u.headers });
    expect(lib.json().likedMusic.map((a: { id: string }) => a.id)).toEqual([PAD]);

    const created = await ctx.app.inject({
      method: "POST",
      url: "/v1/playlists",
      headers: { ...u.headers, "idempotency-key": "pl-1" },
      payload: { name: "Focus", assetIds: [PAD, ARP] },
    });
    expect(created.statusCode).toBe(201);
    const replay = await ctx.app.inject({
      method: "POST",
      url: "/v1/playlists",
      headers: { ...u.headers, "idempotency-key": "pl-1" },
      payload: { name: "Focus", assetIds: [PAD, ARP] },
    });
    expect(replay.json().id).toBe(created.json().id);
    expect(replay.headers["idempotent-replay"]).toBe("true");
    const pl = created.json();
    expect(pl.items.map((i: { assetId: string }) => i.assetId)).toEqual([PAD, ARP]);

    const added = await ctx.app.inject({
      method: "POST",
      url: `/v1/playlists/${pl.id}/items`,
      headers: u.headers,
      payload: { assetId: VOICE, position: 0, version: pl.version },
    });
    expect(added.statusCode).toBe(201);
    const v2 = added.json();
    expect(v2.items.map((i: { assetId: string }) => i.assetId)).toEqual([VOICE, PAD, ARP]);
    // Stale version from another device is rejected rather than silently overwritten.
    const stale = await ctx.app.inject({
      method: "PATCH",
      url: `/v1/playlists/${pl.id}`,
      headers: { ...u.headers, "if-match": `"${pl.version}"` },
      payload: { name: "Renamed" },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe("VERSION_CONFLICT");
    const reordered = await ctx.app.inject({
      method: "PATCH",
      url: `/v1/playlists/${pl.id}/items/reorder`,
      headers: u.headers,
      payload: { itemIds: [...v2.items].reverse().map((i: { id: string }) => i.id), version: v2.version },
    });
    expect(reordered.json().items.map((i: { assetId: string }) => i.assetId)).toEqual([ARP, PAD, VOICE]);
    const other = await register(ctx.app);
    expect((await ctx.app.inject({ url: `/v1/playlists/${pl.id}`, headers: other.headers })).statusCode).toBe(
      404,
    );
    const itemId = reordered.json().items[0].id;
    const removed = await ctx.app.inject({
      method: "DELETE",
      url: `/v1/playlists/${pl.id}/items/${itemId}`,
      headers: u.headers,
    });
    expect(removed.json().items.map((i: { position: number }) => i.position)).toEqual([0, 1]);
    expect(
      (await ctx.app.inject({ method: "DELETE", url: `/v1/playlists/${pl.id}`, headers: u.headers }))
        .statusCode,
    ).toBe(204);
    expect((await ctx.app.inject({ url: `/v1/playlists/${pl.id}`, headers: u.headers })).statusCode).toBe(
      404,
    );
  });

  it("bookmarks and transcripts", async () => {
    const u = await register(ctx.app);
    const bm = await ctx.app.inject({
      method: "POST",
      url: `/v1/assets/${VOICE}/bookmarks`,
      headers: u.headers,
      payload: { positionMs: 18500, note: "Important reminder" },
    });
    expect(bm.statusCode).toBe(201);
    expect(bm.json().shareUrl).toContain("t=18");
    const ep = await ctx.app.inject({ url: `/v1/episodes/${VOICE}`, headers: u.headers });
    expect(ep.json().bookmarks[0].positionMs).toBe(18500);
    const tr = await ctx.app.inject({ url: `/v1/assets/${VOICE}/transcript` });
    expect(tr.json().segments.length).toBe(10);
    expect(tr.json().segments[3].text).toContain("Keep moving forward");
    const past = await ctx.app.inject({
      method: "POST",
      url: `/v1/assets/${VOICE}/bookmarks`,
      headers: u.headers,
      payload: { positionMs: 9_999_999 },
    });
    expect(past.statusCode).toBe(400);
  });

  it("motivation hub endpoints", async () => {
    const topics = await ctx.app.inject({ url: "/v1/motivation/topics" });
    expect(topics.json().items.map((t: { id: string }) => t.id)).toContain("resilience");
    const featured = await ctx.app.inject({ url: "/v1/motivation/featured?topic=resilience" });
    expect(featured.json().featured.id).toBe(VOICE);
    expect(featured.json().short[0].id).toBe(VOICE);
  });
});

describe("fusion studio (Scenarios C, D, F, G)", () => {
  it("C: generates a schema-valid plan using only available, mix-cleared assets", async () => {
    const u = await register(ctx.app);
    const res = await ctx.app.inject({
      method: "POST",
      url: "/v1/fusion/plan",
      headers: u.headers,
      payload: {
        prompt: "Make a 15-minute uplifting cinematic electronic mix with a short speech",
        targetDurationMs: 900000,
        mood: "uplifting",
        genres: ["cinematic", "electronic"],
        includeSpeech: true,
        speechTopic: "resilience",
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.validation.valid).toBe(true);
    expect(body.validation.rightsStatus).toBe("valid");
    expect(body.plan.durationMs).toBe(900000);
    expect(body.plan.layers.some((l: { role: string }) => l.role === "speech")).toBe(true);
    expect(body.plan.layers.every((l: { assetId: string }) => l.assetId !== STREAM_ONLY)).toBe(true);
    expect(body.plan.ducking.enabled).toBe(true);
    const check = await ctx.app.inject({
      method: "POST",
      url: "/v1/fusion/validate",
      headers: u.headers,
      payload: { plan: body.plan },
    });
    expect(check.json().valid).toBe(true);
  });

  it("D: rejects a streamable asset that is not licensed for mixing with an explanation", async () => {
    const u = await register(ctx.app);
    const plan = { ...validPlan, layers: [{ ...validPlan.layers[0], assetId: STREAM_ONLY }] };
    const res = await ctx.app.inject({
      method: "POST",
      url: "/v1/fusion/validate",
      headers: u.headers,
      payload: { plan },
    });
    const body = res.json();
    expect(body.valid).toBe(false);
    expect(body.errors[0].code).toBe("NOT_CLEARED_FOR_MIX");
    expect(body.errors[0].message).toContain("not cleared for remixing");
    const preview = await ctx.app.inject({
      method: "POST",
      url: "/v1/fusion/preview-authorize",
      headers: u.headers,
      payload: { plan },
    });
    expect(preview.statusCode).toBe(403);
  });

  it("validates every invalid fixture with the expected issue", async () => {
    const u = await register(ctx.app);
    for (const c of invalidCases) {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/v1/fusion/validate",
        headers: u.headers,
        payload: { plan: c.plan },
      });
      const codes = (res.json().errors as { code: string }[]).map((e) => e.code);
      expect(codes, `expected ${c.expect}`).toContain(c.expect);
    }
  });

  it("saves, reloads, edits with version check, and authorizes playback", async () => {
    const u = await register(ctx.app);
    const saved = await ctx.app.inject({
      method: "POST",
      url: "/v1/fusion/recipes",
      headers: u.headers,
      payload: { name: "My uplifting mix", prompt: "hopeful", plan: validPlan },
    });
    expect(saved.statusCode).toBe(201);
    const r = saved.json();
    expect(r.rightsValidationStatus).toBe("valid");
    const list = await ctx.app.inject({ url: "/v1/fusion/recipes", headers: u.headers });
    expect(list.json().items[0].id).toBe(r.id);
    const edited = await ctx.app.inject({
      method: "PATCH",
      url: `/v1/fusion/recipes/${r.id}`,
      headers: u.headers,
      payload: {
        version: r.version,
        plan: {
          ...validPlan,
          layers: validPlan.layers.map((l: { gainDb: number }) => ({ ...l, gainDb: l.gainDb - 1 })),
        },
      },
    });
    expect(edited.statusCode).toBe(200);
    expect(edited.json().mixPlan.layers[0].gainDb).toBe(-13);
    const stale = await ctx.app.inject({
      method: "PATCH",
      url: `/v1/fusion/recipes/${r.id}`,
      headers: u.headers,
      payload: { version: r.version, name: "x" },
    });
    expect(stale.statusCode).toBe(409);
    const play = await ctx.app.inject({
      method: "POST",
      url: `/v1/fusion/recipes/${r.id}/playback-authorize`,
      headers: u.headers,
      payload: {},
    });
    expect(play.statusCode).toBe(200);
    expect(Object.keys(play.json().media).sort()).toEqual([PAD, ARP, VOICE].sort());
    const other = await register(ctx.app);
    expect(
      (await ctx.app.inject({ url: `/v1/fusion/recipes/${r.id}`, headers: other.headers })).statusCode,
    ).toBe(404);
  });

  it("G: rights revoked after saving blocks the affected layer (or whole recipe by policy)", async () => {
    const u = await register(ctx.app);
    const r = (
      await ctx.app.inject({
        method: "POST",
        url: "/v1/fusion/recipes",
        headers: u.headers,
        payload: { name: "Revoke me", plan: validPlan },
      })
    ).json();
    const admin = await register(ctx.app, "admin@test.dev");
    const rights = await ctx.app.inject({ url: `/v1/admin/assets/${ARP}/rights`, headers: admin.headers });
    expect(rights.statusCode).toBe(200);
    const grantId = rights.json().grants[0].id;
    expect(rights.json().grants[0].proofReference).toBeTruthy();
    expect(
      (await ctx.app.inject({ url: `/v1/admin/assets/${ARP}/rights`, headers: u.headers })).statusCode,
    ).toBe(403);
    await ctx.app.inject({
      method: "POST",
      url: `/v1/admin/rights/${grantId}`,
      headers: admin.headers,
      payload: { status: "revoked", reason: "test takedown" },
    });
    const play = await ctx.app.inject({
      method: "POST",
      url: `/v1/fusion/recipes/${r.id}/playback-authorize`,
      headers: u.headers,
      payload: {},
    });
    expect(play.statusCode).toBe(200);
    expect(play.json().blockedLayers).toEqual([
      expect.objectContaining({ layerId: "layer-2", reason: "RIGHTS_REVOKED" }),
    ]);
    expect(play.json().plan.layers.map((l: { id: string }) => l.id)).toEqual(["layer-1", "layer-3"]);
    const strict = await ctx.app.inject({
      method: "POST",
      url: `/v1/fusion/recipes/${r.id}/playback-authorize`,
      headers: u.headers,
      payload: { policy: "block_recipe" },
    });
    expect(strict.statusCode).toBe(403);
    const reloaded = await ctx.app.inject({ url: `/v1/fusion/recipes/${r.id}`, headers: u.headers });
    expect(reloaded.json().rightsValidationStatus).toBe("invalid");
    // Standard streaming of the revoked asset is also blocked immediately.
    const stream = await ctx.app.inject({
      method: "POST",
      url: "/v1/playback/authorize",
      headers: u.headers,
      payload: { assetId: ARP },
    });
    expect(stream.statusCode).toBe(403);
    await ctx.app.inject({
      method: "POST",
      url: `/v1/admin/rights/${grantId}`,
      headers: admin.headers,
      payload: { status: "active" },
    });
    const audit = await ctx.app.inject({ url: "/v1/admin/audit", headers: admin.headers });
    expect(audit.json().items.map((i: { action: string }) => i.action)).toEqual(
      expect.arrayContaining(["grant_revoked", "grant_active"]),
    );
  });

  it("render export requires derivative rights; share links are rights-gated", async () => {
    const u = await register(ctx.app);
    const r = (
      await ctx.app.inject({
        method: "POST",
        url: "/v1/fusion/recipes",
        headers: u.headers,
        payload: { name: "Export", plan: validPlan },
      })
    ).json();
    const render = await ctx.app.inject({
      method: "POST",
      url: "/v1/fusion/render",
      headers: u.headers,
      payload: { recipeId: r.id },
    });
    expect(render.statusCode).toBe(202);
    expect(render.json().media).toHaveLength(3);
    const job = await ctx.app.inject({
      url: `/v1/fusion/render-jobs/${render.json().jobId}`,
      headers: u.headers,
    });
    expect(job.json().status).toBe("authorized");
    const done = await ctx.app.inject({
      method: "POST",
      url: `/v1/fusion/render-jobs/${render.json().jobId}/complete`,
      headers: u.headers,
      payload: { status: "completed" },
    });
    expect(done.json().status).toBe("completed");
    const share = await ctx.app.inject({
      method: "POST",
      url: `/v1/fusion/recipes/${r.id}/share`,
      headers: u.headers,
    });
    expect(share.statusCode).toBe(201);
    const pub = await ctx.app.inject({ url: `/v1/shared/recipes/${share.json().token}` });
    expect(pub.json().mixPlan.layers).toHaveLength(3);
    const sugg = await ctx.app.inject({ url: `/v1/fusion/suggestions?assetId=${PAD}`, headers: u.headers });
    expect(sugg.json().items.some((i: { asset: { id: string } }) => i.asset.id === ARP)).toBe(true);
    expect(
      (await ctx.app.inject({ method: "POST", url: "/v1/fusion/stems", headers: u.headers })).statusCode,
    ).toBe(501);
  });

  it("validates fusion requests", async () => {
    const u = await register(ctx.app);
    const res = await ctx.app.inject({
      method: "POST",
      url: "/v1/fusion/plan",
      headers: u.headers,
      payload: { prompt: "", targetDurationMs: 5 },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("Scenario F: AI provider unavailable", () => {
  it("falls back to the deterministic planner and reports status", async () => {
    const broken: MixPlanner = {
      name: "anthropic",
      available: () => true,
      plan: async () => {
        throw new Error("503 from provider");
      },
    };
    const f = await makeApp({ primary: broken });
    try {
      const u = await register(f.app);
      const status = await f.app.inject({ url: "/v1/fusion/status" });
      expect(status.json().manualEditorAvailable).toBe(true);
      const res = await f.app.inject({
        method: "POST",
        url: "/v1/fusion/plan",
        headers: u.headers,
        payload: { prompt: "calm piano", targetDurationMs: 60000 },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().provider).toBe("rules");
      // Manual editing + standard playback remain usable.
      expect(
        (
          await f.app.inject({
            method: "POST",
            url: "/v1/fusion/validate",
            headers: u.headers,
            payload: { plan: validPlan },
          })
        ).json().valid,
      ).toBe(true);
      expect(
        (
          await f.app.inject({
            method: "POST",
            url: "/v1/playback/authorize",
            headers: u.headers,
            payload: { assetId: PAD },
          })
        ).statusCode,
      ).toBe(200);
    } finally {
      await f.close();
    }
  });

  it("rejects malformed LLM output and repairs with the rule-based planner", async () => {
    const malformed: MixPlanner = {
      name: "anthropic",
      available: () => true,
      plan: async () =>
        ({
          version: 1,
          title: "x",
          durationMs: 60000,
          layers: [{ id: "l", assetId: "https://evil.example/a.mp3" }],
        }) as never,
    };
    const f = await makeApp({ primary: malformed });
    try {
      const u = await register(f.app);
      const res = await f.app.inject({
        method: "POST",
        url: "/v1/fusion/plan",
        headers: u.headers,
        payload: { prompt: "focus", targetDurationMs: 60000 },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().provider).toBe("rules");
      expect(res.json().warnings[0]).toContain("didn't pass validation");
      expect(JSON.stringify(res.json().plan)).not.toContain("evil.example");
    } finally {
      await f.close();
    }
  });
});

describe("privacy & admin", () => {
  it("exports and deletes account data", async () => {
    const u = await register(ctx.app);
    await ctx.app.inject({ method: "PUT", url: `/v1/library/likes/${PAD}`, headers: u.headers });
    await ctx.app.inject({
      method: "PUT",
      url: "/v1/me/preferences",
      headers: u.headers,
      payload: { genres: ["ambient"], moods: ["calm"] },
    });
    const exp = await ctx.app.inject({ url: "/v1/me/export", headers: u.headers });
    expect(exp.json().likes).toHaveLength(1);
    expect(exp.json().preferences.genres).toEqual(["ambient"]);
    const recs = await ctx.app.inject({ url: "/v1/home", headers: u.headers });
    expect(recs.json().shelves.some((s: { id: string }) => s.id === "for-you")).toBe(true);
    expect((await ctx.app.inject({ method: "DELETE", url: "/v1/me", headers: u.headers })).statusCode).toBe(
      204,
    );
    const likes = await ctx.deps.db.query(`SELECT 1 FROM likes WHERE user_id = $1`, [u.user.id]);
    expect(likes).toHaveLength(0);
    expect(
      (
        await ctx.app.inject({
          method: "POST",
          url: "/v1/auth/refresh",
          payload: { refreshToken: u.refreshToken },
        })
      ).statusCode,
    ).toBe(401);
  });

  it("takedown blocks new authorizations immediately", async () => {
    const admin = await register(ctx.app, "admin@test.dev".replace("admin", "admin")).catch(async () => {
      const l = await ctx.app.inject({
        method: "POST",
        url: "/v1/auth/login",
        payload: { email: "admin@test.dev", password: "correct horse battery" },
      });
      return { ...l.json(), headers: { authorization: `Bearer ${l.json().accessToken}` } };
    });
    const u = await register(ctx.app);
    const rain = syntheticAssetId("rain-texture");
    const td = await ctx.app.inject({
      method: "POST",
      url: `/v1/admin/assets/${rain}/takedown`,
      headers: admin.headers,
      payload: { reason: "rights holder request" },
    });
    expect(td.statusCode).toBe(200);
    expect(
      (
        await ctx.app.inject({
          method: "POST",
          url: "/v1/playback/authorize",
          headers: u.headers,
          payload: { assetId: rain },
        })
      ).statusCode,
    ).toBe(403);
    // Taken-down assets must disappear from collection tiles (artwork and counts), not just from item lists.
    const cols = (await ctx.app.inject({ url: "/v1/collections" })).json().items as {
      slug: string;
      itemCount: number;
    }[];
    const calm = (await ctx.app.inject({ url: "/v1/collections/calm-focus" })).json();
    expect(calm.items.some((a: { id: string }) => a.id === rain)).toBe(false);
    expect(cols.find((c) => c.slug === "calm-focus")?.itemCount).toBe(calm.items.length);
    const stats = await ctx.app.inject({ url: "/v1/admin/stats", headers: admin.headers });
    expect(stats.statusCode).toBe(200);
    const metrics = await ctx.app.inject({ url: "/metrics" });
    expect(metrics.body).toContain("http_requests_total");
  });
});
