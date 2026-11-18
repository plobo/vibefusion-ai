# VibeFusion AI --- Cross-Platform Implementation Plan

**Product:** VibeFusion AI\
**Platforms:** iOS (SwiftUI) and Android (Kotlin + Jetpack Compose)\
**Product focus:** Music streaming, podcasts and motivational speeches,
AI-assisted genre fusion, and speech-over-music sessions\
**Initial content strategy:** Royalty-free, original, public-domain
where applicable, or explicitly licensed audio\
**Document purpose:** Claude Code implementation blueprint

------------------------------------------------------------------------

## 1. Product vision

VibeFusion AI is a mobile audio platform that lets people discover and
stream music, listen to podcasts and motivational speeches, save
content, and create personalized listening sessions with AI.

Its main differentiator is **AI Fusion Studio**: a user describes a
desired listening experience, selects permitted source tracks or audio
stems, and receives a structured mix plan. The audio engine executes
that plan using synchronized playback, gain automation, fades, and
transitions.

Example prompt:

> Create a 20-minute uplifting session that begins with calm piano,
> gradually introduces cinematic strings and electronic percussion, and
> includes a motivational speech near the middle.

The AI does not magically remix arbitrary copyrighted recordings. The
initial product uses cleared audio assets, supplied stems, loops, or
separately licensed tracks. Full commercial-song remixing requires
explicit rights for the relevant recordings, compositions, stems,
derivative works, and distribution.

### Product principles

1.  **Audio-first:** playback reliability, low latency, background
    playback, and interruption handling are foundational.
2.  **Rights-aware:** every playable asset has a rights record and
    permitted-use policy.
3.  **AI assists; deterministic DSP renders:** an LLM produces a
    validated mix specification; native DSP/audio code performs timing
    and mixing.
4.  **Cross-platform consistency:** shared API contracts and product
    behavior, native UI and audio implementations.
5.  **User control:** users can preview, edit, save, regenerate, and
    delete AI-generated sessions.
6.  **Privacy by default:** do not upload personal audio or voice
    recordings unless a feature requires it and the user consents.

------------------------------------------------------------------------

## 2. Goals, non-goals, and MVP boundaries

### MVP goals

-   Account creation, sign-in, and guest browsing where appropriate.
-   Browse and search a curated catalogue of cleared music, podcasts,
    and speeches.
-   Stream audio with background playback, lock-screen controls, queue
    management, and resume position.
-   Save favourites, playlists, and listening history.
-   Play speech episodes with transcript, bookmarks, and playback-speed
    control.
-   Create a simple multi-layer fusion session from cleared instrumental
    tracks, loops, and speech.
-   Use an LLM to convert a natural-language prompt into a structured,
    editable mix plan.
-   Mix at least two music layers and one optional speech layer with
    volume automation and fades.
-   Save a mix recipe and replay it; export a rendered mix only when the
    rights for every component permit it.
-   Provide analytics and crash/error observability without collecting
    unnecessary personal data.

### Explicit non-goals for the first release

-   A Spotify-scale commercial music catalogue.
-   Unlicensed access to Spotify, Apple Music, YouTube, or other
    services' protected streams.
-   Arbitrary remixing of commercial master recordings.
-   Full professional DAW functionality, live DJ hardware integration,
    or user-uploaded public distribution.
-   Guaranteed beat matching for every track.
-   Voice cloning of public figures or real people without explicit
    authorization.
-   Automatic public sharing of generated mixes before rights checks.

### MVP success measures

-   A new user can find and play cleared audio in under three taps.
-   Playback survives screen lock and app backgrounding on supported
    devices.
-   A user can create, edit, save, and replay a two-layer mix.
-   The AI returns a schema-valid mix plan or a clear recoverable error.
-   Every asset used in a session passes rights-policy validation.
-   Crash-free playback sessions and stream-start latency meet agreed
    release targets.

------------------------------------------------------------------------

## 3. Recommended technical architecture

### 3.1 Overall architecture

Use two native applications backed by one shared service platform.

``` text
┌──────────────────────────┐       ┌──────────────────────────┐
│ iOS App                  │       │ Android App              │
│ SwiftUI                  │       │ Kotlin + Compose         │
│ MVVM / feature modules   │       │ MVVM / feature modules   │
│ AVPlayer + AVAudioEngine │       │ Media3 + audio engine    │
└────────────┬─────────────┘       └────────────┬─────────────┘
             │ HTTPS / signed media URLs        │
             └────────────────┬─────────────────┘
                              │
                    ┌─────────▼──────────┐
                    │ API / BFF Layer    │
                    │ Auth, catalogue,   │
                    │ playback, library, │
                    │ mixes, entitlements│
                    └─────────┬──────────┘
                              │
       ┌──────────────────────┼────────────────────────┐
       │                      │                        │
┌──────▼────────┐    ┌────────▼────────┐      ┌────────▼────────┐
│ PostgreSQL    │    │ Object Storage  │      │ AI Orchestrator │
│ metadata,     │    │ audio, artwork, │      │ prompt -> JSON  │
│ users, rights │    │ transcripts     │      │ schema validate │
└───────────────┘    └────────┬────────┘      └────────┬────────┘
                              │                        │
                       ┌──────▼────────┐       ┌───────▼────────┐
                       │ CDN / HLS     │       │ LLM Provider   │
                       │ signed access │       │ swappable      │
                       └───────────────┘       └────────────────┘
```

### 3.2 Suggested stack

  ---------------------------------------------------------------------------------
  Layer             iOS                 Android                 Shared service
  ----------------- ------------------- ----------------------- -------------------
  UI                SwiftUI             Jetpack Compose         ---

  Architecture      MVVM, feature       MVVM, feature modules,  API contracts
                    modules,            Coroutines/Flow         
                    async/await                                 

  Dependency        Swift native        Hilt                    ---
  injection         composition or a DI                         
                    library                                     

  Standard playback AVPlayer            Media3 ExoPlayer        HLS or progressive
                                                                audio

  Layered mixing    AVAudioEngine /     Media3 for standard     Mix recipes
                    AVAudioPlayerNode   playback; custom        
                                        AudioTrack/Oboe-based   
                                        engine or a vetted DSP  
                                        library for             
                                        synchronized            
                                        multi-layer mixing      

  Persistence       SwiftData or Core   Room                    PostgreSQL
                    Data                                        

  Networking        URLSession          Retrofit/Ktor           REST initially

  Auth              Secure token        Android Keystore-backed Firebase Auth or
                    storage in Keychain secure storage          Supabase Auth

  Backend           ---                 ---                     TypeScript/NestJS
                                                                or Kotlin/Ktor

  Database          ---                 ---                     PostgreSQL

  Object storage    ---                 ---                     S3-compatible
                                                                storage or Supabase
                                                                Storage

  CDN               ---                 ---                     CDN in front of
                                                                private object
                                                                storage

  AI                ---                 ---                     Provider-agnostic
                                                                LLM gateway

  Observability     OSLog / crash       Logcat / crash          Structured logs,
                    reporting           reporting               metrics, traces
  ---------------------------------------------------------------------------------

**Recommendation:** use a modular monolith for the first backend
release, not microservices. Keep clear module boundaries so high-load
components can be separated later.

**Important audio architecture decision:** do not force one player
abstraction to do every job. Use the platform's standard media player
for ordinary streaming. Build a separate `FusionPlaybackEngine` for
synchronized layers and automation. The engine may use platform-specific
audio APIs, but it must consume the same platform-neutral mix recipe.

### 3.3 Repository layout

``` text
vibefusion/
  README.md
  docs/
    PRODUCT_REQUIREMENTS.md
    ARCHITECTURE.md
    API_CONTRACTS.md
    DATA_MODEL.md
    AUDIO_ENGINE.md
    RIGHTS_AND_CONTENT_POLICY.md
    TEST_PLAN.md
    ADR/
  contracts/
    openapi.yaml
    schemas/
      mix-plan.schema.json
  backend/
    src/
      auth/
      catalogue/
      search/
      playback/
      library/
      playlists/
      podcasts/
      transcripts/
      fusion/
      rights/
      recommendations/
      admin/
    migrations/
    test/
  ios/
    VibeFusion.xcodeproj
    App/
    Core/
      Networking/
      Persistence/
      DesignSystem/
      Audio/
      Authentication/
    Features/
      Home/
      Discover/
      Search/
      Player/
      Library/
      Podcasts/
      Motivation/
      FusionStudio/
      Profile/
    Tests/
  android/
    settings.gradle.kts
    app/
    core/
      network/
      database/
      datastore/
      design-system/
      audio/
      auth/
    feature/
      home/
      discover/
      search/
      player/
      library/
      podcasts/
      motivation/
      fusion/
      profile/
    build-logic/
    test/
  infrastructure/
    docker/
    ci/
    deployment/
```

------------------------------------------------------------------------

## 4. User journeys and navigation

### 4.1 Primary navigation

Use five bottom-navigation destinations:

1.  **Home** --- personalized shelves, recently played, daily
    motivation, continue listening.
2.  **Discover** --- genres, moods, curated collections, podcasts,
    speeches, search.
3.  **AI Studio** --- prompt-based session creation, layer editor,
    preview, save.
4.  **Podcasts** --- podcast shows, episodes, transcripts, bookmarks,
    subscriptions/follows.
5.  **Library** --- liked tracks, saved episodes, playlists, mixes,
    downloads.

A persistent mini-player appears above the bottom navigation whenever
audio is loaded. Tapping it opens the full player.

### 4.2 Screen inventory

#### Onboarding and account

-   Welcome / value proposition
-   Sign in / create account
-   Interest selection: genres, moods, speech topics
-   Notification permission explanation and opt-in
-   Terms, privacy, and content availability notice

#### Home

-   Greeting and search entry point
-   Continue listening
-   Made for your mood
-   Daily motivation
-   Popular genres
-   Recommended podcasts
-   Recently created AI mixes

#### Discover and search

-   Genre grid
-   Mood grid
-   Curated playlists
-   New and featured audio
-   Search results grouped by tracks, albums, artists, shows, episodes,
    and speeches
-   Filters: duration, genre, mood, spoken/music, language

#### Full player

-   Artwork and title/creator
-   Play/pause, previous/next, seek
-   Queue
-   Shuffle/repeat
-   Playback speed for speech and podcast content
-   Like/save
-   Sleep timer
-   Output route where supported
-   Transcript / chapters when available
-   Audio quality selector where supported
-   Background playback and system media controls

#### Motivation hub

-   Topic categories: discipline, confidence, career, resilience,
    leadership, fitness, mindfulness
-   Daily featured speech
-   Short inspiration sessions
-   Long-form episodes
-   Speaker/creator pages
-   Transcript, chapter markers, bookmarks, and shareable timestamp
    links

#### AI Studio

-   Prompt input with example prompts
-   Session duration
-   Mood / energy curve
-   Genre and instrument choices
-   Speech toggle and speech topic
-   Voice selection only for licensed or authorized voices
-   Source asset selection
-   Generated mix-plan preview
-   Layer timeline
-   Per-layer gain and mute controls
-   Fade/transition controls
-   Preview and regenerate
-   Save recipe
-   Render/export only if rights permit

#### Library

-   Liked music
-   Saved speeches and episodes
-   User playlists
-   Saved AI mix recipes
-   Downloads
-   Listening history
-   Recently played

#### Profile and settings

-   Account and subscription state
-   Audio quality and data saver
-   Download settings
-   Explicit content controls
-   Privacy controls and data deletion
-   AI provider/data-processing disclosure
-   Help, feedback, licenses, terms

### 4.3 Accessibility and localization

-   Dynamic Type / font scaling, screen-reader labels, keyboard
    navigation, adequate contrast.
-   Do not communicate playback state using colour alone.
-   Provide accessible labels for waveform/timeline controls.
-   Support localization from day one; begin with English and design for
    French and other languages.
-   Respect system reduced-motion settings.

------------------------------------------------------------------------

## 5. Functional requirements

### 5.1 Catalogue and streaming

-   Browse paginated catalogue endpoints.
-   Search with debouncing and cancellation.
-   Display metadata and rights-aware availability.
-   Request a short-lived playback URL from the backend.
-   Support HLS where adaptive streaming is needed; progressive audio
    can be used for simpler assets.
-   Resume from last known position.
-   Handle expired URLs by refreshing playback authorization.
-   Handle network loss, retry with backoff, and surface useful errors.
-   Track stream start, completion, and playback progress subject to
    privacy policy.

### 5.2 Library and playlists

-   Like/unlike content.
-   Create, rename, reorder, and delete playlists.
-   Add/remove tracks and episodes.
-   Save mix recipes separately from rendered audio files.
-   Sync library changes across devices.
-   Resolve concurrent playlist edits using server-authoritative
    ordering or version checks.

### 5.3 Podcasts and motivational content

-   Show/episode relationships.
-   Episode descriptions, duration, release date, creator, artwork.
-   Optional transcripts and chapters.
-   Bookmarks at a playback timestamp.
-   Playback speed and silence trimming only if implemented safely and
    predictably.
-   Resume position per episode.
-   Follow a show or creator.

### 5.4 AI Fusion Studio

-   Prompt-to-mix-plan generation.
-   Schema validation and rights validation.
-   Editable layer timeline.
-   Preview using source audio that is cleared for mixing.
-   Layer gain, fade-in/out, mute/solo, start offset, and duration.
-   Save a recipe and replay it.
-   Render offline where technically supported and permitted by rights.
-   Explain when a requested genre or combination cannot be fulfilled
    with available assets.

------------------------------------------------------------------------

## 6. Data model

Use UUID identifiers, UTC timestamps, soft deletion where appropriate,
and explicit ownership. Keep catalogue metadata separate from storage
locations and rights records.

### 6.1 Core entities

#### User

``` json
{
  "id": "uuid",
  "email": "string",
  "displayName": "string",
  "avatarUrl": "string|null",
  "locale": "en-CA",
  "createdAt": "ISO-8601",
  "updatedAt": "ISO-8601"
}
```

#### AudioAsset

``` json
{
  "id": "uuid",
  "title": "string",
  "subtitle": "string|null",
  "assetType": "music|speech|podcast_episode|loop|stem|sound_effect",
  "creatorId": "uuid|null",
  "albumId": "uuid|null",
  "showId": "uuid|null",
  "durationMs": 180000,
  "artworkUrl": "string|null",
  "streamingFormat": "hls|progressive|local",
  "streamingManifestKey": "string",
  "language": "en",
  "genres": ["cinematic", "ambient"],
  "moods": ["uplifting", "calm"],
  "tempoBpm": 110,
  "key": "Am",
  "isExplicit": false,
  "isActive": true,
  "createdAt": "ISO-8601"
}
```

#### Creator

``` json
{
  "id": "uuid",
  "name": "string",
  "creatorType": "artist|speaker|podcaster|label",
  "bio": "string|null",
  "imageUrl": "string|null",
  "websiteUrl": "string|null"
}
```

#### RightsGrant

``` json
{
  "id": "uuid",
  "assetId": "uuid",
  "rightsHolder": "string",
  "licenseType": "owned|royalty_free|direct_license|public_domain_verified",
  "territories": ["CA", "US"],
  "validFrom": "ISO-8601",
  "validUntil": "ISO-8601|null",
  "allowedUses": ["stream", "offline_download", "mix", "derivative_render"],
  "attributionRequired": true,
  "attributionText": "string|null",
  "proofReference": "private-document-reference",
  "status": "active|expired|revoked|under_review"
}
```

#### Playlist

``` json
{
  "id": "uuid",
  "ownerId": "uuid",
  "name": "string",
  "description": "string|null",
  "artworkUrl": "string|null",
  "visibility": "private|unlisted|public",
  "version": 1,
  "createdAt": "ISO-8601",
  "updatedAt": "ISO-8601"
}
```

#### PlaylistItem

``` json
{
  "id": "uuid",
  "playlistId": "uuid",
  "assetId": "uuid",
  "position": 0,
  "addedAt": "ISO-8601"
}
```

#### PlaybackProgress

``` json
{
  "id": "uuid",
  "userId": "uuid",
  "assetId": "uuid",
  "positionMs": 45000,
  "completed": false,
  "updatedAt": "ISO-8601"
}
```

#### MixRecipe

``` json
{
  "id": "uuid",
  "ownerId": "uuid",
  "name": "My uplifting mix",
  "prompt": "Create a hopeful cinematic session",
  "durationMs": 900000,
  "mixPlanVersion": 1,
  "mixPlan": {},
  "rightsValidationStatus": "valid|invalid|needs_review",
  "createdAt": "ISO-8601",
  "updatedAt": "ISO-8601"
}
```

#### MixLayer

A layer is stored inside the versioned mix-plan JSON and may also be
normalized into a table for analytics/querying:

``` json
{
  "id": "uuid",
  "assetId": "uuid",
  "role": "music|speech|ambience|percussion|effect",
  "startMs": 0,
  "sourceInMs": 0,
  "durationMs": 60000,
  "gainDb": -9.0,
  "fadeInMs": 3000,
  "fadeOutMs": 5000,
  "loop": false,
  "pan": 0.0
}
```

#### TranscriptSegment

``` json
{
  "id": "uuid",
  "assetId": "uuid",
  "startMs": 12000,
  "endMs": 18500,
  "text": "Keep moving forward.",
  "speaker": "Speaker"
}
```

#### Bookmark

``` json
{
  "id": "uuid",
  "userId": "uuid",
  "assetId": "uuid",
  "positionMs": 18500,
  "note": "Important reminder",
  "createdAt": "ISO-8601"
}
```

### 6.2 Database constraints and indexes

-   Unique `(user_id, asset_id)` for likes.
-   Unique `(playlist_id, position)` or use a stable ordering token.
-   Index catalogue by active status, asset type, language, genre, mood,
    and creator.
-   Full-text search on title, creator, description, transcript where
    permitted.
-   Index playback progress by `(user_id, updated_at)`.
-   Index rights grants by asset, status, territory, and validity
    window.
-   Validate that every mix layer references an active asset and a
    currently valid rights grant.
-   Do not expose private storage keys or proof-of-license documents to
    clients.

------------------------------------------------------------------------

## 7. AI mixing engine design

### 7.1 Architecture

The AI engine must be a planning system, not the real-time audio
renderer.

``` text
User prompt + UI selections
          |
          v
Prompt normalizer
          |
          v
LLM structured-output request
          |
          v
JSON schema validation
          |
          v
Catalogue asset retrieval
          |
          v
Rights and entitlement validation
          |
          v
Mix-plan compiler
          |
          v
Platform FusionPlaybackEngine
          |
          v
Live preview / permitted offline render
```

### 7.2 AI input contract

``` json
{
  "prompt": "Make a 15-minute uplifting cinematic mix with a short speech",
  "targetDurationMs": 900000,
  "mood": "uplifting",
  "energyCurve": "gradual_build",
  "genres": ["cinematic", "electronic", "classical"],
  "includeSpeech": true,
  "speechTopic": "resilience",
  "speechLanguage": "en",
  "availableAssetIds": ["uuid-1", "uuid-2", "uuid-3"],
  "constraints": {
    "maxLayers": 4,
    "allowLoops": true,
    "allowStemMixing": true,
    "allowRenderedExport": false
  }
}
```

### 7.3 Mix-plan output contract

The LLM must return structured JSON only. Validate it against a
versioned JSON Schema before use.

``` json
{
  "version": 1,
  "title": "Rise with Purpose",
  "description": "A gradual, uplifting cinematic session",
  "durationMs": 900000,
  "tempoBpm": 110,
  "layers": [
    {
      "id": "layer-1",
      "assetId": "uuid-1",
      "role": "music",
      "startMs": 0,
      "sourceInMs": 0,
      "durationMs": 900000,
      "gainDb": -12,
      "fadeInMs": 5000,
      "fadeOutMs": 8000,
      "loop": true,
      "pan": 0
    },
    {
      "id": "layer-2",
      "assetId": "uuid-2",
      "role": "music",
      "startMs": 120000,
      "sourceInMs": 0,
      "durationMs": 600000,
      "gainDb": -8,
      "fadeInMs": 10000,
      "fadeOutMs": 12000,
      "loop": false,
      "pan": 0
    },
    {
      "id": "layer-3",
      "assetId": "uuid-3",
      "role": "speech",
      "startMs": 300000,
      "sourceInMs": 0,
      "durationMs": 120000,
      "gainDb": 0,
      "fadeInMs": 1500,
      "fadeOutMs": 2500,
      "loop": false,
      "pan": 0
    }
  ],
  "transitions": [
    {
      "fromLayerId": "layer-1",
      "toLayerId": "layer-2",
      "startMs": 120000,
      "durationMs": 10000,
      "curve": "equal_power"
    }
  ],
  "warnings": []
}
```

The example is illustrative. The production schema must also define
numeric bounds, supported enum values, unique layer IDs, maximum
duration, and cross-field rules.

### 7.4 Validation rules

Reject or repair plans that: - Reference assets not returned by the
catalogue service. - Reference assets that are inactive, unavailable in
the user's territory, or not licensed for mixing. - Use more layers than
the product limit. - Contain negative timestamps, invalid durations, or
out-of-range gain/pan values. - Place a layer beyond the target session
duration without explicit truncation. - Exceed the asset's available
source duration unless looping is permitted. - Contain unsupported
effects or transition curves. - Attempt to export a mix when any asset
lacks derivative/export rights.

The client must never trust an LLM-supplied asset URL. The backend
resolves asset IDs and issues authorized playback access only after
validation.

### 7.5 DSP and playback behavior

MVP DSP: - Synchronized multi-layer playback. - Per-layer gain. -
Fade-in and fade-out envelopes. - Start offsets and source trim. -
Looping for permitted loops. - Crossfade between sequential tracks. -
Speech ducking: lower background music while speech is active. - Peak
protection / conservative headroom. - Pause, resume, seek, and stop
across all active layers.

Suggested initial defaults: - Master headroom: leave conservative peak
margin; do not assume simple gain addition is safe. - Speech ducking:
reduce music by a configurable amount, initially around 6--12 dB, then
user-test. - Crossfade: default 5--8 seconds for compatible tracks;
allow the plan to choose a value within validated limits. - Avoid
claiming tempo/key matching unless measured metadata and DSP actually
support it.

Advanced later: - Beat-grid detection and tempo alignment. - Key
compatibility suggestions. - Loudness normalization. - Stem separation
for assets whose rights permit it. - Offline render/export with embedded
attribution/metadata. - More sophisticated transitions and effect
automation.

### 7.6 Platform audio implementation

**iOS** - Use AVPlayer for standard HLS/progressive streaming. - Use
AVAudioEngine with AVAudioPlayerNode and mixer nodes for synchronized
local/stream-buffer layer playback and gain automation. - Configure
AVAudioSession for playback and background audio capability. - Handle
audio interruptions, route changes, Bluetooth/headphone disconnects,
media-services reset, and engine rebuilds. - Evaluate
AVComposition/AVMutableAudioMix for offline composition/export workflows
where appropriate. - Keep real-time render callbacks free of blocking
I/O, allocations, network requests, and unpredictable work.

**Android** - Use Media3 ExoPlayer and MediaSessionService for standard
streaming, queues, notifications, and background playback. - Use a
dedicated synchronized mixing implementation for simultaneous layers.
Evaluate Android AudioTrack or a vetted native DSP engine (e.g. Oboe)
rather than assuming ExoPlayer alone is a multitrack mixer. - Handle
audio focus, noisy-route events, foreground service lifecycle, Bluetooth
changes, and device-specific audio behavior. - Release players,
sessions, buffers, and native resources deterministically.

**Cross-platform rule:** identical mix-plan semantics and test fixtures;
platform-specific rendering is acceptable, but audible timing, layer
gain intent, fades, and seek behavior should be as consistent as
practical.

------------------------------------------------------------------------

## 8. Backend APIs

Use REST/JSON initially. Publish an OpenAPI specification and generate
or maintain typed clients. All endpoints require authentication except
public catalogue discovery explicitly designed for guest access.

### 8.1 Authentication

-   `POST /v1/auth/register`
-   `POST /v1/auth/login`
-   `POST /v1/auth/refresh`
-   `POST /v1/auth/logout`
-   `GET /v1/me`
-   `DELETE /v1/me`

Prefer managed authentication (Firebase Auth or Supabase Auth) rather
than implementing password storage from scratch. Backend must verify
provider tokens.

### 8.2 Catalogue and discovery

-   `GET /v1/home`
-   `GET /v1/catalogue?type=music&genre=cinematic&cursor=...`
-   `GET /v1/assets/{assetId}`
-   `GET /v1/creators/{creatorId}`
-   `GET /v1/genres`
-   `GET /v1/moods`
-   `GET /v1/search?q=...&types=music,episode,speech`
-   `GET /v1/collections/{collectionId}`

### 8.3 Playback

-   `POST /v1/playback/authorize`
    -   Input: asset ID, playback context, requested quality.
    -   Output: short-lived signed URL/manifest, expiry, MIME/format,
        allowed playback capabilities.
-   `POST /v1/playback/progress`
-   `GET /v1/playback/recent`
-   `POST /v1/playback/events` (batch, rate-limited, privacy-filtered)

Do not expose permanent object-storage URLs. Signed URLs should be
short-lived and scoped.

### 8.4 Library and playlists

-   `GET /v1/library`
-   `GET /v1/library/likes`
-   `PUT /v1/library/likes/{assetId}`
-   `DELETE /v1/library/likes/{assetId}`
-   `GET /v1/playlists`
-   `POST /v1/playlists`
-   `GET /v1/playlists/{playlistId}`
-   `PATCH /v1/playlists/{playlistId}`
-   `DELETE /v1/playlists/{playlistId}`
-   `POST /v1/playlists/{playlistId}/items`
-   `PATCH /v1/playlists/{playlistId}/items/reorder`
-   `DELETE /v1/playlists/{playlistId}/items/{itemId}`

Use version/ETag checks to avoid silently overwriting concurrent edits.

### 8.5 Podcasts and motivation

-   `GET /v1/podcasts`
-   `GET /v1/podcasts/{showId}`
-   `GET /v1/podcasts/{showId}/episodes`
-   `GET /v1/episodes/{episodeId}`
-   `GET /v1/assets/{assetId}/transcript`
-   `POST /v1/assets/{assetId}/bookmarks`
-   `GET /v1/motivation/featured`
-   `GET /v1/motivation/topics`

### 8.6 AI Fusion

-   `POST /v1/fusion/plan`
    -   Input: prompt, duration, mood, genres, speech settings,
        constraints.
    -   Output: validated mix plan, warnings, selected asset metadata.
-   `POST /v1/fusion/validate`
    -   Input: mix plan.
    -   Output: schema result, rights result, availability warnings.
-   `POST /v1/fusion/recipes`
-   `GET /v1/fusion/recipes`
-   `GET /v1/fusion/recipes/{recipeId}`
-   `PATCH /v1/fusion/recipes/{recipeId}`
-   `DELETE /v1/fusion/recipes/{recipeId}`
-   `POST /v1/fusion/recipes/{recipeId}/playback-authorize`
-   `POST /v1/fusion/render` (later phase; asynchronous job)
-   `GET /v1/fusion/render-jobs/{jobId}`

AI endpoint requirements: - Strict request and response schemas. - Rate
limits and per-user quotas. - Timeout and retry policy. - Provider
abstraction; do not bind business logic to one LLM vendor. -
Prompt-injection resistance: catalogue metadata is untrusted data, never
executable instructions. - No secrets or private URLs in prompts. -
Store prompt and generated plan only according to a disclosed retention
policy. - Provide a deterministic fallback: manual layer builder when AI
is unavailable.

### 8.7 Error format

Use a consistent error envelope:

``` json
{
  "error": {
    "code": "ASSET_NOT_AVAILABLE",
    "message": "This audio is not available in your region.",
    "requestId": "uuid",
    "retryable": false
  }
}
```

------------------------------------------------------------------------

## 9. Content sourcing, licensing, and compliance

This is a product-critical workstream, not a later legal polish task.

For every asset, record: - Rights holder and source. - License type and
evidence reference. - Territory and validity dates. - Streaming
rights. - Offline/download rights. - Mixing and synchronization
rights. - Derivative-work and rendered-export rights. - Attribution
requirements. - Whether commercial use is permitted. - Whether the asset
may be used as a stem/loop or in AI workflows.

Do not assume that "royalty-free" means unrestricted. Some licences
prohibit redistribution, public performance, remixing, commercial use,
or offline downloads.

Operational controls: - Rights status checked when assets are ingested
and again before playback/mix authorization. - Expired/revoked rights
immediately block new authorization. - Takedown workflow and audit
log. - Territory-aware catalogue filtering. - Separate internal
proof-of-license documents from client-visible metadata. - Clear
creator/speaker consent for speeches and voice use. - Terms explain AI
processing and whether prompts are sent to a third-party model
provider. - Privacy policy and data deletion workflow. - Canadian
privacy review (including applicable federal and provincial
requirements) before public launch; obtain legal advice for actual
licensing and privacy obligations.

------------------------------------------------------------------------

## 10. Security, privacy, and reliability

-   TLS for all network traffic.
-   Secure token storage: Keychain on iOS; Android Keystore-backed
    secure storage.
-   Short-lived signed media URLs.
-   Authorization checks on every user-owned resource.
-   Rate limiting for login, search, AI generation, and render
    endpoints.
-   Validate uploads and media metadata; scan files before processing.
-   Never store API keys in mobile apps.
-   Backend secrets in a managed secret store.
-   Encryption at rest for databases and object storage.
-   Minimize analytics; do not log full prompts, transcripts, or user
    identifiers unless necessary and disclosed.
-   Provide account deletion and data export paths.
-   Define retention for playback events, AI prompts, and generated
    assets.
-   Use idempotency keys for create/render operations.
-   Graceful degradation when AI is offline: standard streaming and
    manual mix editor remain usable.

------------------------------------------------------------------------

## 11. Implementation phases and Claude task breakdown

Build vertical slices that run on both platforms. Do not build all
backend features first and defer device playback until the end.

### Phase 0 --- Project foundation and decisions

**Deliverables** - Confirm backend provider and deployment target. -
Confirm catalogue source and written rights for initial test assets. -
Create monorepo and CI pipelines. - Add architecture decision records. -
Define OpenAPI and JSON Schema contracts. - Add design tokens and
navigation skeletons on both platforms.

**Claude tasks** 1. Create repository structure and README. 2. Add iOS
SwiftUI app shell and Android Compose app shell. 3. Add linting,
formatting, build, and test workflows. 4. Add API contract validation.
5. Create sample fixtures for catalogue and mix plans.

**Exit criteria** - Both apps build from a clean checkout. - CI runs
unit tests and static checks. - API and mix-plan schemas validate.

### Phase 1 --- Catalogue, auth, and basic streaming

**Deliverables** - Sign-in and session management. -
Home/discover/search. - Catalogue detail. - Standard player and
mini-player. - Background playback and system media controls. - Playback
progress persistence.

**Claude tasks** 1. Implement backend auth verification and catalogue
endpoints. 2. Implement typed network clients. 3. Build catalogue
repository and cache. 4. Implement iOS AVPlayer-based streaming. 5.
Implement Android Media3 ExoPlayer + MediaSessionService. 6. Implement
player state and queue models. 7. Add interruption, focus, and network
recovery handling.

**Exit criteria** - User can browse, search, play, pause, seek, and
resume a test asset. - Audio continues with screen locked and app
backgrounded on supported devices. - Lock-screen/headset controls
work. - Expired signed URL can be refreshed without losing the intended
playback position.

### Phase 2 --- Library, playlists, podcasts, and motivation

**Deliverables** - Likes and playlists. - Saved content and recent
history. - Podcast show and episode pages. - Speech player with speed
control. - Transcript and timestamp bookmarks. - Daily motivation
shelves.

**Claude tasks** 1. Implement library and playlist APIs. 2. Implement
local persistence and sync. 3. Add optimistic UI with rollback on server
failure. 4. Implement podcast and motivation screens. 5. Add transcript
rendering and bookmark actions. 6. Add offline caching only for assets
whose licences permit it.

**Exit criteria** - Likes and playlist changes sync across devices. -
Podcast progress resumes correctly. - Bookmarks open the correct
timestamp. - Download controls are hidden/disabled when rights do not
allow downloads.

### Phase 3 --- AI Fusion planning and manual editor

**Deliverables** - AI prompt screen. - AI orchestration endpoint. -
Structured mix-plan schema and validator. - Rights-aware asset
selection. - Editable timeline/layer controls. - Save and reload
recipes.

**Claude tasks** 1. Implement provider-neutral LLM gateway. 2. Add
prompt templates and schema-constrained output. 3. Add schema and
semantic validation. 4. Add catalogue retrieval and rights validation.
5. Build shared mix-plan domain model. 6. Build layer timeline UI on iOS
and Android. 7. Add manual editing and deterministic fallback.

**Exit criteria** - Valid prompt produces a valid mix plan. - Invalid or
unavailable assets are rejected with actionable messages. - User can
edit and save a recipe. - AI outage does not prevent manual mixing or
standard playback.

### Phase 4 --- Multi-layer FusionPlaybackEngine

**Deliverables** - Two or more synchronized audio layers. - Per-layer
gain and fades. - Speech ducking. - Seek/pause/resume synchronization. -
Crossfade and loop support. - Playback state surfaced to UI.

**Claude tasks** 1. Implement platform-neutral engine interface and
shared fixtures. 2. Implement iOS engine with AVAudioEngine. 3.
Implement Android multi-layer engine using a selected native/platform
DSP approach. 4. Add audio focus/interruption/route recovery. 5. Add DSP
test fixtures and timing tests. 6. Tune buffering, memory, and battery
use.

**Exit criteria** - Two music layers and one speech layer can play
simultaneously. - All layers pause, resume, and seek in sync. - Fade and
ducking automation is audible and bounded. - No audio glitches in the
agreed device test matrix under normal conditions. - Engine recovers
from interruption and route change without leaking resources.

### Phase 5 --- Personalization and production hardening

**Deliverables** - User preference profiles. - Recommendation rules and
feedback loop. - Subscription/entitlement integration if required. -
Admin catalogue and rights management. - Monitoring, alerting, abuse
controls. - Accessibility and localization review. - Store submission
preparation.

**Claude tasks** 1. Add recommendation service behind an interface. 2.
Add user controls for mood/genre preferences. 3. Add admin ingestion and
rights workflows. 4. Add dashboards and alerts. 5. Perform
security/privacy review. 6. Run regression and release checklist.

**Exit criteria** - All launch assets have verified rights metadata. -
Critical user journeys pass on both platforms. - Crash, playback, API,
and AI failure dashboards are active. - Privacy, terms, attribution, and
support flows are available.

### Phase 6 --- Advanced audio (post-MVP)

-   Beat detection and beat-grid alignment.
-   Tempo/key-aware suggestions.
-   Authorized stem separation.
-   Offline rendering and export.
-   Advanced effects and automation.
-   Social sharing of recipes and licensed rendered mixes.
-   Wearable and car integrations where appropriate.

------------------------------------------------------------------------

## 12. Testing strategy

### 12.1 Unit tests

**Shared/backend** - Mix-plan schema validation. - Timestamp and
duration boundary conditions. - Rights-policy decisions by territory,
date, and allowed use. - Playlist ordering and version conflicts. -
Signed URL expiry and refresh. - AI output parsing, malformed JSON,
unsupported values, and fallback behavior. - Authorization and ownership
checks.

**iOS** - View models and state transitions. - Playback state mapping. -
Audio session configuration decisions. - Mix-plan-to-engine
scheduling. - Gain/fade envelope calculations. - Persistence and
repository tests.

**Android** - ViewModels and StateFlow behavior. - MediaSession/Player
state mapping. - Service lifecycle and resource release. -
Mix-plan-to-engine scheduling. - Gain/fade envelope calculations. - Room
and repository tests.

### 12.2 Integration tests

-   Auth -\> catalogue -\> playback authorization -\> stream.
-   Playback progress -\> relaunch -\> resume.
-   Like/playlist mutation -\> sync to another device/session.
-   AI prompt -\> plan -\> validation -\> recipe save -\> reload.
-   Rights revoked between plan generation and playback authorization.
-   Network loss during stream and recovery.
-   App backgrounding, screen lock, incoming call/audio interruption,
    headphone disconnect.
-   Podcast transcript/bookmark consistency.

### 12.3 Audio/DSP tests

-   Start-time alignment across layers.
-   Seek accuracy and drift over a long session.
-   Fade curve monotonicity and completion.
-   Speech ducking attack/release behavior.
-   No clipping beyond defined peak policy for supplied fixtures.
-   Loop boundary continuity where seamless loops are supplied.
-   CPU, memory, battery, and thermal behavior.
-   Output on speaker, wired headphones, Bluetooth, and supported
    external routes.

### 12.4 UI and accessibility tests

-   Navigation and mini-player persistence.
-   Empty, loading, offline, error, and retry states.
-   Dynamic type/font scaling.
-   VoiceOver and TalkBack labels and traversal.
-   Colour contrast and touch target sizes.
-   Landscape/resizing behavior where supported.

### 12.5 Device matrix

Test at minimum: - Current and previous supported iOS major versions. -
A small-screen and large-screen iPhone. - Current and previous supported
Android API levels. - One Pixel-class device and at least one Samsung
device. - Low-memory Android device. - Wi-Fi, throttled network,
intermittent network, and offline mode.

### 12.6 Release quality targets

Set measurable targets during beta, then enforce them: - Crash-free
sessions target: \>= 99.5%. - Standard stream start target: p95 \<= 3
seconds on a defined good network. - No unbounded memory growth during a
60-minute mix. - No audible desynchronization beyond the agreed
tolerance in a 30-minute test. - All critical rights checks fail
closed. - All critical flows have automated coverage and manual device
sign-off.

------------------------------------------------------------------------

## 13. Observability and analytics

Track product events with pseudonymous IDs and clear retention: -
`catalogue_viewed` - `search_performed` - `asset_play_requested` -
`playback_started` - `playback_failed` - `playback_completed` -
`playback_progress_saved` - `asset_liked` - `playlist_created` -
`episode_bookmarked` - `fusion_prompt_submitted` -
`fusion_plan_generated` - `fusion_plan_rejected` -
`fusion_preview_started` - `fusion_recipe_saved`

Monitor: - Stream-start latency and failure rate. - Buffering ratio and
playback interruptions. - Signed URL failures. - AI latency, schema
failure rate, provider errors, and cost per successful plan. -
Mix-engine CPU/memory and audio underruns. - Rights validation
failures. - Backend error rate and p95 latency.

Do not include raw speech transcripts, sensitive user prompts, email
addresses, or permanent media URLs in analytics events.

------------------------------------------------------------------------

## 14. Design system guidance

Visual direction: premium dark audio experience, rich artwork,
restrained gradients, clear typography, and high-contrast playback
controls.

Tokens to define: - Background / surface / elevated surface. - Primary /
secondary / accent / destructive. - Typography scale. - Spacing scale. -
Corner radii. - Artwork aspect ratios. - Player control sizes. -
Waveform and timeline semantics.

Components: - Primary and secondary buttons. - Search field. -
Genre/mood chips. - Artwork card. - Track and episode row. -
Mini-player. - Full player controls. - Queue sheet. - Transcript
segment. - Layer timeline row. - Gain slider. - Mix prompt composer. -
Empty/loading/error states.

Avoid designing the AI Studio like a full DAW in the MVP. Keep the
timeline understandable to casual listeners.

------------------------------------------------------------------------

## 15. Definition of done

A feature is complete only when: - Acceptance criteria are met on iOS
and Android. - Unit and integration tests are added. - Loading, empty,
offline, and error states are implemented. - Accessibility labels and
scalable text are checked. - Analytics are privacy-reviewed. - API
contracts and documentation are updated. - No secrets or permanent media
URLs are embedded in the app. - Rights restrictions are enforced by the
backend. - Logs contain no sensitive content. - Code is formatted,
linted, reviewed, and CI passes.

------------------------------------------------------------------------

## 16. Initial end-to-end acceptance scenarios

### Scenario A --- Stream a music track

**Given** a signed-in user and an active cleared music asset,\
**When** the user taps Play,\
**Then** the backend authorizes playback, the app starts streaming,
metadata appears in the player, and playback continues in the
background.

### Scenario B --- Resume a podcast

**Given** an episode played to 12 minutes,\
**When** the user leaves and later returns,\
**Then** the episode resumes from the last successfully persisted
position within the agreed save interval.

### Scenario C --- Generate an AI fusion plan

**Given** the user requests a 15-minute cinematic/electronic mix,\
**When** the AI endpoint is called,\
**Then** it returns a schema-valid plan containing only available asset
IDs and the plan passes rights validation.

### Scenario D --- Reject unlicensed mixing

**Given** a track is streamable but not licensed for mixing,\
**When** the user tries to add it to Fusion Studio,\
**Then** the backend rejects the layer and explains that the asset is
not cleared for remixing.

### Scenario E --- Play a multi-layer session

**Given** a validated recipe with two music layers and one speech
layer,\
**When** the user previews it,\
**Then** the layers are synchronized, gains/fades are applied, speech
ducking is audible, and pause/seek/resume affect all layers together.

### Scenario F --- AI provider unavailable

**Given** the LLM provider is unavailable,\
**When** the user opens Fusion Studio,\
**Then** manual layer editing remains available and the app presents a
recoverable AI-unavailable message.

### Scenario G --- Rights revoked

**Given** an asset's mixing rights have been revoked after a recipe was
saved,\
**When** the user attempts to play the recipe,\
**Then** playback authorization revalidates rights and blocks the
affected layer or the entire recipe according to policy.

### Scenario H --- Background controls

**Given** audio is playing,\
**When** the user locks the phone and uses headset or system controls,\
**Then** play/pause/skip commands work and displayed metadata reflects
the active item.

------------------------------------------------------------------------

## 17. Claude Code execution instructions

Use this document as the source of truth. Claude should work in small,
reviewable vertical slices and must not generate the entire application
in one pass.

### Required working protocol

1.  Read this plan and inspect the repository before editing.
2.  Identify the current phase and list the files to be created or
    modified.
3.  State assumptions and ask only for decisions that block
    implementation.
4.  Implement one vertical slice at a time.
5.  Run relevant formatters, linters, unit tests, and builds after each
    slice.
6.  Do not mark a phase complete while acceptance criteria are failing.
7.  Keep iOS and Android behavior aligned through shared API contracts
    and JSON fixtures.
8.  Add or update architecture decision records when changing major
    technical choices.
9.  Never invent licensed catalogue content or embed unverified external
    audio URLs.
10. Never commit secrets, API keys, service credentials, or private
    licence documents.
11. Keep audio rendering deterministic and independent from LLM response
    timing.
12. Prefer interfaces and dependency injection for AI, storage, auth,
    streaming, and analytics providers.

### First Claude prompt

``` text
Read IMPLEMENTATION_PLAN.md completely.

We are building VibeFusion AI for iOS using SwiftUI and Android using Kotlin + Jetpack Compose, backed by one shared API.

Do not implement the whole product yet.

Start with Phase 0 only:
1. Inspect the existing repository.
2. Propose the exact directory structure and architecture decisions.
3. Identify decisions that block implementation.
4. Create the app shells for iOS and Android.
5. Add the backend skeleton and shared OpenAPI/mix-plan schemas.
6. Add CI for formatting, linting, schema validation, and basic builds.
7. Add a concise progress checklist and update it as work completes.

Do not add commercial music URLs or unverified content. Use local synthetic fixtures for development.
Run all relevant checks and report the exact results, failures, and next steps.
```

### Follow-up prompt template

``` text
Continue with the next incomplete phase in IMPLEMENTATION_PLAN.md.

Before coding:
- Read the plan and current progress.
- Inspect the implementation and tests.
- List the acceptance criteria for this phase.

Implement only this phase as a vertical slice across backend, iOS, and Android where applicable.
Add tests, run builds and checks, update documentation, and report:
- Files changed
- Architecture decisions
- Tests/builds run and results
- Known limitations
- Acceptance criteria completed or still failing
- Recommended next task

Do not claim success for checks that were not actually run.
```

------------------------------------------------------------------------

## 18. Official technical references

Use current official documentation during implementation; verify
dependency versions and platform requirements at the time of coding.

### Apple

-   [AVFoundation
    overview](https://developer.apple.com/documentation/avfoundation)
-   [AVAudioEngine](https://developer.apple.com/documentation/avfaudio/audio-engine)
-   [AVFoundation audio
    mixing](https://developer.apple.com/documentation/avfoundation/audio-mixing)
-   [Configure an app for media playback and background
    audio](https://developer.apple.com/documentation/avfoundation/configuring-your-app-for-media-playback)

### Android

-   [Android Media3 /
    ExoPlayer](https://developer.android.com/media/media3)
-   [Background playback with
    MediaSessionService](https://developer.android.com/media/media3/session/background-playback)
-   [Create a basic media player
    app](https://developer.android.com/media/implement/playback-app)
-   [MediaSession and playback
    controls](https://developer.android.com/media/media3/session/control-playback)

### Engineering notes

-   Use the official platform playback frameworks for standard playback
    and OS integration.
-   Treat multitrack fusion as a distinct engineering subsystem and
    validate it on physical devices.
-   Verify all content rights and territory restrictions before
    streaming, caching, mixing, rendering, or sharing.
-   Keep the LLM provider and media storage vendor replaceable.

------------------------------------------------------------------------

## 19. Recommended MVP delivery order

The highest-risk technical work is synchronized multi-layer playback and
rights-safe asset management. Prove these early with a small catalogue
of cleared sample tracks.

Recommended first demo: 1. Play one royalty-free instrumental track on
both platforms. 2. Play a second track simultaneously with independent
volume. 3. Add a speech track and duck the background music. 4. Seek,
pause, resume, and background the app without losing synchronization. 5.
Generate the same mix recipe using AI and manually. 6. Reject a test
asset whose rights record does not allow mixing.

Once this demo is reliable, build the full catalogue, library, podcast,
and recommendation experiences around it.
