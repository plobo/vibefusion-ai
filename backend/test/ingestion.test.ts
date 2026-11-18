import { describe, expect, it } from "vitest";
import { createPgliteDb, migrate } from "../src/db/db.js";
import { ingestInternetArchiveMusic, ingestPodcastFeed, parseFeed } from "../src/ingestion/sources.js";
import { parseCaptions } from "../src/transcripts/parse.js";
import { parseDurationMs, type FetchLike } from "../src/ingestion/http.js";
import { grantsFor } from "../src/rights/repo.js";
import { toPrefixTsQuery } from "../src/search/routes.js";
import { toStructuredOutputSchema } from "../src/fusion/planner/anthropic.js";
import { mixPlanSchema } from "../src/fusion/validator.js";
import { compatibleKeys } from "../src/fusion/harmony.js";

const RSS = `<?xml version="1.0"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:podcast="https://podcastindex.org/namespace/1.0">
<channel><title>Daily Lift</title><description>Short pep talks</description><itunes:author>Lift Media</itunes:author>
<itunes:image href="https://img.example/show.jpg"/><language>en-us</language>
<item><title>Episode 2: Grit</title><guid>ep-2</guid><enclosure url="https://cdn.example/ep2.mp3" type="audio/mpeg" length="1"/>
<itunes:duration>12:30</itunes:duration><pubDate>Mon, 02 Nov 2026 08:00:00 GMT</pubDate><itunes:episode>2</itunes:episode>
<podcast:transcript url="https://cdn.example/ep2.vtt" type="text/vtt"/><description><![CDATA[<p>About <b>grit</b></p>]]></description></item>
<item><title>Insecure</title><guid>ep-x</guid><enclosure url="http://cdn.example/x.mp3" type="audio/mpeg"/></item>
<item><title>Video</title><guid>ep-v</guid><enclosure url="https://cdn.example/v.mp4" type="video/mp4"/></item>
</channel></rss>`;

const json = (data: unknown) => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify(data),
  json: async () => data,
});

describe("parsers", () => {
  it("parses RSS and skips insecure or non-audio enclosures", () => {
    const f = parseFeed(RSS);
    expect(f.title).toBe("Daily Lift");
    expect(f.image).toBe("https://img.example/show.jpg");
    expect(f.episodes).toHaveLength(1);
    expect(f.episodes[0]).toMatchObject({
      title: "Episode 2: Grit",
      durationMs: 750000,
      transcriptUrl: "https://cdn.example/ep2.vtt",
      episodeNumber: 2,
      description: "About grit",
    });
  });
  it("parses VTT and SRT captions", () => {
    const vtt =
      "WEBVTT\n\n00:00:01.000 --> 00:00:04.500\n<v Host>Keep moving forward.\n\n00:00:05.000 --> 00:00:07.000\nAnother line";
    expect(parseCaptions(vtt)).toEqual([
      { startMs: 1000, endMs: 4500, text: "Keep moving forward.", speaker: "Host" },
      { startMs: 5000, endMs: 7000, text: "Another line", speaker: null },
    ]);
    const srt = "1\n00:00:01,000 --> 00:00:02,000\nSPEAKER: Hello\n";
    expect(parseCaptions(srt)[0]).toEqual({ startMs: 1000, endMs: 2000, text: "Hello", speaker: "SPEAKER" });
  });
  it("parses durations", () => {
    expect(parseDurationMs("420.24")).toBe(420240);
    expect(parseDurationMs("07:00")).toBe(420000);
    expect(parseDurationMs("1:02:03")).toBe(3723000);
    expect(parseDurationMs("junk")).toBe(0);
  });
  it("builds safe prefix tsqueries", () => {
    expect(toPrefixTsQuery("calm  piano!")).toBe("calm:* & piano:*");
    expect(toPrefixTsQuery("') | (drop")).toBe("drop:*");
    expect(toPrefixTsQuery("***")).toBeNull();
  });
  it("derives a structured-output schema without bounds", () => {
    const s = JSON.stringify(toStructuredOutputSchema(mixPlanSchema));
    expect(s).not.toContain("minimum");
    expect(s).not.toContain("$ref");
    expect(s).toContain('"additionalProperties":false');
  });
  it("Camelot compatibility", () => {
    expect(compatibleKeys("Am").sort()).toEqual(["Am", "C", "Dm", "Em"].sort());
  });
});

describe("ingestion", () => {
  it("ingests CC music with derived rights and skips NonCommercial", async () => {
    const db = await createPgliteDb();
    await migrate(db);
    const fetchMock: FetchLike = async (url) => {
      if (url.includes("advancedsearch")) {
        if (!url.includes("ambient")) return json({ response: { docs: [] } });
        return json({
          response: {
            docs: [
              {
                identifier: "byitem",
                title: "BY Album",
                creator: "Artist One",
                subject: ["ambient", "chill"],
                licenseurl: "http://creativecommons.org/licenses/by/3.0/",
              },
              {
                identifier: "nditem",
                title: "ND Album",
                creator: "Artist Two",
                subject: ["ambient"],
                licenseurl: "http://creativecommons.org/licenses/by-nd/3.0/",
              },
              {
                identifier: "ncitem",
                title: "NC Album",
                creator: "Artist Three",
                licenseurl: "http://creativecommons.org/licenses/by-nc/3.0/",
              },
            ],
          },
        });
      }
      if (url.includes("/metadata/")) {
        return json({
          metadata: {},
          files: [
            {
              name: "01 track.mp3",
              format: "VBR MP3",
              length: "185.2",
              title: "Track One",
              source: "original",
            },
            { name: "01 track_64kb.mp3", length: "185" },
          ],
        });
      }
      throw new Error("unexpected " + url);
    };
    const r = await ingestInternetArchiveMusic(db, fetchMock, { itemsPerGenre: 3 });
    expect(r.added).toBe(2);
    expect(r.skipped).toBe(1);
    const rows = await db.query<{ id: string; title: string }>(
      `SELECT id, title FROM audio_assets ORDER BY title`,
    );
    const grants = await grantsFor(
      db,
      rows.map((x) => x.id),
    );
    const uses = rows.map((x) => grants.get(x.id)![0]!.allowedUses);
    expect(uses).toContainEqual(["stream", "offline_download", "mix", "derivative_render"]);
    expect(uses).toContainEqual(["stream", "offline_download"]);
    const again = await ingestInternetArchiveMusic(db, fetchMock, { itemsPerGenre: 3 });
    expect(again.added).toBe(0); // idempotent
    await db.close();
  });

  it("ingests podcast feeds as stream-only (never mixable)", async () => {
    const db = await createPgliteDb();
    await migrate(db);
    const out = await ingestPodcastFeed(
      db,
      async () => ({ ok: true, status: 200, text: async () => RSS, json: async () => ({}) }),
      "https://feeds.example/lift.xml",
      { categories: ["motivation"] },
    );
    expect(out.added).toBe(1);
    const [a] = await db.query<{ id: string; topics: string[] }>(`SELECT id, topics FROM audio_assets`);
    const g = (await grantsFor(db, [a!.id])).get(a!.id)![0]!;
    expect(g.allowedUses).toEqual(["stream", "offline_download"]);
    expect(g.licenseType).toBe("publisher_feed");
    expect(a!.topics).toEqual(["motivation"]);
    await db.close();
  });
});
