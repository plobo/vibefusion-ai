import { loadConfig } from "../config.js";
import { createPgDb, createPgliteDb, migrate } from "../db/db.js";
import { defaultFetch } from "./http.js";
import { runIngestion, type IngestSource } from "./run.js";
import { seedSynthetic } from "./synthetic.js";

const config = loadConfig();
const db = config.databaseUrl ? await createPgDb(config.databaseUrl) : await createPgliteDb(config.pgliteDir);
await migrate(db);
await seedSynthetic(db);
const args = process.argv.slice(2) as IngestSource[];
const reports = await runIngestion({ db, fetch: defaultFetch }, args.length ? args : undefined);
for (const r of reports) {
  console.log(`${r.source}: added ${r.added}, skipped ${r.skipped}, errors ${r.errors.length}`);
  for (const e of r.errors.slice(0, 5)) console.log(`  - ${e}`);
}
await db.close();
