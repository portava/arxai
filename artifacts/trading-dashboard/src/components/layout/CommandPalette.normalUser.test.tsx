import { describe, it, expect } from "vitest";
import {
  COMMAND_PALETTE_ITEMS,
  visibleCommandPaletteItems,
} from "./CommandPalette";
import { isNormalUserAllowedPath, isPendingTraderAllowedPath } from "@/lib/routeAccess";

/**
 * Dead-end Command Palette guard (Task #468).
 *
 * The Ctrl/Cmd+K Command Palette is a fourth visible nav surface a normal
 * trader can use to jump to any page. Like the desktop sidebar, mobile bottom
 * nav, and floating quick-action panel (covered by
 * NavSurfaces.normalUser.test.tsx, Task #466), a palette entry pointing at a
 * route that is NOT on the normal-user route-containment allowlist
 * (`isNormalUserAllowedPath`) becomes a silent dead end: RouteAccessGuard
 * redirects any non-allowlisted, non-/admin path home with no compile-time or
 * test failure.
 *
 * The sibling sidebar/mobile/fab guard works by walking the rendered DOM, but
 * the palette's no-query view slices results to the first 12 items, so a DOM
 * walk could never reliably enumerate the FULL non-admin set — partial coverage
 * would give false confidence. Instead we test the source-of-truth
 * `COMMAND_PALETTE_ITEMS` registry as data, resolving the normal-trader subset
 * through the SAME `visibleCommandPaletteItems` resolver the component uses
 * (a non-admin, non-investor session). Every resolved entry must point at an
 * allowlisted path. If a new non-admin palette item is added without an
 * allowlist entry (exact or prefix), this fails the build.
 *
 * A vacuous-pass guard proves the filtering is real: the registry is non-empty,
 * AND at least one admin-only item points at a route that is NOT on the
 * normal-user allowlist — so the normal-user assertion can never pass simply
 * because the allowlist contains every route.
 *
 * This is a product-containment / UX guard, NOT a security boundary. Backend
 * route guards remain authoritative for data and every trade action.
 */

// An APPROVED human trader sees the full non-admin (execution-capable) set.
const asTrader = () => visibleCommandPaletteItems({ isAdmin: false, isInvestor: false, isApprovedTrader: true });
// A PENDING / unapproved human trader sees only the reduced non-execution set.
const asPendingTrader = () => visibleCommandPaletteItems({ isAdmin: false, isInvestor: false, isApprovedTrader: false });
const asAdmin = () => visibleCommandPaletteItems({ isAdmin: true, isInvestor: false, isApprovedTrader: true });

describe("normal-user command palette only links to allowlisted routes", () => {
  it("every non-admin command palette item is reachable by a normal user", () => {
    const traderItems = asTrader();

    // Sanity: the trader actually sees a meaningful set (guards a vacuous pass
    // if the resolver silently returned nothing).
    expect(traderItems.length).toBeGreaterThan(5);
    // None of the trader-visible items carry the admin flag.
    expect(traderItems.every((i) => !i.admin)).toBe(true);

    const deadEnds = traderItems
      .map((i) => i.href)
      .filter((href) => !isNormalUserAllowedPath(href));
    expect(
      deadEnds,
      `command palette items not on the normal-user allowlist (add to routeAccess.ts): ${deadEnds.join(", ")}`,
    ).toEqual([]);
  });

  it("covers the FULL registry, not just the truncated 12-row view", () => {
    // The no-query rendered view slices to 12; the data-driven check sees all.
    expect(COMMAND_PALETTE_ITEMS.length).toBeGreaterThan(12);
    // Every entry navigates (has an href) — there are no pure-action commands.
    expect(COMMAND_PALETTE_ITEMS.every((i) => typeof i.href === "string" && i.href.length > 0)).toBe(true);
  });

  it("an investor sees no palette items at all", () => {
    expect(visibleCommandPaletteItems({ isAdmin: false, isInvestor: true })).toEqual([]);
    expect(visibleCommandPaletteItems({ isAdmin: true, isInvestor: true })).toEqual([]);
  });

  it("a pending (unapproved) trader sees only the reduced non-execution subset", () => {
    const pendingItems = asPendingTrader();
    // Pending traders still see a meaningful (non-empty) reduced set…
    expect(pendingItems.length).toBeGreaterThan(0);
    // …but NONE of the approved-only (execution-capable) items.
    expect(pendingItems.every((i) => !i.approvedOnly)).toBe(true);
    // …and strictly fewer than an APPROVED trader sees.
    expect(pendingItems.length).toBeLessThan(asTrader().length);
    // Every pending-visible item resolves to a route on the reduced allowlist.
    const deadEnds = pendingItems
      .map((i) => i.href)
      .filter((href) => !isPendingTraderAllowedPath(href));
    expect(
      deadEnds,
      `pending command palette items not on the reduced allowlist: ${deadEnds.join(", ")}`,
    ).toEqual([]);
  });
});

describe("the normal-user filtering is real (non-vacuous guard)", () => {
  it("at least one admin-only palette item points off the normal-user allowlist", () => {
    // If every admin item were also allowlisted, the normal-user assertion above
    // could pass simply because the allowlist contains every route. Proving an
    // admin-only item lands off the allowlist confirms the filtering genuinely
    // matters.
    const adminOnly = COMMAND_PALETTE_ITEMS.filter((i) => i.admin === true);
    expect(adminOnly.length).toBeGreaterThan(0);

    const offAllowlist = adminOnly
      .map((i) => i.href)
      .filter((href) => !isNormalUserAllowedPath(href));
    expect(offAllowlist.length).toBeGreaterThan(0);
  });

  it("the admin-visible set is a strict superset of the trader-visible set", () => {
    const traderHrefs = new Set(asTrader().map((i) => i.href));
    const adminHrefs = new Set(asAdmin().map((i) => i.href));
    // Admin sees everything the trader sees…
    for (const href of traderHrefs) expect(adminHrefs.has(href)).toBe(true);
    // …plus strictly more (the admin-only items).
    expect(asAdmin().length).toBeGreaterThan(asTrader().length);
  });
});
