# Deployment notes

* Build: `docker build -f infrastructure/docker/Dockerfile.backend .` (repo root context — the backend reads `contracts/`).
* Required secrets (from a managed secret store, never in images): `JWT_SECRET`, `MEDIA_SIGNING_SECRET`, `DATABASE_URL`,
  optional `ANTHROPIC_API_KEY`, `SUPABASE_JWT_SECRET`. The server refuses to start in production without the first two.
* Run behind TLS (load balancer / CDN). Set `PUBLIC_BASE_URL` to the public HTTPS origin so signed media URLs are correct.
* `MEDIA_DELIVERY=proxy` streams third-party media through the API (hides origins, costs bandwidth); default `redirect`.
* Health: `/healthz` (liveness), `/readyz` (DB). Metrics: `/metrics` (Prometheus) — scrape and alert on `http_errors_total`,
  `playback_failures_total`, `signed_url_failures_total`, `rights_validation_failures_total`, `ai_provider_errors_total`,
  `fusion_plan_rejected_total`, p95 of `http_request_duration_ms` and `stream_start_latency_ms`. See `infrastructure/ci/alerts.yml`.
* Schedule `POST /v1/admin/retention` daily (admin token) and `POST /v1/admin/ingest` weekly to refresh podcast feeds.
