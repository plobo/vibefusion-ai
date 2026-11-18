# Rights & content policy

## Principles
* **Fail closed.** No active, in-window, territory-matching grant that lists the use ⇒ denied (`rights/policy.ts`).
* Rights are checked at ingestion **and** at every authorization: playback authorize, every media fetch, preview, recipe playback,
  render and share. Revocation/takedown blocks new authorizations immediately (Scenario G).
* Private proof references and storage locations are never returned to listener clients (admin API only).

## Licence mapping at ingestion

| Licence URL | Type | Allowed uses | Attribution |
|---|---|---|---|
| CC BY, CC BY-SA | `creative_commons` | stream, offline_download, mix, derivative_render | required (shown on detail, player, exports) |
| CC BY-ND | `creative_commons` | stream, offline_download | required |
| CC0, PD Mark, `licenses/publicdomain` | `public_domain_verified` | all | optional |
| Any NonCommercial (NC) licence, unknown licences | — | **not ingested** | — |
| Podcast RSS enclosure | `publisher_feed` | stream, offline_download (personal) | publisher + show |
| Synthetic Sound Lab | `owned` | all (fixture `stream-only` is deliberately stream-only for Scenario D) | — |

`grant.valid_from` defaults to 2000-01-01 for open licences (they apply from publication). Grants are never silently
overwritten by re-ingestion (an admin revocation must stick).

## Operational controls
* Admin: add grants, set status (`active|revoked|under_review|expired`), takedown (deactivates asset + revokes grants), restore
  (asset only — grants stay revoked until re-verified), audit log of every change.
* Recipe playback policy on revoked layers: `block_layer` (default, plays the rest and explains) or `block_recipe`
  (`FUSION_REVOKED_POLICY`).
* Export: requires `derivative_render` for every layer; attribution text is written next to the exported file. Exports stay
  on the device; public sharing shares **recipes only**, and listeners re-authorize every layer under their own rights checks.
* Voice: no voice cloning. Speech layers come only from public-domain or openly published recordings.

## Privacy & retention
* Analytics: allow-listed event names and properties only; pseudonymous HMAC id; no prompts, transcripts, emails or URLs;
  opt-out honoured server-side. Retention 90 days (`POST /v1/admin/retention`).
* Prompts are stored only with recipes the user saves; plans are sent to an LLM only when `ANTHROPIC_API_KEY` is configured,
  and only catalogue metadata (never user data or audio) accompanies the prompt. Disclosure is shown in AI Studio and Profile.
* Account deletion purges likes, follows, progress, bookmarks, playlists, recipes, preferences and AI usage, tombstones the
  account and revokes sessions. Data export returns everything stored about the user.
* Before public launch: Canadian privacy review (PIPEDA / Québec Law 25) and legal review of each source's terms.
