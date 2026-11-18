import type { Db } from "../db/db.js";
import { capabilities, type Capabilities, type GrantRecord } from "../rights/policy.js";
import { grantsFor } from "../rights/repo.js";

export interface AssetRow {
  id: string;
  title: string;
  subtitle: string | null;
  description: string | null;
  asset_type: string;
  creator_id: string | null;
  creator_name: string | null;
  creator_type: string | null;
  album_id: string | null;
  show_id: string | null;
  show_title: string | null;
  duration_ms: number;
  artwork_url: string | null;
  streaming_format: string;
  mime_type: string;
  language: string;
  genres: string[];
  moods: string[];
  topics: string[];
  tempo_bpm: number | null;
  musical_key: string | null;
  is_explicit: boolean;
  is_active: boolean;
  is_dev_fixture: boolean;
  release_date: Date | string | null;
  episode_number: number | null;
  popularity: number;
  created_at: Date | string;
}

export interface AssetDto {
  id: string;
  title: string;
  subtitle: string | null;
  description: string | null;
  assetType: string;
  creatorId: string | null;
  creator: { id: string; name: string; creatorType: string } | null;
  albumId: string | null;
  showId: string | null;
  showTitle: string | null;
  durationMs: number;
  artworkUrl: string | null;
  streamingFormat: string;
  language: string;
  genres: string[];
  moods: string[];
  topics: string[];
  tempoBpm: number | null;
  key: string | null;
  isExplicit: boolean;
  isActive: boolean;
  isDevFixture: boolean;
  releaseDate: string | null;
  episodeNumber: number | null;
  capabilities: Capabilities;
  license: { type: string; url: string | null; attribution: string | null; rightsHolder: string } | null;
  createdAt: string;
}

export const ASSET_SELECT = `
  SELECT a.*, c.name AS creator_name, c.creator_type AS creator_type, s.title AS show_title
  FROM audio_assets a
  LEFT JOIN creators c ON c.id = a.creator_id
  LEFT JOIN shows s ON s.id = a.show_id`;

const iso = (v: Date | string | null) =>
  v === null ? null : v instanceof Date ? v.toISOString() : new Date(v).toISOString();

export function toDto(r: AssetRow, grants: GrantRecord[], territory: string, now: Date): AssetDto {
  const caps = r.is_active
    ? capabilities(grants, territory, now)
    : { stream: false, download: false, mix: false, render: false };
  const primary = grants.find((g) => g.status === "active") ?? grants[0];
  return {
    id: r.id,
    title: r.title,
    subtitle: r.subtitle,
    description: r.description,
    assetType: r.asset_type,
    creatorId: r.creator_id,
    creator:
      r.creator_id && r.creator_name
        ? { id: r.creator_id, name: r.creator_name, creatorType: r.creator_type ?? "artist" }
        : null,
    albumId: r.album_id,
    showId: r.show_id,
    showTitle: r.show_title,
    durationMs: r.duration_ms,
    artworkUrl: r.artwork_url,
    streamingFormat: r.streaming_format,
    language: r.language,
    genres: r.genres,
    moods: r.moods,
    topics: r.topics,
    tempoBpm: r.tempo_bpm,
    key: r.musical_key,
    isExplicit: r.is_explicit,
    isActive: r.is_active,
    isDevFixture: r.is_dev_fixture,
    releaseDate: iso(r.release_date),
    episodeNumber: r.episode_number,
    capabilities: caps,
    license: primary
      ? {
          type: primary.licenseType,
          url: primary.licenseUrl,
          attribution: primary.attributionRequired ? primary.attributionText : null,
          rightsHolder: primary.rightsHolder,
        }
      : null,
    createdAt: iso(r.created_at)!,
  };
}

/** Load assets by arbitrary WHERE/ORDER clause (appended to ASSET_SELECT) and attach rights capabilities. */
export async function queryAssets(
  db: Db,
  tail: string,
  params: unknown[],
  territory: string,
  now: Date,
): Promise<AssetDto[]> {
  const rows = await db.query<AssetRow>(`${ASSET_SELECT} ${tail}`, params);
  const grants = await grantsFor(
    db,
    rows.map((r) => r.id),
  );
  return rows.map((r) => toDto(r, grants.get(r.id) ?? [], territory, now));
}

export async function assetsByIds(db: Db, ids: string[], territory: string, now: Date): Promise<AssetDto[]> {
  if (ids.length === 0) return [];
  const list = await queryAssets(db, `WHERE a.id = ANY($1::uuid[])`, [ids], territory, now);
  const byId = new Map(list.map((a) => [a.id, a]));
  return ids.map((id) => byId.get(id)).filter((a): a is AssetDto => !!a);
}

/**
 * SQL predicate: asset `a` has an active, in-window grant for `use` covering the territory.
 * `tp` / `np` are the positional parameter indexes holding territory and now.
 */
export function rightsSql(use: string, tp: number, np: number): string {
  return `EXISTS (SELECT 1 FROM rights_grants g WHERE g.asset_id = a.id AND g.status = 'active'
    AND g.valid_from <= $${np} AND (g.valid_until IS NULL OR g.valid_until > $${np})
    AND ('*' = ANY(g.territories) OR $${tp} = ANY(g.territories)) AND '${use}' = ANY(g.allowed_uses))`;
}

/** Visible in browse/search: active, streamable in the territory, explicit filter applied. */
export const visible = (a: AssetDto, explicitAllowed = true) =>
  a.isActive && a.capabilities.stream && (explicitAllowed || !a.isExplicit);
