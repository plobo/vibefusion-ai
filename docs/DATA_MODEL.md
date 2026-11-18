# Data model

Schema: [`backend/migrations/001_init.sql`](../backend/migrations/001_init.sql). UUID keys, `timestamptz`, soft deletion for
users/playlists/recipes, explicit ownership on every user resource.

| Table | Notes |
|---|---|
| `users`, `refresh_tokens`, `user_preferences` | scrypt hashes; refresh tokens stored as SHA-256, rotated on use |
| `creators`, `albums`, `shows` | catalogue metadata; `source_key` makes ingestion idempotent |
| `audio_assets` | type, duration, genres/moods/topics (GIN), tempo/key, explicit, `search_vector` (generated tsvector, GIN) |
| `asset_storage` | **private** storage location (remote URL / synthetic key), transcript & chapters URLs — never exposed |
| `rights_grants` | holder, licence type/url, territories (GIN), validity window, allowed uses, attribution, private proof ref, status |
| `collections`, `collection_items` | curated shelves rebuilt after ingestion |
| `likes` (PK user+asset), `follows` | unique per user/target |
| `playlists` (+`version`), `playlist_items` (unique playlist+position, deferrable) | server-authoritative ordering |
| `playback_progress` (unique user+asset; index user, updated_at) | resume + history |
| `transcript_segments`, `chapters`, `bookmarks` | transcripts cached from publisher VTT/SRT |
| `mix_recipes` (+`version`, versioned `mix_plan` jsonb), `mix_layers` | layers normalized for analytics |
| `recipe_shares`, `render_jobs`, `ai_usage` | sharing tokens, render audit, AI quota |
| `product_events` | pseudonymous, allow-listed analytics (90-day retention) |
| `idempotency_keys`, `audit_log`, `ingestion_runs` | operations |

Mobile persistence: iOS SwiftData (`DownloadRecord`, `PendingProgress`) + Keychain tokens + JSON response cache;
Android Room (`downloads`, `pending_progress`, `cached_json`, `likes`) + Keystore-encrypted tokens + DataStore settings.
