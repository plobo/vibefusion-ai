# API contracts

* Source of truth: [`contracts/openapi.yaml`](../contracts/openapi.yaml) (OpenAPI 3.1) and [`contracts/schemas/`](../contracts/schemas).
* `npm run contracts:validate` (CI) checks: the spec parses, every `$ref` resolves, schemas compile, fixtures validate, and
  **every route the backend registers is documented** (and every documented `/v1` route exists).
* Clients: Swift `VibeFusionAPI` (VFCore) and Kotlin `VibeFusionApi` (Retrofit) are hand-maintained typed clients over the
  same contract; JSON fixtures in `contracts/fixtures/` are decoded by all three test suites.

## Conventions
* JSON, camelCase, UUID ids, ISO-8601 UTC timestamps. Cursor pagination: `?cursor=&limit=` → `{ items, nextCursor }`.
* Errors: `{ "error": { "code", "message", "requestId", "retryable", "details?" } }`. Codes include `VALIDATION_FAILED`,
  `UNAUTHENTICATED`, `TOKEN_EXPIRED`, `FORBIDDEN`, `NOT_FOUND`, `VERSION_CONFLICT`, `RATE_LIMITED`, `QUOTA_EXCEEDED`,
  `ASSET_NOT_AVAILABLE`, `RIGHTS_NOT_GRANTED`, `MIX_PLAN_INVALID`, `AI_UNAVAILABLE`, `MEDIA_URL_EXPIRED` (410, retryable), `NOT_IMPLEMENTED`.
* Concurrency: playlists and recipes carry `version`; send `If-Match: "<version>"` or `version` in the body → `409 VERSION_CONFLICT`
  instead of silent overwrite. Creates/renders accept `Idempotency-Key` (24 h replay).
* Rate limits: global 600/min; auth 10/min; search 120/min; fusion plan 20/min + per-user daily quota (`AI_DAILY_QUOTA`).
* Guest-accessible: home, catalogue, assets, creators, genres, moods, collections, search, podcasts, episodes, transcripts,
  motivation, fusion status, shared recipes, media (signed). Everything else requires a bearer token.
