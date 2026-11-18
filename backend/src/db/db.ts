import fs from "node:fs";
import path from "node:path";
import { BACKEND_ROOT } from "../config.js";

export type Row = Record<string, unknown>;

/** Minimal database port. Both drivers speak real PostgreSQL SQL. */
export interface Db {
  query<T = Row>(sql: string, params?: unknown[]): Promise<T[]>;
  one<T = Row>(sql: string, params?: unknown[]): Promise<T | undefined>;
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

interface Queryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}

function wrap(q: Queryable, txImpl: Db["tx"], execImpl: Db["exec"], close: Db["close"]): Db {
  const db: Db = {
    async query<T>(sql: string, params: unknown[] = []) {
      const res = await q.query(sql, params);
      return res.rows as T[];
    },
    async one<T>(sql: string, params: unknown[] = []) {
      const res = await q.query(sql, params);
      return res.rows[0] as T | undefined;
    },
    tx: txImpl,
    exec: execImpl,
    close,
  };
  return db;
}

export async function createPgliteDb(dataDir?: string): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  if (dataDir) fs.mkdirSync(dataDir, { recursive: true });
  const pg = dataDir ? new PGlite(dataDir) : new PGlite();
  await pg.waitReady;
  // PGlite is single-connection; serialize transactions to keep them isolated.
  let chain: Promise<unknown> = Promise.resolve();
  const self: Db = wrap(
    pg,
    async (fn) => {
      const run = chain.then(() =>
        pg.transaction(async (t) => {
          const inner: Db = wrap(
            t,
            (f) => f(inner),
            async (s) => void (await t.exec(s)),
            async () => {},
          );
          return fn(inner);
        }),
      );
      chain = run.catch(() => undefined);
      return run;
    },
    async (sql) => void (await pg.exec(sql)),
    async () => pg.close(),
  );
  return self;
}

export async function createPgDb(url: string): Promise<Db> {
  const pgMod = await import("pg");
  const pool = new pgMod.default.Pool({ connectionString: url, max: 10 });
  const db: Db = wrap(
    pool,
    async (fn) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const inner = wrap(
          client,
          (f) => f(inner),
          async (s) => void (await client.query(s)),
          async () => {},
        );
        const result = await fn(inner);
        await client.query("COMMIT");
        return result;
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }
    },
    async (sql) => void (await pool.query(sql)),
    async () => pool.end(),
  );
  return db;
}

export async function migrate(db: Db): Promise<void> {
  await db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
  );
  const dir = path.join(BACKEND_ROOT, "migrations");
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const done = await db.one(`SELECT name FROM schema_migrations WHERE name = $1`, [file]);
    if (done) continue;
    await db.exec(fs.readFileSync(path.join(dir, file), "utf8"));
    await db.query(`INSERT INTO schema_migrations (name) VALUES ($1)`, [file]);
  }
}
