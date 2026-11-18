import { describe, expect, it } from "vitest";
import { capabilities, evaluate, usesForLicenseUrl, type GrantRecord } from "../src/rights/policy.js";

const now = new Date("2026-06-01T00:00:00Z");
const grant = (over: Partial<GrantRecord> = {}): GrantRecord => ({
  id: "g1",
  assetId: "a1",
  status: "active",
  validFrom: new Date("2026-01-01T00:00:00Z"),
  validUntil: null,
  territories: ["CA", "US"],
  allowedUses: ["stream", "mix"],
  licenseType: "direct_license",
  attributionRequired: false,
  attributionText: null,
  rightsHolder: "Holder",
  licenseUrl: null,
  commercialUse: true,
  ...over,
});

describe("rights policy", () => {
  it("fails closed with no grants", () => {
    expect(evaluate([], "stream", "CA", now)).toEqual({ allowed: false, reason: "NO_RIGHTS_RECORD" });
  });
  it("allows a listed use in a covered territory", () => {
    expect(evaluate([grant()], "mix", "CA", now).allowed).toBe(true);
  });
  it("denies an unlisted use", () => {
    expect(evaluate([grant()], "derivative_render", "CA", now)).toEqual({
      allowed: false,
      reason: "USE_NOT_LICENSED",
    });
  });
  it("denies uncovered territories but honours wildcard", () => {
    expect(evaluate([grant()], "stream", "FR", now)).toEqual({
      allowed: false,
      reason: "TERRITORY_NOT_LICENSED",
    });
    expect(evaluate([grant({ territories: ["*"] })], "stream", "FR", now).allowed).toBe(true);
  });
  it("respects validity windows", () => {
    expect(evaluate([grant({ validUntil: new Date("2026-05-31T00:00:00Z") })], "stream", "CA", now)).toEqual({
      allowed: false,
      reason: "RIGHTS_EXPIRED",
    });
    expect(
      evaluate([grant({ validFrom: new Date("2026-07-01T00:00:00Z") })], "stream", "CA", now).allowed,
    ).toBe(false);
  });
  it("revoked and under-review grants block immediately", () => {
    expect(evaluate([grant({ status: "revoked" })], "stream", "CA", now)).toEqual({
      allowed: false,
      reason: "RIGHTS_REVOKED",
    });
    expect(evaluate([grant({ status: "under_review" })], "stream", "CA", now)).toEqual({
      allowed: false,
      reason: "RIGHTS_UNDER_REVIEW",
    });
  });
  it("any one valid grant suffices", () => {
    expect(
      evaluate(
        [grant({ status: "revoked" }), grant({ id: "g2", allowedUses: ["stream"] })],
        "stream",
        "CA",
        now,
      ).allowed,
    ).toBe(true);
  });
  it("computes capability flags", () => {
    expect(capabilities([grant()], "CA", now)).toEqual({
      stream: true,
      download: false,
      mix: true,
      render: false,
    });
  });
});

describe("licence mapping", () => {
  it("maps CC BY and BY-SA to full use with attribution", () => {
    expect(usesForLicenseUrl("http://creativecommons.org/licenses/by/3.0/")).toMatchObject({
      attribution: true,
      uses: ["stream", "offline_download", "mix", "derivative_render"],
    });
    expect(usesForLicenseUrl("https://creativecommons.org/licenses/by-sa/4.0/")?.uses).toContain("mix");
  });
  it("maps ND to stream/download only", () => {
    expect(usesForLicenseUrl("http://creativecommons.org/licenses/by-nd/3.0/")?.uses).toEqual([
      "stream",
      "offline_download",
    ]);
  });
  it("rejects NonCommercial and unknown licences", () => {
    expect(usesForLicenseUrl("http://creativecommons.org/licenses/by-nc/3.0/")).toBeNull();
    expect(usesForLicenseUrl("http://creativecommons.org/licenses/by-nc-sa/4.0/")).toBeNull();
    expect(usesForLicenseUrl("https://example.com/license")).toBeNull();
    expect(usesForLicenseUrl(undefined)).toBeNull();
  });
  it("maps public domain marks", () => {
    expect(usesForLicenseUrl("http://creativecommons.org/publicdomain/zero/1.0/")?.licenseType).toBe(
      "public_domain_verified",
    );
    expect(usesForLicenseUrl("http://creativecommons.org/licenses/publicdomain/")?.licenseType).toBe(
      "public_domain_verified",
    );
  });
});
