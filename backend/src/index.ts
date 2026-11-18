import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { runIngestion } from "./ingestion/run.js";

const config = loadConfig();
const { app, deps } = await buildApp({ config });

const assetCount =
  (await deps.db.one<{ n: number }>(`SELECT count(*)::int AS n FROM audio_assets WHERE NOT is_dev_fixture`))
    ?.n ?? 0;
if (config.ingestOnStart && assetCount === 0) {
  app.log.info("Catalogue empty: ingesting free/open-licence content in the background");
  void runIngestion(deps)
    .then((r) =>
      app.log.info(
        {
          reports: r.map((x) => ({
            source: x.source,
            added: x.added,
            skipped: x.skipped,
            errors: x.errors.length,
          })),
        },
        "ingestion finished",
      ),
    )
    .catch((e) => app.log.error({ err: e }, "ingestion failed"));
}

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "shutting down");
  await app.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

await app.listen({ port: config.port, host: config.host });
