import type { Db } from "../db/db.js";
import { uuid } from "../common/ids.js";
import type { GrantRecord, RightsUse } from "./policy.js";

interface GrantRow {
  id: string;
  asset_id: string;
  status: GrantRecord["status"];
  valid_from: Date | string;
  valid_until: Date | string | null;
  territories: string[];
  allowed_uses: string[];
  license_type: string;
  attribution_required: boolean;
  attribution_text: string | null;
  rights_holder: string;
  license_url: string | null;
  commercial_use: boolean;
}

const toDate = (v: Date | string) => (v instanceof Date ? v : new Date(v));

function mapGrant(r: GrantRow): GrantRecord {
  return {
    id: r.id,
    assetId: r.asset_id,
    status: r.status,
    validFrom: toDate(r.valid_from),
    validUntil: r.valid_until ? toDate(r.valid_until) : null,
    territories: r.territories,
    allowedUses: r.allowed_uses,
    licenseType: r.license_type,
    attributionRequired: r.attribution_required,
    attributionText: r.attribution_text,
    rightsHolder: r.rights_holder,
    licenseUrl: r.license_url,
    commercialUse: r.commercial_use,
  };
}

export async function grantsFor(db: Db, assetIds: string[]): Promise<Map<string, GrantRecord[]>> {
  const map = new Map<string, GrantRecord[]>();
  if (assetIds.length === 0) return map;
  const rows = await db.query<GrantRow>(`SELECT * FROM rights_grants WHERE asset_id = ANY($1::uuid[])`, [
    assetIds,
  ]);
  for (const r of rows) {
    const g = mapGrant(r);
    const list = map.get(g.assetId) ?? [];
    list.push(g);
    map.set(g.assetId, list);
  }
  return map;
}

export interface NewGrant {
  assetId: string;
  rightsHolder: string;
  licenseType: string;
  licenseUrl?: string | null;
  territories?: string[];
  allowedUses: RightsUse[];
  attributionRequired: boolean;
  attributionText?: string | null;
  commercialUse: boolean;
  proofReference: string;
  status?: GrantRecord["status"];
  validUntil?: Date | null;
  /** Defaults to 2000-01-01: open licences and owned audio apply from publication, not ingestion time. */
  validFrom?: Date;
}

export async function upsertGrant(db: Db, g: NewGrant): Promise<void> {
  const existing = await db.one<{ id: string }>(
    `SELECT id FROM rights_grants WHERE asset_id = $1 AND proof_reference = $2`,
    [g.assetId, g.proofReference],
  );
  if (existing) return; // Never silently overwrite a grant (it may have been revoked by an admin).
  await db.query(
    `INSERT INTO rights_grants (id, asset_id, rights_holder, license_type, license_url, territories, allowed_uses,
       commercial_use, attribution_required, attribution_text, proof_reference, status, valid_until, valid_from)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [
      uuid(),
      g.assetId,
      g.rightsHolder,
      g.licenseType,
      g.licenseUrl ?? null,
      g.territories ?? ["*"],
      g.allowedUses,
      g.commercialUse,
      g.attributionRequired,
      g.attributionText ?? null,
      g.proofReference,
      g.status ?? "active",
      g.validUntil ?? null,
      g.validFrom ?? new Date("2000-01-01T00:00:00Z"),
    ],
  );
}
