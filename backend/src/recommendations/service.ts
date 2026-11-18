import type { Db } from "../db/db.js";
import { queryAssets, rightsSql, type AssetDto } from "../catalogue/repo.js";

/** Recommendation port. The rule-based implementation can be swapped for a learned model later. */
export interface RecommendationService {
  forUser(userId: string, territory: string, limit: number): Promise<AssetDto[]>;
}

/**
 * Scores streamable assets by stated preferences (genres/moods/topics) plus implicit feedback
 * (likes and completed listens), and down-weights things already heard.
 */
export class RuleBasedRecommendations implements RecommendationService {
  constructor(
    private readonly db: Db,
    private readonly now: () => Date,
  ) {}

  async forUser(userId: string, territory: string, limit: number): Promise<AssetDto[]> {
    const prefs = await this.db.one<{
      genres: string[];
      moods: string[];
      speech_topics: string[];
      explicit_allowed: boolean;
    }>(`SELECT genres, moods, speech_topics, explicit_allowed FROM user_preferences WHERE user_id = $1`, [
      userId,
    ]);
    const liked = await this.db.query<{ genres: string[]; moods: string[]; topics: string[] }>(
      `SELECT a.genres, a.moods, a.topics FROM likes l JOIN audio_assets a ON a.id = l.asset_id WHERE l.user_id = $1
       UNION ALL
       SELECT a.genres, a.moods, a.topics FROM playback_progress p JOIN audio_assets a ON a.id = p.asset_id WHERE p.user_id = $1 AND p.completed`,
      [userId],
    );
    const weight = new Map<string, number>();
    const add = (tags: string[], w: number) => tags.forEach((t) => weight.set(t, (weight.get(t) ?? 0) + w));
    add(prefs?.genres ?? [], 3);
    add(prefs?.moods ?? [], 3);
    add(prefs?.speech_topics ?? [], 3);
    for (const l of liked) add([...l.genres, ...l.moods, ...l.topics], 1);
    if (weight.size === 0) return [];
    const now = this.now();
    const pool = await queryAssets(
      this.db,
      `WHERE a.is_active AND ${rightsSql("stream", 1, 2)} AND a.asset_type IN ('music','speech','podcast_episode','loop')
         ${prefs?.explicit_allowed ? "" : "AND NOT a.is_explicit"}
         AND NOT EXISTS (SELECT 1 FROM playback_progress p WHERE p.user_id = $3 AND p.asset_id = a.id AND p.completed)
       ORDER BY a.popularity DESC LIMIT 400`,
      [territory, now, userId],
      territory,
      now,
    );
    return pool
      .map((a) => ({
        a,
        s:
          [...a.genres, ...a.moods, ...a.topics].reduce((acc, t) => acc + (weight.get(t) ?? 0), 0) -
          (a.isDevFixture ? 2 : 0),
      }))
      .filter((x) => x.s > 0)
      .sort((x, y) => y.s - x.s || x.a.id.localeCompare(y.a.id))
      .slice(0, limit)
      .map((x) => x.a);
  }
}
