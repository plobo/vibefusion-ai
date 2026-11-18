# Progress checklist

Legend: ✅ done and verified · 🟡 implemented, partially verified · ⏳ requires external setup or manual sign-off

## Phase 0 — Foundation
- ✅ Repository layout: `backend/`, `ios/`, `android/`, `contracts/`, `docs/` (+ADRs), `infrastructure/`, `.github/workflows/ci.yml`
- ✅ OpenAPI 3.1 + mix-plan / fusion-request JSON Schemas; `npm run contracts:validate` checks refs, schemas, fixtures and that all 80 routes are documented
- ✅ Shared fixtures: envelope cases, valid/invalid plans, synthetic catalogue (backend test fails if they drift)
- ✅ App shells, design tokens and 5-tab navigation on both platforms
- ✅ Lint/format/typecheck (backend: ESLint, Prettier, tsc — 0 errors)

## Phase 1 — Catalogue, auth, streaming
- ✅ Auth: register/login/guest/refresh rotation/logout/upgrade; Keychain (iOS) and Keystore AES-GCM (Android); single-flight token refresh on both clients
- ✅ Free/open ingestion, run live: **61 CC music tracks, 40 LibriVox public-domain speech chapters, 85 podcast episodes** (+8 synthetic Sound Lab assets)
- ✅ Home, Discover, debounced/cancellable Search with filters, collections, creators, asset detail with licence card
- ✅ Signed short-lived media URLs; rights rechecked on every fetch; Range support; expired → 410 → client re-authorizes and resumes at the same position
- ✅ iOS AVPlayer + lock screen/remote commands; **UI test verified playback of a real LibriVox stream**
- ✅ Android Media3 ExoPlayer in a `MediaLibraryService` (`ResolvingDataSource` resolves URLs lazily); **verified on emulator: media session PLAYING, 65 s buffered**
- ✅ Progress persistence and resume (server + offline outbox on both platforms)

## Phase 2 — Library, playlists, podcasts, motivation
- ✅ Likes (optimistic + rollback), playlists (idempotent create, If-Match versions, reorder, server-authoritative ordering), follows, history
- ✅ Podcast shows/episodes, speech player with speed control, skip ±15/30 s, sleep timer, chapters, transcripts (Podcasting 2.0 VTT/SRT), bookmarks + shareable `vibefusion://listen/<id>?t=` links
- ✅ Motivation hub (topics, daily featured speech, short/long, speakers)
- ✅ Licence-gated downloads (control hidden when not permitted; server re-checks)

## Phase 3 — AI planning and manual editor
- ✅ Provider-neutral `PlannerGateway`: Anthropic adapter (`claude-opus-5-5`, JSON-schema structured output) + deterministic rule-based planner; timeout, retry, quota, rate limit
- ✅ Schema + semantic + rights validation with actionable messages; malformed LLM output is repaired via the rule-based planner (tested)
- ✅ Editor on both platforms: timeline, gain/mute/solo/fades/offset/length/loop/pan/role, ducking, live server validation, save/reload with version checks
- ✅ Scenario C (valid plan from prompt), D (stream-only asset rejected with explanation), F (AI outage → manual + playback still work) — backend tests

## Phase 4 — FusionPlaybackEngine
- ✅ Envelope maths identical on TS / Swift / Kotlin (fixture parity tests on all three)
- ✅ iOS AVAudioEngine engine: synchronized start, segment scheduling with loops, 50 Hz automation, peak limiter, interruption/route/config-change/media-reset recovery. **UI test: generated 4-layer plan previewed**; offline render test verifies loop continuity
- ✅ Android MediaCodec → `FusionMixer` → AudioTrack engine with audio focus/noisy handling, exposed through the MediaSession. JVM tests verify timing, loop continuity, **−12 dB ducking measured**, limiter bound, mute. **Emulator: generated 4-layer plan (3 CC music + LibriVox speech) previewed; MediaSession PLAYING; pause from UI and resume from a hardware media key kept position**
- ⏳ 30-minute drift / 60-minute memory checks on physical devices (manual matrix in `docs/TEST_PLAN.md`)

## Phase 5 — Personalization & hardening
- ✅ Preferences (genres/moods/topics/explicit/analytics/AI consent) drive "Made for your mood" (verified on Android Home)
- ✅ Admin: ingestion, grants, revoke/takedown/restore, audit log, retention job, stats; Scenario G tested (revoked layer blocked; `block_recipe` policy)
- ✅ Metrics endpoint + alert rules; pseudonymous, allow-listed analytics with opt-out; data export and account deletion
- ✅ Accessibility labels/values on controls, timeline and sliders; chips use icons not colour alone; Dynamic Type/font scaling; reduced motion respected on iOS; English + French strings
- ⏳ Store submission (signing, privacy labels, screenshots), legal/privacy review (PIPEDA, Québec Law 25), source-terms review

## Phase 6 — Advanced (post-MVP)
- ✅ Beat-grid snapping (`snapToBeat`), tempo/key (Camelot) suggestions from measured metadata
- ✅ Offline render/export on device (AAC on iOS, WAV on Android) gated on `derivative_render`, attribution written beside the file
- ✅ Recipe-only social sharing (rights-gated, revocable)
- ✅ Android Auto browse tree via `MediaLibraryService`
- ⏳ Stem separation (endpoint returns 501: no catalogue licence permits it), CarPlay (needs Apple entitlement), wearables

## Last verification run
| Check | Result |
|---|---|
| Backend `npm test` | 55/55 passed |
| `npm run contracts:validate` | passed (80 routes, 112 refs) |
| ESLint / tsc | 0 errors (2 `any` warnings in the contract script) |
| iOS package tests | 15/15 passed |
| iOS UI tests vs live backend | 2/2 passed (guest → play LibriVox speech; Studio → plan → 4-layer preview) |
| Android `:core:model` / `:core:network` | 9/9 and 5/5 passed |
| Android `assembleDebug` | succeeded; API 36 emulator: guest onboarding → personalised Home → LibriVox stream PLAYING → AI Studio plan → fusion preview PLAYING → pause/resume via media key |

## Known limitations
- The rule-based planner reads duration, mood, genres and topic from the form, not from free text; set `ANTHROPIC_API_KEY` for prompt understanding.
- Fusion preview downloads each layer completely before playing (resumable with Range on Android after an interrupted 36 MB transfer was found in testing); large originals take a while. LibriVox now ingests 64 kbps files; progressive layer loading is the next optimization.
- iOS gain automation is 50 Hz control-rate; Android layer starts are block-quantised (~21 ms).
- Podcast transcripts appear only when publishers provide Podcasting 2.0 transcripts; the synthetic "Voice Guide" fixture always has one.
- Android feature screens live in `:app` packages rather than separate `:feature:*` Gradle modules (ADR-008).
