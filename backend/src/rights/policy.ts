/**
 * Rights policy engine. Pure functions; every decision fails closed.
 * A use is permitted only when at least one grant is active, inside its validity window,
 * covers the territory, and lists the use explicitly.
 */
export type RightsUse = "stream" | "offline_download" | "mix" | "derivative_render";
export const ALL_USES: RightsUse[] = ["stream", "offline_download", "mix", "derivative_render"];

export interface GrantRecord {
  id: string;
  assetId: string;
  status: "active" | "expired" | "revoked" | "under_review";
  validFrom: Date;
  validUntil: Date | null;
  territories: string[];
  allowedUses: string[];
  licenseType: string;
  attributionRequired: boolean;
  attributionText: string | null;
  rightsHolder: string;
  licenseUrl: string | null;
  commercialUse: boolean;
}

export type DenyReason =
  | "NO_RIGHTS_RECORD"
  | "RIGHTS_REVOKED"
  | "RIGHTS_EXPIRED"
  | "RIGHTS_UNDER_REVIEW"
  | "TERRITORY_NOT_LICENSED"
  | "USE_NOT_LICENSED";

export type Decision = { allowed: true; grant: GrantRecord } | { allowed: false; reason: DenyReason };

const covers = (g: GrantRecord, territory: string) =>
  g.territories.includes("*") || g.territories.includes(territory.toUpperCase());

export function evaluate(grants: GrantRecord[], use: RightsUse, territory: string, now: Date): Decision {
  if (grants.length === 0) return { allowed: false, reason: "NO_RIGHTS_RECORD" };
  let reason: DenyReason = "NO_RIGHTS_RECORD";
  // Report the most specific reason across grants (order of precedence below).
  const rank: Record<DenyReason, number> = {
    NO_RIGHTS_RECORD: 0,
    RIGHTS_REVOKED: 1,
    RIGHTS_UNDER_REVIEW: 2,
    RIGHTS_EXPIRED: 3,
    TERRITORY_NOT_LICENSED: 4,
    USE_NOT_LICENSED: 5,
  };
  const bump = (r: DenyReason) => {
    if (rank[r] > rank[reason]) reason = r;
  };
  for (const g of grants) {
    if (g.status === "revoked") {
      bump("RIGHTS_REVOKED");
      continue;
    }
    if (g.status === "under_review") {
      bump("RIGHTS_UNDER_REVIEW");
      continue;
    }
    if (g.status === "expired" || (g.validUntil && g.validUntil.getTime() <= now.getTime())) {
      bump("RIGHTS_EXPIRED");
      continue;
    }
    if (g.validFrom.getTime() > now.getTime()) {
      bump("RIGHTS_EXPIRED");
      continue;
    }
    if (!covers(g, territory)) {
      bump("TERRITORY_NOT_LICENSED");
      continue;
    }
    if (!g.allowedUses.includes(use)) {
      bump("USE_NOT_LICENSED");
      continue;
    }
    return { allowed: true, grant: g };
  }
  return { allowed: false, reason };
}

export interface Capabilities {
  stream: boolean;
  download: boolean;
  mix: boolean;
  render: boolean;
}

export function capabilities(grants: GrantRecord[], territory: string, now: Date): Capabilities {
  return {
    stream: evaluate(grants, "stream", territory, now).allowed,
    download: evaluate(grants, "offline_download", territory, now).allowed,
    mix: evaluate(grants, "mix", territory, now).allowed,
    render: evaluate(grants, "derivative_render", territory, now).allowed,
  };
}

export const DENY_MESSAGES: Record<DenyReason, string> = {
  NO_RIGHTS_RECORD: "This audio has no verified rights record and cannot be used.",
  RIGHTS_REVOKED: "The rights for this audio have been revoked.",
  RIGHTS_EXPIRED: "The licence for this audio is not currently valid.",
  RIGHTS_UNDER_REVIEW: "This audio is under rights review and temporarily unavailable.",
  TERRITORY_NOT_LICENSED: "This audio is not available in your region.",
  USE_NOT_LICENSED: "This audio is not licensed for this use.",
};

export function useMessage(use: RightsUse, reason: DenyReason): string {
  if (reason === "USE_NOT_LICENSED") {
    switch (use) {
      case "mix":
        return "This audio is streamable but not cleared for remixing in Fusion Studio.";
      case "derivative_render":
        return "Export is unavailable: at least one layer is not licensed for rendered derivatives.";
      case "offline_download":
        return "Downloads are not permitted for this audio.";
      default:
        return DENY_MESSAGES[reason];
    }
  }
  return DENY_MESSAGES[reason];
}

/**
 * Map a Creative Commons / public-domain licence URL to allowed uses.
 * Returns null for licences we refuse to ingest (e.g. NonCommercial, unknown).
 */
export function usesForLicenseUrl(url: string | undefined | null): {
  licenseType: "creative_commons" | "public_domain_verified";
  uses: RightsUse[];
  attribution: boolean;
  commercial: boolean;
} | null {
  if (!url) return null;
  const u = url.toLowerCase();
  if (u.includes("/publicdomain/") || u.includes("/licenses/publicdomain")) {
    return {
      licenseType: "public_domain_verified",
      uses: [...ALL_USES],
      attribution: false,
      commercial: true,
    };
  }
  const m = u.match(/creativecommons\.org\/licenses\/([a-z-]+)\//);
  if (!m) return null;
  const code = m[1]!;
  if (code.includes("nc")) return null; // NonCommercial: excluded from the catalogue (fail closed).
  if (code === "by" || code === "by-sa") {
    return { licenseType: "creative_commons", uses: [...ALL_USES], attribution: true, commercial: true };
  }
  if (code === "by-nd") {
    // NoDerivatives: verbatim streaming/download only, never mixing or rendering.
    return {
      licenseType: "creative_commons",
      uses: ["stream", "offline_download"],
      attribution: true,
      commercial: true,
    };
  }
  return null;
}
