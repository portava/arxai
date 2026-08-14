import { describe, it, expect } from "vitest";
import { isNormalUserAllowedPath, isInvestorAllowedPath } from "./routeAccess";

/**
 * #6 — Admin/owner emergency controls live ONLY in the admin surface.
 *
 * The kill-switch / emergency-close trading controls render on admin pages
 * under `/admin/*` (e.g. `/admin/trading-control`). RouteAccessGuard.test.tsx
 * already proves a non-admin who navigates to an `/admin/*` URL gets the locked
 * card instead of the page. This test locks the complementary half of the
 * containment contract at the allowlist layer: those admin emergency surfaces
 * are NOT on the normal-user allowlist and NOT on the investor allowlist, so a
 * trader/USER or an INVESTOR is redirected away rather than ever reaching the
 * emergency-close UI. (Backend `requireAdmin` on the emergency endpoints stays
 * the real authority.)
 */

const ADMIN_EMERGENCY_SURFACES = [
  "/admin/trading-control",
  "/admin/one-click-controls",
  "/admin",
];

describe("#6 admin emergency-close surface containment", () => {
  it("no admin emergency/live-control surface is allowed for a normal trader", () => {
    for (const path of ADMIN_EMERGENCY_SURFACES) {
      expect(isNormalUserAllowedPath(path), `trader must NOT reach ${path}`).toBe(false);
    }
  });

  it("no admin emergency/live-control surface is allowed for an investor", () => {
    for (const path of ADMIN_EMERGENCY_SURFACES) {
      expect(isInvestorAllowedPath(path), `investor must NOT reach ${path}`).toBe(false);
    }
  });

  it("guards against a vacuous pass — a real product surface IS allowed for a trader", () => {
    // If the allowlist ever collapsed to deny-everything these would also be
    // false, masking a regression. A normal trader legitimately reaches the
    // trade room and scanner.
    expect(isNormalUserAllowedPath("/trade-command-room")).toBe(true);
    expect(isNormalUserAllowedPath("/market-scanner")).toBe(true);
    // …and the investor portal IS allowed for an investor.
    expect(isInvestorAllowedPath("/investor")).toBe(true);
  });

  it("an investor is contained even out of trader-execution surfaces", () => {
    expect(isInvestorAllowedPath("/trade-command-room")).toBe(false);
    expect(isInvestorAllowedPath("/market-scanner")).toBe(false);
  });
});
