import type { AppDeps } from "../common/context.js";
import {
  ingestInternetArchiveMusic,
  ingestLibriVoxSpeeches,
  ingestPodcasts,
  rebuildCollections,
  recordRun,
  type IngestReport,
} from "./sources.js";

export type IngestSource = "internet_archive_music" | "librivox" | "podcasts";

let running: Promise<IngestReport[]> | null = null;

/** Runs ingestion (single-flight). Each source is independent; one failing doesn't stop the others. */
export function runIngestion(
  deps: Pick<AppDeps, "db" | "fetch">,
  sources: IngestSource[] = ["internet_archive_music", "librivox", "podcasts"],
): Promise<IngestReport[]> {
  if (running) return running;
  running = (async () => {
    const reports: IngestReport[] = [];
    for (const s of sources) {
      const r =
        s === "internet_archive_music"
          ? await ingestInternetArchiveMusic(deps.db, deps.fetch)
          : s === "librivox"
            ? await ingestLibriVoxSpeeches(deps.db, deps.fetch)
            : await ingestPodcasts(deps.db, deps.fetch);
      await recordRun(deps.db, r);
      reports.push(r);
    }
    await rebuildCollections(deps.db);
    return reports;
  })().finally(() => {
    running = null;
  });
  return running;
}
