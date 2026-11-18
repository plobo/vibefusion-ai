# Architecture

```
iOS (SwiftUI)                         Android (Compose)
 ├ StandardPlayer (AVPlayer)           ├ PlaybackService (Media3 ExoPlayer + MediaLibrarySession)
 ├ FusionPlaybackEngine (AVAudioEngine)├ FusionEngine (MediaCodec → FusionMixer → AudioTrack)
 └ VibeFusionKit: VFCore/VFAudio/VFDS  └ :core:model/:network/:database/:audio/:designsystem
           │  HTTPS + short-lived signed media URLs  │
           └──────────────┬──────────────────────────┘
                 Fastify modular monolith (backend/src/*)
   auth · catalogue · search · playback · library · playlists · podcasts/transcripts
   fusion (planner gateway → schema + semantic + rights validation) · rights · admin · ingestion
                          │
     PostgreSQL (PGlite in dev) · open-licence origins (Internet Archive, publisher RSS) · LLM provider (optional)
```

## Key decisions (see `docs/ADR/`)

1. **Modular monolith** backend in TypeScript/Fastify (ADR-001). Module per folder; no cross-module DB writes except via exported functions.
2. **Embedded PostgreSQL (PGlite)** for zero-setup dev/test; same SQL runs on real Postgres via `DATABASE_URL` (ADR-002).
3. **Local JWT auth behind a provider seam**, with optional Supabase token verification (ADR-003). Passwords: scrypt. Refresh tokens: rotated, stored hashed.
4. **Free/open content only**, rights recorded per asset at ingestion; every authorization re-evaluates rights and fails closed (ADR-004).
5. **AI plans, DSP renders** (ADR-005): the LLM returns JSON constrained to the mix-plan schema; Ajv + semantic + rights validation follow; invalid output falls back to a deterministic planner. Audio timing never depends on LLM latency.
6. **Shared envelope semantics** (ADR-006): `backend/src/fusion/envelope.ts` is the reference; Swift and Kotlin ports are tested against `contracts/fixtures/envelope-cases.json`.
7. **Two playback paths** (ADR-007): platform players for standard streaming; a separate fusion engine for synchronized layers. On Android the fusion engine is wrapped as a Media3 `SimpleBasePlayer` and swapped into the same MediaSession, so notifications/lock screen/headset/Android Auto work for both.
8. **Signed media URLs**: `/v1/media/<hmac-token>` re-checks rights on every fetch, then serves synthetic audio (Range supported) or redirects to the open-licence origin (or proxies with `MEDIA_DELIVERY=proxy`). Clients never persist URLs; Android resolves them lazily in a `ResolvingDataSource` and refreshes on 403/410.

## Design system

Tokens are mirrored on both platforms (`VFDesignSystem` / `:core:designsystem`): background `#090A10`, surface `#13151F`,
elevated `#1E212F`, primary `#7C6AFF`, secondary `#34D3C4`, accent `#FF8D57`, destructive `#FF5565`; spacing 4/8/12/16/24/32;
radii 6/12/20; artwork 48/148/280–300; minimum touch target 44–48. Components: buttons, search field, chips (with check
icon — never colour alone), artwork card, track/episode rows, mini-player, full player, queue sheet, transcript segment,
layer timeline bar, gain slider (dB with spoken value), empty/loading/error states.

## Module map

| Backend module | Responsibility |
|---|---|
| `auth/` | register/login/guest/refresh (rotation)/logout/upgrade, JWT verify hook, Supabase verifier |
| `me/` | profile, preferences, data export, account deletion |
| `catalogue/` | home shelves, catalogue paging, assets, creators, genres/moods, collections, motivation |
| `search/` | prefix full-text search (tsvector) + ILIKE, grouped results, filters |
| `rights/` | pure policy engine (territory, validity window, status, use), licence-URL mapping |
| `playback/` | authorize → signed URL, media endpoint, progress, history, privacy-filtered events |
| `library/`, `playlists/` | likes, follows, playlists with ETag/If-Match version checks, idempotent create |
| `podcasts/` | shows/episodes, transcripts (Podcasting 2.0 VTT/SRT), chapters JSON, bookmarks |
| `fusion/` | planner gateway (Anthropic adapter + rule-based), validator, recipes, preview/playback authorize, render jobs, sharing, tempo/key suggestions |
| `recommendations/` | rule-based scoring behind an interface |
| `admin/` | ingestion trigger, rights grants, revoke/takedown/restore, audit log, retention, dashboards |
| `ingestion/` | Internet Archive, LibriVox, podcast RSS, synthetic Sound Lab, curated collections |
| `observability/` | Prometheus metrics, allow-listed analytics events |
