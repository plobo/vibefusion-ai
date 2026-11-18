# Test plan

## Automated (run in CI)
| Suite | Command | Covers |
|---|---|---|
| Backend unit + integration (55) | `cd backend && npm test` | rights policy (territory/date/use/status), licence mapping, envelope math + fixture sync, auth (rotation, expiry, guest upgrade), catalogue/search, signed URLs (Range, expiry 410, tamper), progress/resume, analytics filtering, likes, playlists (idempotency, version conflict, reorder, ownership), bookmarks/transcripts, Scenarios C/D/F/G, render & share gating, account export/deletion, takedown, ingestion parsers & licence gating |
| Contracts | `npm run contracts:validate` | OpenAPI refs, schema compile, fixtures, route coverage |
| iOS VibeFusionKit (15) | `xcodebuild test -scheme VibeFusionKit-Package` | envelope parity with fixtures, scheduler (loops/seek/run-out), API client (error envelope, single-flight refresh, offline), optimistic like rollback, queue/shuffle/repeat, audio-session policy, **real offline AVAudioEngine render** (loop continuity) |
| iOS UI (2) | `xcodebuild test -scheme VibeFusion -only-testing:VibeFusionUITests` with `TEST_RUNNER_VF_TEST_SERVER` | guest onboarding → all tabs → play speech (mini-player); AI Studio example → plan → multi-layer preview. Skips without a backend. |
| Android `:core:model` (9) | `./gradlew :core:model:test` | envelope parity with fixtures, scheduler, queue, audio policies, **FusionMixer** timing/loop/ducking(−12 dB measured)/limiter bound/mute |
| Android `:core:network` (5) | `./gradlew :core:network:testDebugUnitTest` | error envelope, 401 refresh + retry, failed refresh → expiry, home shelf decoding, offline mapping |

## Manual device matrix (release sign-off)
* iOS current + previous major; small (SE) and large (Pro Max) iPhones. Android current + previous API; Pixel + Samsung + low-memory device.
* Networks: Wi-Fi, throttled (Network Link Conditioner / emulator), intermittent, offline (downloads + cached library).
* Audio: lock screen + headset/Bluetooth buttons (Scenario H), incoming call interruption, headphone unplug, Bluetooth disconnect,
  30-minute fusion session drift check, 60-minute memory check, CarPlay N/A (entitlement), Android Auto browse.
* Accessibility: VoiceOver/TalkBack traversal, Dynamic Type/font scale 200 %, contrast, reduced motion.

## Release targets
Crash-free sessions ≥ 99.5 %; stream start p95 ≤ 3 s (reported via `stream_start_latency`); no unbounded memory in 60-min mixes;
desync below one block (≤ 21 ms Android, sample-accurate start on iOS) over 30 min; rights checks fail closed (tested).
