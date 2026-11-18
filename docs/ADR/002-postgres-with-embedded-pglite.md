# ADR-002: PostgreSQL everywhere, PGlite for development
**Decision.** All SQL targets PostgreSQL (tsvector, GIN, arrays, jsonb). Without `DATABASE_URL` the server uses PGlite (Postgres compiled
to WASM) persisted in `backend/.data/`; tests use in-memory PGlite. **Why.** Same SQL in dev, CI and prod; no Docker requirement.
**Consequences.** PGlite is single-connection; transactions are serialized in dev only. Production uses `pg` Pool.
