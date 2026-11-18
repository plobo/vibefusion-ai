-- VibeFusion AI initial schema. UUID ids, UTC timestamptz, soft deletion where appropriate.
-- Catalogue metadata is kept separate from storage locations (asset_storage) and rights records (rights_grants).

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY,
  email text NOT NULL,
  display_name text NOT NULL,
  avatar_url text,
  locale text NOT NULL DEFAULT 'en-CA',
  territory text NOT NULL DEFAULT 'CA',
  password_hash text,
  auth_provider text NOT NULL DEFAULT 'local',
  provider_subject text,
  is_guest boolean NOT NULL DEFAULT false,
  is_admin boolean NOT NULL DEFAULT false,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_active ON users (lower(email)) WHERE deleted_at IS NULL AND is_guest = false;

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_preferences (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  genres text[] NOT NULL DEFAULT '{}',
  moods text[] NOT NULL DEFAULT '{}',
  speech_topics text[] NOT NULL DEFAULT '{}',
  explicit_allowed boolean NOT NULL DEFAULT false,
  analytics_opt_in boolean NOT NULL DEFAULT true,
  ai_processing_consent boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS creators (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  creator_type text NOT NULL CHECK (creator_type IN ('artist','speaker','podcaster','label')),
  bio text,
  image_url text,
  website_url text,
  source_key text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS albums (
  id uuid PRIMARY KEY,
  title text NOT NULL,
  creator_id uuid REFERENCES creators(id),
  artwork_url text,
  source_key text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS shows (
  id uuid PRIMARY KEY,
  title text NOT NULL,
  description text,
  creator_id uuid REFERENCES creators(id),
  artwork_url text,
  language text NOT NULL DEFAULT 'en',
  categories text[] NOT NULL DEFAULT '{}',
  show_kind text NOT NULL DEFAULT 'podcast' CHECK (show_kind IN ('podcast','speech_series')),
  feed_url text,
  source_key text UNIQUE,
  is_active boolean NOT NULL DEFAULT true,
  last_ingested_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audio_assets (
  id uuid PRIMARY KEY,
  title text NOT NULL,
  subtitle text,
  description text,
  asset_type text NOT NULL CHECK (asset_type IN ('music','speech','podcast_episode','loop','stem','sound_effect')),
  creator_id uuid REFERENCES creators(id),
  album_id uuid REFERENCES albums(id),
  show_id uuid REFERENCES shows(id),
  duration_ms integer NOT NULL CHECK (duration_ms >= 0),
  artwork_url text,
  streaming_format text NOT NULL CHECK (streaming_format IN ('hls','progressive','local')),
  mime_type text NOT NULL DEFAULT 'audio/mpeg',
  language text NOT NULL DEFAULT 'en',
  genres text[] NOT NULL DEFAULT '{}',
  moods text[] NOT NULL DEFAULT '{}',
  topics text[] NOT NULL DEFAULT '{}',
  tempo_bpm real,
  musical_key text,
  is_explicit boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  is_dev_fixture boolean NOT NULL DEFAULT false,
  release_date timestamptz,
  episode_number integer,
  popularity integer NOT NULL DEFAULT 0,
  source_key text UNIQUE,
  search_vector tsvector GENERATED ALWAYS AS (
    to_tsvector('simple', coalesce(title,'') || ' ' || coalesce(subtitle,'') || ' ' || coalesce(description,''))
  ) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS assets_type_active ON audio_assets (asset_type, is_active, language);
CREATE INDEX IF NOT EXISTS assets_creator ON audio_assets (creator_id);
CREATE INDEX IF NOT EXISTS assets_show ON audio_assets (show_id, release_date DESC);
CREATE INDEX IF NOT EXISTS assets_genres ON audio_assets USING gin (genres);
CREATE INDEX IF NOT EXISTS assets_moods ON audio_assets USING gin (moods);
CREATE INDEX IF NOT EXISTS assets_search ON audio_assets USING gin (search_vector);

-- Private storage locations. Never returned to clients; resolved only by the signed media endpoint.
CREATE TABLE IF NOT EXISTS asset_storage (
  asset_id uuid PRIMARY KEY REFERENCES audio_assets(id) ON DELETE CASCADE,
  storage_kind text NOT NULL CHECK (storage_kind IN ('remote','synthetic','object')),
  storage_key text NOT NULL,
  transcript_url text,
  chapters_url text
);

CREATE TABLE IF NOT EXISTS rights_grants (
  id uuid PRIMARY KEY,
  asset_id uuid NOT NULL REFERENCES audio_assets(id) ON DELETE CASCADE,
  rights_holder text NOT NULL,
  license_type text NOT NULL CHECK (license_type IN ('owned','royalty_free','direct_license','public_domain_verified','creative_commons','publisher_feed')),
  license_url text,
  territories text[] NOT NULL DEFAULT '{*}',
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_until timestamptz,
  allowed_uses text[] NOT NULL,
  commercial_use boolean NOT NULL DEFAULT false,
  attribution_required boolean NOT NULL DEFAULT false,
  attribution_text text,
  proof_reference text NOT NULL,
  status text NOT NULL CHECK (status IN ('active','expired','revoked','under_review')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rights_asset_status ON rights_grants (asset_id, status, valid_from, valid_until);
CREATE INDEX IF NOT EXISTS rights_territories ON rights_grants USING gin (territories);

CREATE TABLE IF NOT EXISTS collections (
  id uuid PRIMARY KEY,
  slug text NOT NULL UNIQUE,
  title text NOT NULL,
  description text,
  artwork_url text,
  kind text NOT NULL DEFAULT 'curated',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS collection_items (
  collection_id uuid NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  asset_id uuid NOT NULL REFERENCES audio_assets(id) ON DELETE CASCADE,
  position integer NOT NULL,
  PRIMARY KEY (collection_id, asset_id)
);

CREATE TABLE IF NOT EXISTS likes (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  asset_id uuid NOT NULL REFERENCES audio_assets(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, asset_id)
);

CREATE TABLE IF NOT EXISTS follows (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_type text NOT NULL CHECK (target_type IN ('show','creator')),
  target_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, target_type, target_id)
);

CREATE TABLE IF NOT EXISTS playlists (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  artwork_url text,
  visibility text NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','unlisted','public')),
  version integer NOT NULL DEFAULT 1,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS playlists_owner ON playlists (owner_id) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS playlist_items (
  id uuid PRIMARY KEY,
  playlist_id uuid NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  asset_id uuid NOT NULL REFERENCES audio_assets(id) ON DELETE CASCADE,
  position integer NOT NULL,
  added_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (playlist_id, position) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE IF NOT EXISTS playback_progress (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  asset_id uuid NOT NULL REFERENCES audio_assets(id) ON DELETE CASCADE,
  position_ms integer NOT NULL CHECK (position_ms >= 0),
  completed boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, asset_id)
);
CREATE INDEX IF NOT EXISTS progress_user_updated ON playback_progress (user_id, updated_at DESC);

-- Pseudonymous, allow-listed product events. Retention: 90 days (see docs/RIGHTS_AND_CONTENT_POLICY.md).
CREATE TABLE IF NOT EXISTS product_events (
  id bigserial PRIMARY KEY,
  pseudonymous_id text NOT NULL,
  name text NOT NULL,
  properties jsonb NOT NULL DEFAULT '{}',
  platform text,
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS events_name_time ON product_events (name, occurred_at);

CREATE TABLE IF NOT EXISTS transcript_segments (
  id uuid PRIMARY KEY,
  asset_id uuid NOT NULL REFERENCES audio_assets(id) ON DELETE CASCADE,
  start_ms integer NOT NULL,
  end_ms integer NOT NULL,
  text text NOT NULL,
  speaker text
);
CREATE INDEX IF NOT EXISTS transcript_asset ON transcript_segments (asset_id, start_ms);

CREATE TABLE IF NOT EXISTS chapters (
  id uuid PRIMARY KEY,
  asset_id uuid NOT NULL REFERENCES audio_assets(id) ON DELETE CASCADE,
  start_ms integer NOT NULL,
  title text NOT NULL
);

CREATE TABLE IF NOT EXISTS bookmarks (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  asset_id uuid NOT NULL REFERENCES audio_assets(id) ON DELETE CASCADE,
  position_ms integer NOT NULL CHECK (position_ms >= 0),
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bookmarks_user_asset ON bookmarks (user_id, asset_id);

CREATE TABLE IF NOT EXISTS mix_recipes (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  prompt text,
  duration_ms integer NOT NULL,
  mix_plan_version integer NOT NULL DEFAULT 1,
  mix_plan jsonb NOT NULL,
  rights_validation_status text NOT NULL CHECK (rights_validation_status IN ('valid','invalid','needs_review')),
  planner text NOT NULL DEFAULT 'manual',
  version integer NOT NULL DEFAULT 1,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS recipes_owner ON mix_recipes (owner_id, updated_at DESC) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS mix_layers (
  recipe_id uuid NOT NULL REFERENCES mix_recipes(id) ON DELETE CASCADE,
  layer_id text NOT NULL,
  asset_id uuid NOT NULL,
  role text NOT NULL,
  start_ms integer NOT NULL,
  duration_ms integer NOT NULL,
  gain_db real NOT NULL,
  PRIMARY KEY (recipe_id, layer_id)
);

CREATE TABLE IF NOT EXISTS recipe_shares (
  token text PRIMARY KEY,
  recipe_id uuid NOT NULL REFERENCES mix_recipes(id) ON DELETE CASCADE,
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS render_jobs (
  id uuid PRIMARY KEY,
  recipe_id uuid NOT NULL REFERENCES mix_recipes(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('queued','authorized','completed','failed','rejected')),
  mode text NOT NULL DEFAULT 'client_offline',
  attribution text,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ai_usage (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day date NOT NULL,
  requests integer NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key text NOT NULL,
  user_id uuid NOT NULL,
  route text NOT NULL,
  status_code integer NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (key, user_id, route)
);

CREATE TABLE IF NOT EXISTS audit_log (
  id bigserial PRIMARY KEY,
  actor_id uuid,
  action text NOT NULL,
  target_type text NOT NULL,
  target_id text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ingestion_runs (
  id uuid PRIMARY KEY,
  source text NOT NULL,
  status text NOT NULL,
  added integer NOT NULL DEFAULT 0,
  skipped integer NOT NULL DEFAULT 0,
  error text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
