import { XMLParser } from "fast-xml-parser";
import type { Db } from "../db/db.js";
import { stableUuid, uuid } from "../common/ids.js";
import { upsertGrant } from "../rights/repo.js";
import { usesForLicenseUrl } from "../rights/policy.js";
import { getJson, getText, parseDurationMs, type FetchLike } from "./http.js";

/**
 * Free, openly licensed sources. Every asset is ingested together with a rights grant derived from
 * the licence the source publishes; anything with an unknown or NonCommercial licence is skipped.
 *
 *  - Internet Archive netlabels: Creative Commons BY / BY-SA / BY-ND and public-domain music.
 *  - LibriVox (via Internet Archive): public-domain readings of classic motivational texts.
 *  - Podcasts: public RSS feeds discovered through the iTunes Search API, stream-only per publisher terms.
 */

export interface IngestReport {
  source: string;
  added: number;
  skipped: number;
  errors: string[];
}

const IA_LICENSES = [
  "http://creativecommons.org/licenses/by/3.0/",
  "http://creativecommons.org/licenses/by/4.0/",
  "http://creativecommons.org/licenses/by-sa/3.0/",
  "http://creativecommons.org/licenses/by-sa/4.0/",
  "http://creativecommons.org/licenses/by-nd/3.0/",
  "http://creativecommons.org/licenses/by-nd/4.0/",
  "http://creativecommons.org/publicdomain/zero/1.0/",
  "http://creativecommons.org/publicdomain/mark/1.0/",
];

export const MUSIC_GENRES: { genre: string; subject: string; moods: string[] }[] = [
  { genre: "ambient", subject: "ambient", moods: ["calm", "focus"] },
  { genre: "electronic", subject: "electronic", moods: ["energetic", "uplifting"] },
  { genre: "cinematic", subject: "soundtrack", moods: ["uplifting", "dramatic"] },
  { genre: "classical", subject: "classical", moods: ["calm", "uplifting"] },
  { genre: "piano", subject: "piano", moods: ["calm", "reflective"] },
  { genre: "jazz", subject: "jazz", moods: ["relaxed", "warm"] },
  { genre: "chillout", subject: "chillout", moods: ["calm", "relaxed"] },
  { genre: "rock", subject: "rock", moods: ["energetic"] },
  { genre: "hip-hop", subject: "hip hop", moods: ["energetic", "confident"] },
  { genre: "world", subject: "world", moods: ["uplifting", "warm"] },
];

const MOOD_HINTS: [RegExp, string][] = [
  [/chill|relax|calm|ambient|sleep|meditat/i, "calm"],
  [/dance|techno|house|trance|drum|edm|rock|energ/i, "energetic"],
  [/epic|cinematic|soundtrack|orchestr|hope|uplift/i, "uplifting"],
  [/dark|noir|melanchol|sad/i, "melancholic"],
  [/focus|study|minimal/i, "focus"],
];

const iaSearchUrl = (q: string, rows: number, fields: string[]) =>
  `https://archive.org/advancedsearch.php?q=${encodeURIComponent(q)}&${fields.map((f) => `fl[]=${f}`).join("&")}&rows=${rows}&sort[]=downloads+desc&output=json`;

interface IaDoc {
  identifier: string;
  title?: string;
  creator?: string | string[];
  subject?: string | string[];
  licenseurl?: string;
  date?: string;
}
interface IaFile {
  name: string;
  format?: string;
  length?: string;
  title?: string;
  track?: string;
  source?: string;
}
interface IaMetadata {
  metadata?: {
    title?: string;
    creator?: string | string[];
    licenseurl?: string;
    description?: string | string[];
    subject?: string | string[];
  };
  files?: IaFile[];
}

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const list = (v: string | string[] | undefined) =>
  (Array.isArray(v) ? v : v ? v.split(/[;,]/) : []).map((s) => s.trim()).filter(Boolean);
const strip = (s: string | undefined | null, max = 600) =>
  (s ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max) || null;

async function upsertCreator(db: Db, name: string, type: string, key: string): Promise<string> {
  const id = stableUuid(`creator:${key}`);
  await db.query(
    `INSERT INTO creators (id, name, creator_type, source_key) VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING`,
    [id, name.slice(0, 200), type, key],
  );
  return id;
}

function pickMp3s(files: IaFile[], max: number): IaFile[] {
  const mp3 = files.filter(
    (f) =>
      f.name.toLowerCase().endsWith(".mp3") &&
      !/_64kb\.mp3$/i.test(f.name) &&
      parseDurationMs(f.length) > 30000,
  );
  const originals = mp3.filter((f) => f.source !== "derivative");
  return (originals.length > 0 ? originals : mp3).slice(0, max);
}

export async function ingestInternetArchiveMusic(
  db: Db,
  f: FetchLike,
  opts: { itemsPerGenre?: number; tracksPerItem?: number } = {},
): Promise<IngestReport> {
  const report: IngestReport = { source: "internet_archive_music", added: 0, skipped: 0, errors: [] };
  const licQ = IA_LICENSES.map((l) => `"${l}"`).join(" OR ");
  for (const g of MUSIC_GENRES) {
    try {
      const q = `collection:netlabels AND mediatype:audio AND subject:"${g.subject}" AND licenseurl:(${licQ})`;
      const res = await getJson<{ response?: { docs?: IaDoc[] } }>(
        f,
        iaSearchUrl(q, opts.itemsPerGenre ?? 3, [
          "identifier",
          "title",
          "creator",
          "subject",
          "licenseurl",
          "date",
        ]),
      );
      for (const doc of res.response?.docs ?? []) {
        const lic = usesForLicenseUrl(doc.licenseurl);
        if (!lic) {
          report.skipped++;
          continue;
        }
        try {
          const meta = await getJson<IaMetadata>(
            f,
            `https://archive.org/metadata/${encodeURIComponent(doc.identifier)}`,
          );
          const creatorName = first(doc.creator) ?? first(meta.metadata?.creator) ?? "Unknown artist";
          const creatorId = await upsertCreator(
            db,
            creatorName,
            "artist",
            `ia:creator:${creatorName.toLowerCase()}`,
          );
          const albumId = stableUuid(`ia:album:${doc.identifier}`);
          const artwork = `https://archive.org/services/img/${encodeURIComponent(doc.identifier)}`;
          await db.query(
            `INSERT INTO albums (id, title, creator_id, artwork_url, source_key) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO NOTHING`,
            [
              albumId,
              (doc.title ?? doc.identifier).slice(0, 200),
              creatorId,
              artwork,
              `ia:${doc.identifier}`,
            ],
          );
          const subjects = list(doc.subject)
            .map((s) => s.toLowerCase())
            .slice(0, 12);
          const moods = new Set(g.moods);
          for (const [re, mood] of MOOD_HINTS) if (subjects.some((s) => re.test(s))) moods.add(mood);
          const genres = new Set([
            g.genre,
            ...subjects.filter((s) => MUSIC_GENRES.some((x) => x.subject === s || x.genre === s)),
          ]);
          for (const file of pickMp3s(meta.files ?? [], opts.tracksPerItem ?? 3)) {
            const sourceKey = `ia:${doc.identifier}/${file.name}`;
            const id = stableUuid(sourceKey);
            const title = file.title || file.name.replace(/\.mp3$/i, "").replace(/[_-]+/g, " ");
            const inserted = await db.query(
              `INSERT INTO audio_assets (id, title, subtitle, description, asset_type, creator_id, album_id, duration_ms, artwork_url,
                 streaming_format, mime_type, genres, moods, source_key, popularity)
               VALUES ($1,$2,$3,$4,'music',$5,$6,$7,$8,'progressive','audio/mpeg',$9,$10,$11,$12)
               ON CONFLICT (id) DO NOTHING RETURNING id`,
              [
                id,
                title.slice(0, 200),
                creatorName.slice(0, 200),
                strip(first(meta.metadata?.description)),
                creatorId,
                albumId,
                parseDurationMs(file.length),
                artwork,
                [...genres],
                [...moods],
                sourceKey,
                10,
              ],
            );
            if (inserted.length === 0) {
              report.skipped++;
              continue;
            }
            const url = `https://archive.org/download/${encodeURIComponent(doc.identifier)}/${file.name.split("/").map(encodeURIComponent).join("/")}`;
            await db.query(
              `INSERT INTO asset_storage (asset_id, storage_kind, storage_key) VALUES ($1,'remote',$2) ON CONFLICT DO NOTHING`,
              [id, url],
            );
            await upsertGrant(db, {
              assetId: id,
              rightsHolder: creatorName,
              licenseType: lic.licenseType,
              licenseUrl: doc.licenseurl,
              allowedUses: lic.uses,
              attributionRequired: lic.attribution,
              attributionText: `"${title}" by ${creatorName} — ${doc.licenseurl} (via Internet Archive)`,
              commercialUse: lic.commercial,
              proofReference: `https://archive.org/details/${doc.identifier}`,
            });
            report.added++;
          }
        } catch (e) {
          report.errors.push(`${doc.identifier}: ${(e as Error).message}`);
        }
      }
    } catch (e) {
      report.errors.push(`${g.genre}: ${(e as Error).message}`);
    }
  }
  return report;
}

export const MOTIVATION_TOPICS = [
  "discipline",
  "confidence",
  "career",
  "resilience",
  "leadership",
  "fitness",
  "mindfulness",
] as const;

export const SPEECH_WORKS: { title: string; author: string; topics: string[] }[] = [
  { title: "As a Man Thinketh", author: "James Allen", topics: ["mindfulness", "discipline"] },
  { title: "Self-Reliance", author: "Ralph Waldo Emerson", topics: ["confidence", "resilience"] },
  { title: "Acres of Diamonds", author: "Russell H. Conwell", topics: ["career", "confidence"] },
  {
    title: "Pushing to the Front",
    author: "Orison Swett Marden",
    topics: ["resilience", "career", "discipline"],
  },
  { title: "Meditations", author: "Marcus Aurelius", topics: ["mindfulness", "resilience", "leadership"] },
  {
    title: "How to Live on Twenty-Four Hours a Day",
    author: "Arnold Bennett",
    topics: ["discipline", "career"],
  },
  {
    title: "The Strenuous Life",
    author: "Theodore Roosevelt",
    topics: ["leadership", "fitness", "resilience"],
  },
  { title: "Self-Help", author: "Samuel Smiles", topics: ["discipline", "leadership"] },
];

export async function ingestLibriVoxSpeeches(
  db: Db,
  f: FetchLike,
  opts: { chaptersPerWork?: number } = {},
): Promise<IngestReport> {
  const report: IngestReport = { source: "librivox", added: 0, skipped: 0, errors: [] };
  for (const work of SPEECH_WORKS) {
    try {
      const q = `collection:librivoxaudio AND title:("${work.title}")`;
      const res = await getJson<{ response?: { docs?: IaDoc[] } }>(
        f,
        iaSearchUrl(q, 3, ["identifier", "title", "creator", "licenseurl"]),
      );
      const doc = (res.response?.docs ?? []).find(
        (d) => usesForLicenseUrl(d.licenseurl)?.licenseType === "public_domain_verified",
      );
      if (!doc) {
        report.skipped++;
        continue;
      }
      const meta = await getJson<IaMetadata>(
        f,
        `https://archive.org/metadata/${encodeURIComponent(doc.identifier)}`,
      );
      const creatorId = await upsertCreator(
        db,
        work.author,
        "speaker",
        `author:${work.author.toLowerCase()}`,
      );
      const showId = stableUuid(`librivox:show:${doc.identifier}`);
      const artwork = `https://archive.org/services/img/${encodeURIComponent(doc.identifier)}`;
      await db.query(
        `INSERT INTO shows (id, title, description, creator_id, artwork_url, categories, show_kind, source_key)
         VALUES ($1,$2,$3,$4,$5,$6,'speech_series',$7) ON CONFLICT (id) DO NOTHING`,
        [
          showId,
          doc.title ?? work.title,
          strip(first(meta.metadata?.description)),
          creatorId,
          artwork,
          work.topics,
          `librivox:${doc.identifier}`,
        ],
      );
      // Prefer LibriVox's 64 kbps derivatives: ~4x smaller than VBR originals, ample for speech, faster to start and to buffer for mixing.
      const mp3s = (meta.files ?? []).filter(
        (x) => x.name.endsWith(".mp3") && parseDurationMs(x.length) > 60000,
      );
      const lowBitrate = mp3s.filter((x) => /_64kb\.mp3$/i.test(x.name));
      const files = lowBitrate.length > 0 ? lowBitrate : mp3s;
      let n = 0;
      for (const file of files.slice(0, opts.chaptersPerWork ?? 6)) {
        n++;
        const sourceKey = `librivox:${doc.identifier}/${file.name}`;
        const id = stableUuid(sourceKey);
        const title = file.title || `${work.title} — Part ${n}`;
        const ins = await db.query(
          `INSERT INTO audio_assets (id, title, subtitle, description, asset_type, creator_id, show_id, duration_ms, artwork_url,
             streaming_format, mime_type, topics, moods, episode_number, source_key, popularity, language)
           VALUES ($1,$2,$3,$4,'speech',$5,$6,$7,$8,'progressive','audio/mpeg',$9,$10,$11,$12,$13,'en') ON CONFLICT (id) DO NOTHING RETURNING id`,
          [
            id,
            title.slice(0, 200),
            `${work.title} · ${work.author}`,
            `Public-domain reading by LibriVox volunteers.`,
            creatorId,
            showId,
            parseDurationMs(file.length),
            artwork,
            work.topics,
            ["uplifting", "reflective"],
            n,
            sourceKey,
            8,
          ],
        );
        if (ins.length === 0) {
          report.skipped++;
          continue;
        }
        const url = `https://archive.org/download/${encodeURIComponent(doc.identifier)}/${encodeURIComponent(file.name)}`;
        await db.query(
          `INSERT INTO asset_storage (asset_id, storage_kind, storage_key) VALUES ($1,'remote',$2) ON CONFLICT DO NOTHING`,
          [id, url],
        );
        await upsertGrant(db, {
          assetId: id,
          rightsHolder: "Public domain (LibriVox)",
          licenseType: "public_domain_verified",
          licenseUrl: doc.licenseurl,
          allowedUses: ["stream", "offline_download", "mix", "derivative_render"],
          attributionRequired: false,
          attributionText: `${work.title} by ${work.author}, read by LibriVox volunteers (public domain).`,
          commercialUse: true,
          proofReference: `https://archive.org/details/${doc.identifier}`,
        });
        report.added++;
      }
    } catch (e) {
      report.errors.push(`${work.title}: ${(e as Error).message}`);
    }
  }
  return report;
}

export const PODCAST_SEARCHES: { term: string; categories: string[] }[] = [
  { term: "daily motivation", categories: ["motivation", "self-improvement"] },
  { term: "mindfulness meditation", categories: ["mindfulness", "health"] },
  { term: "leadership", categories: ["leadership", "business"] },
  { term: "music history", categories: ["music"] },
  { term: "fitness motivation", categories: ["fitness", "health"] },
  { term: "science", categories: ["science"] },
];

interface ItunesResult {
  collectionId: number;
  collectionName: string;
  artistName: string;
  feedUrl?: string;
  artworkUrl600?: string;
  genres?: string[];
  collectionExplicitness?: string;
}

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  textNodeName: "#text",
  removeNSPrefix: false,
});

const asArray = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const textOf = (v: unknown): string | undefined =>
  typeof v === "string"
    ? v
    : typeof v === "number"
      ? String(v)
      : v && typeof v === "object" && "#text" in v
        ? String((v as Record<string, unknown>)["#text"])
        : undefined;

export interface ParsedFeed {
  title: string;
  description: string | null;
  author: string | null;
  image: string | null;
  language: string;
  episodes: {
    guid: string;
    title: string;
    description: string | null;
    url: string;
    mime: string;
    durationMs: number;
    pubDate: Date | null;
    explicit: boolean;
    image: string | null;
    transcriptUrl: string | null;
    chaptersUrl: string | null;
    episodeNumber: number | null;
  }[];
}

export function parseFeed(body: string, maxEpisodes = 10): ParsedFeed {
  const doc = xml.parse(body) as { rss?: { channel?: Record<string, unknown> } };
  const ch = doc.rss?.channel;
  if (!ch) throw new Error("Not an RSS feed");
  const image =
    (ch["itunes:image"] as Record<string, string> | undefined)?.["@href"] ??
    textOf((ch.image as Record<string, unknown> | undefined)?.url) ??
    null;
  const episodes: ParsedFeed["episodes"] = [];
  for (const item of asArray(ch.item as Record<string, unknown> | Record<string, unknown>[])) {
    const enc = asArray(item.enclosure as Record<string, string> | Record<string, string>[])[0];
    if (!enc?.["@url"] || !/^https:\/\//i.test(enc["@url"])) continue;
    const mime = enc["@type"] ?? "audio/mpeg";
    if (!mime.startsWith("audio/")) continue;
    const transcripts = asArray(
      item["podcast:transcript"] as Record<string, string> | Record<string, string>[],
    );
    const tr = transcripts.find((t) => /vtt|srt|subrip/i.test(t["@type"] ?? "")) ?? null;
    const chapters = item["podcast:chapters"] as Record<string, string> | undefined;
    const pub = textOf(item.pubDate);
    const epNum = Number(textOf(item["itunes:episode"]));
    episodes.push({
      guid: textOf(item.guid) ?? enc["@url"],
      title: textOf(item.title) ?? "Untitled episode",
      description: strip(textOf(item["itunes:summary"]) ?? textOf(item.description), 1500),
      url: enc["@url"],
      mime,
      durationMs: parseDurationMs(textOf(item["itunes:duration"])),
      pubDate: pub && !Number.isNaN(Date.parse(pub)) ? new Date(pub) : null,
      explicit: /^(yes|true|explicit)$/i.test(textOf(item["itunes:explicit"]) ?? ""),
      image: (item["itunes:image"] as Record<string, string> | undefined)?.["@href"] ?? null,
      transcriptUrl: tr?.["@url"] ?? null,
      chaptersUrl: chapters?.["@url"] ?? null,
      episodeNumber: Number.isFinite(epNum) && epNum > 0 ? epNum : null,
    });
    if (episodes.length >= maxEpisodes) break;
  }
  return {
    title: textOf(ch.title) ?? "Untitled show",
    description: strip(textOf(ch["itunes:summary"]) ?? textOf(ch.description), 1500),
    author: textOf(ch["itunes:author"]) ?? null,
    image,
    language: (textOf(ch.language) ?? "en").slice(0, 2).toLowerCase(),
    episodes,
  };
}

export async function ingestPodcastFeed(
  db: Db,
  f: FetchLike,
  feedUrl: string,
  hints: { categories: string[]; fallbackArtwork?: string | null; publisher?: string },
  maxEpisodes = 10,
): Promise<{ added: number; skipped: number }> {
  const feed = parseFeed(await getText(f, feedUrl, 25000), maxEpisodes);
  const publisher = feed.author ?? hints.publisher ?? feed.title;
  const creatorId = await upsertCreator(db, publisher, "podcaster", `podcaster:${publisher.toLowerCase()}`);
  const showId = stableUuid(`podcast:${feedUrl}`);
  const artwork = feed.image ?? hints.fallbackArtwork ?? null;
  const isMotivation = hints.categories.some((c) =>
    ["motivation", "self-improvement", "mindfulness", "leadership", "fitness"].includes(c),
  );
  await db.query(
    `INSERT INTO shows (id, title, description, creator_id, artwork_url, language, categories, show_kind, feed_url, source_key, last_ingested_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'podcast',$8,$9, now())
     ON CONFLICT (id) DO UPDATE SET last_ingested_at = now(), artwork_url = COALESCE(EXCLUDED.artwork_url, shows.artwork_url)`,
    [
      showId,
      feed.title.slice(0, 200),
      feed.description,
      creatorId,
      artwork,
      feed.language,
      hints.categories,
      feedUrl,
      `podcast:${feedUrl}`,
    ],
  );
  let added = 0;
  let skipped = 0;
  for (const ep of feed.episodes) {
    const sourceKey = `podcast:${feedUrl}#${ep.guid}`.slice(0, 1000);
    const id = stableUuid(sourceKey);
    const topics = isMotivation ? hints.categories.filter((c) => c !== "self-improvement") : [];
    const ins = await db.query(
      `INSERT INTO audio_assets (id, title, subtitle, description, asset_type, creator_id, show_id, duration_ms, artwork_url,
         streaming_format, mime_type, language, topics, moods, is_explicit, release_date, episode_number, source_key, popularity)
       VALUES ($1,$2,$3,$4,'podcast_episode',$5,$6,$7,$8,'progressive',$9,$10,$11,$12,$13,$14,$15,$16,3) ON CONFLICT (id) DO NOTHING RETURNING id`,
      [
        id,
        ep.title.slice(0, 300),
        feed.title.slice(0, 200),
        ep.description,
        creatorId,
        showId,
        ep.durationMs,
        ep.image ?? artwork,
        ep.mime,
        feed.language,
        topics,
        isMotivation ? ["uplifting"] : [],
        ep.explicit,
        ep.pubDate,
        ep.episodeNumber,
        sourceKey,
      ],
    );
    if (ins.length === 0) {
      skipped++;
      continue;
    }
    await db.query(
      `INSERT INTO asset_storage (asset_id, storage_kind, storage_key, transcript_url, chapters_url) VALUES ($1,'remote',$2,$3,$4) ON CONFLICT DO NOTHING`,
      [id, ep.url, ep.transcriptUrl, ep.chaptersUrl],
    );
    await upsertGrant(db, {
      assetId: id,
      rightsHolder: publisher,
      licenseType: "publisher_feed",
      licenseUrl: feedUrl,
      // Publicly syndicated RSS: listening and personal offline listening only. Never mixing or derivatives.
      allowedUses: ["stream", "offline_download"],
      attributionRequired: true,
      attributionText: `${feed.title} — published by ${publisher}`,
      commercialUse: false,
      proofReference: feedUrl,
    });
    added++;
  }
  return { added, skipped };
}

export async function ingestPodcasts(
  db: Db,
  f: FetchLike,
  opts: { showsPerTerm?: number; episodesPerShow?: number } = {},
): Promise<IngestReport> {
  const report: IngestReport = { source: "podcasts", added: 0, skipped: 0, errors: [] };
  for (const s of PODCAST_SEARCHES) {
    try {
      const res = await getJson<{ results?: ItunesResult[] }>(
        f,
        `https://itunes.apple.com/search?media=podcast&entity=podcast&limit=${(opts.showsPerTerm ?? 2) + 2}&term=${encodeURIComponent(s.term)}`,
      );
      let taken = 0;
      for (const r of res.results ?? []) {
        if (taken >= (opts.showsPerTerm ?? 2)) break;
        if (!r.feedUrl || !/^https:\/\//i.test(r.feedUrl) || r.collectionExplicitness === "explicit")
          continue;
        try {
          const out = await ingestPodcastFeed(
            db,
            f,
            r.feedUrl,
            { categories: s.categories, fallbackArtwork: r.artworkUrl600 ?? null, publisher: r.artistName },
            opts.episodesPerShow ?? 8,
          );
          report.added += out.added;
          report.skipped += out.skipped;
          taken++;
        } catch (e) {
          report.errors.push(`${r.collectionName}: ${(e as Error).message}`);
        }
      }
    } catch (e) {
      report.errors.push(`${s.term}: ${(e as Error).message}`);
    }
  }
  return report;
}

/** Rebuild curated collections from current catalogue state. */
export async function rebuildCollections(db: Db): Promise<void> {
  const defs: { slug: string; title: string; description: string; where: string }[] = [
    {
      slug: "fusion-ready",
      title: "Fusion-Ready Sounds",
      description: "Loops, stems and tracks cleared for mixing in AI Studio.",
      where: `EXISTS (SELECT 1 FROM rights_grants g WHERE g.asset_id = a.id AND g.status='active' AND 'mix' = ANY(g.allowed_uses)) AND a.asset_type IN ('music','loop','stem')`,
    },
    {
      slug: "calm-focus",
      title: "Calm Focus",
      description: "Gentle, open-licence music for deep work.",
      where: `'calm' = ANY(a.moods) AND a.asset_type IN ('music','loop','stem')`,
    },
    {
      slug: "energy-boost",
      title: "Energy Boost",
      description: "Up-tempo, free-to-stream tracks.",
      where: `'energetic' = ANY(a.moods) AND a.asset_type IN ('music','loop')`,
    },
    {
      slug: "cinematic-worlds",
      title: "Cinematic Worlds",
      description: "Soundtrack-style pieces from netlabels.",
      where: `('cinematic' = ANY(a.genres)) AND a.asset_type IN ('music','loop','stem')`,
    },
    {
      slug: "timeless-wisdom",
      title: "Timeless Wisdom",
      description: "Public-domain motivational classics read aloud.",
      where: `a.asset_type = 'speech'`,
    },
  ];
  for (const d of defs) {
    const id = stableUuid(`collection:${d.slug}`);
    await db.query(
      `INSERT INTO collections (id, slug, title, description) VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description`,
      [id, d.slug, d.title, d.description],
    );
    await db.query(`DELETE FROM collection_items WHERE collection_id = $1`, [id]);
    await db.query(
      `INSERT INTO collection_items (collection_id, asset_id, position)
       SELECT $1, a.id, (row_number() OVER (ORDER BY a.popularity DESC, a.title))::int - 1 FROM audio_assets a
       WHERE a.is_active AND ${d.where} ORDER BY a.popularity DESC, a.title LIMIT 40`,
      [id],
    );
  }
}

export async function recordRun(db: Db, r: IngestReport): Promise<void> {
  await db.query(
    `INSERT INTO ingestion_runs (id, source, status, added, skipped, error, finished_at) VALUES ($1,$2,$3,$4,$5,$6, now())`,
    [
      uuid(),
      r.source,
      r.errors.length ? "completed_with_errors" : "completed",
      r.added,
      r.skipped,
      r.errors.slice(0, 20).join("\n") || null,
    ],
  );
}
