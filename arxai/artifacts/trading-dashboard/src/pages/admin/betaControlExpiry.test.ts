import { describe, it, expect } from "vitest";
import {
  getExpiryIndicator,
  isExpiringSoon,
  compareByExpiry,
  EXPIRES_SOON_DAYS,
} from "./betaControlExpiry";

const NOW = Date.parse("2026-06-22T00:00:00.000Z");
const inDays = (n: number) => new Date(NOW + n * 24 * 60 * 60 * 1000).toISOString();

describe("getExpiryIndicator", () => {
  it("marks a null expiry as non-expiring", () => {
    expect(getExpiryIndicator(null, "PENDING", NOW)).toEqual({ kind: "no-expiry" });
    expect(getExpiryIndicator(undefined, "PENDING", NOW)).toEqual({ kind: "no-expiry" });
  });

  it("treats a malformed date as non-expiring rather than crashing", () => {
    expect(getExpiryIndicator("not-a-date", "PENDING", NOW)).toEqual({ kind: "no-expiry" });
  });

  it("shows only a plain date for non-PENDING keys", () => {
    const ind = getExpiryIndicator(inDays(3), "ACCEPTED", NOW);
    expect(ind.kind).toBe("not-applicable");
    if (ind.kind === "not-applicable") expect(ind.dateLabel).toBe("2026-06-25");
  });

  it("flags a lapsed PENDING key as expired", () => {
    const ind = getExpiryIndicator(inDays(-1), "PENDING", NOW);
    expect(ind.kind).toBe("expired");
    if (ind.kind === "expired") {
      expect(ind.relativeLabel).toBe("Expired");
      expect(ind.tone).toBe("danger");
    }
  });

  it("counts whole days remaining and renders a relative label", () => {
    const ind = getExpiryIndicator(inDays(5), "PENDING", NOW);
    expect(ind.kind).toBe("active");
    if (ind.kind === "active") {
      expect(ind.daysLeft).toBe(5);
      expect(ind.relativeLabel).toBe("in 5 days");
      expect(ind.soon).toBe(true);
      expect(ind.tone).toBe("warning");
    }
  });

  it("uses 'in 1 day' for the nearest future expiry and danger tone", () => {
    const ind = getExpiryIndicator(inDays(1), "PENDING", NOW);
    expect(ind.kind).toBe("active");
    if (ind.kind === "active") {
      expect(ind.relativeLabel).toBe("in 1 day");
      expect(ind.tone).toBe("danger");
      expect(ind.soon).toBe(true);
    }
  });

  it("treats keys beyond the soon window as neutral, non-soon", () => {
    const ind = getExpiryIndicator(inDays(EXPIRES_SOON_DAYS + 5), "PENDING", NOW);
    expect(ind.kind).toBe("active");
    if (ind.kind === "active") {
      expect(ind.soon).toBe(false);
      expect(ind.tone).toBe("neutral");
    }
  });
});

describe("isExpiringSoon", () => {
  it("is true only for PENDING keys inside the soon window", () => {
    expect(isExpiringSoon(inDays(3), "PENDING", NOW)).toBe(true);
    expect(isExpiringSoon(inDays(EXPIRES_SOON_DAYS + 1), "PENDING", NOW)).toBe(false);
    expect(isExpiringSoon(inDays(3), "ACCEPTED", NOW)).toBe(false);
    expect(isExpiringSoon(null, "PENDING", NOW)).toBe(false);
    expect(isExpiringSoon(inDays(-1), "PENDING", NOW)).toBe(false);
  });
});

describe("compareByExpiry", () => {
  it("orders PENDING keys soonest-first, with no-expiry and non-PENDING last", () => {
    const rows = [
      { id: "noexp", expiresAt: null, status: "PENDING" },
      { id: "far", expiresAt: inDays(30), status: "PENDING" },
      { id: "accepted", expiresAt: inDays(1), status: "ACCEPTED" },
      { id: "near", expiresAt: inDays(2), status: "PENDING" },
    ];
    const order = [...rows].sort(compareByExpiry).map((r) => r.id);
    expect(order.slice(0, 2)).toEqual(["near", "far"]);
    expect(order.slice(2)).toEqual(expect.arrayContaining(["noexp", "accepted"]));
  });
});
