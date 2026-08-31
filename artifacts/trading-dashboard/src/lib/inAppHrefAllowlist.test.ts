// RANK 76 (+ 51) — in-app links that were never reachable by anyone.
//
// THE DEFECT CLASS
//   RouteAccessGuard silently redirects a non-allowlisted, non-/admin path back
//   to the cockpit, and App.tsx renders Not Found for a path with no <Route>.
//   Neither failure produces a compile error, a test failure, or any message to
//   the user — the link just quietly does the wrong thing. So a link could sit
//   in the always-visible chrome for months without working:
//
//     * Topbar.tsx status drawer → `/operator-dashboard`. Grepping the whole
//       dashboard for that string returned exactly one hit: that line. No
//       <Route> declares it. It has never worked, for anybody.
//     * Topbar.tsx status drawer → `/admin-diagnostics`. The real route is
//       `/admin/diagnostics` — one missing slash. Also never worked.
//       Both were plain <a href>, so the failure was a full page reload onto a
//       404 for an admin, or a bounce home for everyone else.
//     * AlertsDrawer.tsx "Preferences" → `/alert-preferences`, on NEITHER
//       trader allowlist, from a drawer every human trader can open.
//     * settings.tsx → `/protective-auto-close`, likewise on no allowlist.
//     * AlertDetailCard's "Open" map → /portfolio, /learning, /mt5-bridge,
//       /risk-settings — four more.
//     * The Help Center topic catalogue → /trading-cockpit and
//       /paper-testing-launch (no <Route> exists for either) plus six
//       admin-only paths, i.e. 100% of its "Open page" links.
//
// THE GUARD
//   For the surfaces below — the chrome and pages that every human trader can
//   open — every literal in-app href must be BOTH
//     (a) a real route declared in App.tsx, and
//     (b) on the allowlist for the tier that can see it,
//   or else an /admin/* path, which is admin-only by construction (and whose
//   render is itself asserted to be behind an isAdmin check).
//
//   Scoped to a named file list rather than the whole tree on purpose: these
//   are the surfaces where a dead link is invisible because the user did not go
//   looking for it. Widening the list later is additive.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { isInvestorAllowedPath, isNormalUserAllowedPath, isPendingTraderAllowedPath } from "./routeAccess";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../../..");
const read = (rel: string) => readFileSync(resolve(ROOT, rel), "utf8");

const appSrc = read("artifacts/trading-dashboard/src/App.tsx");

/** Every path declared by a <Route path="…"> or <Redirect to="…"> in App.tsx. */
function declaredRoutes(): Set<string> {
  const out = new Set<string>();
  for (const m of appSrc.matchAll(/<Route\s+path="([^"]+)"/g)) out.add(m[1]);
  for (const m of appSrc.matchAll(/<Redirect\s+to="([^"?]+)/g)) out.add(m[1]);
  return out;
}

/** True when App.tsx can render this path (exact, or a `:param` route). */
function routeExists(path: string, routes: Set<string>): boolean {
  if (routes.has(path)) return true;
  const segs = path.split("/");
  for (const r of routes) {
    const rs = r.split("/");
    if (rs.length !== segs.length) continue;
    if (rs.every((seg, i) => seg.startsWith(":") || seg === segs[i])) return true;
  }
  return false;
}

/** Literal in-app hrefs in a source file: href="/x", href: "/x", to="/x". */
function hrefsIn(src: string): string[] {
  const out = new Set<string>();
  for (const m of src.matchAll(/\bhref(?:=|:\s*)"(\/[^"]*)"/g)) out.add(m[1]);
  for (const m of src.matchAll(/\bhref=\{`(\/[^`${]*)`\}/g)) out.add(m[1]);
  return [...out]
    // Strip query strings — the route is what has to resolve.
    .map((h) => h.split("?")[0])
    // API paths and anchors are not routes.
    .filter((h) => !h.startsWith("/api/") && h !== "/" ? true : h === "/");
}

/**
 * Surfaces every human trader can open. A static source scan cannot see which
 * branch of a tier conditional renders, so the checkable invariants are:
 *
 *   1. every literal in-app href resolves to a route App.tsx declares, and
 *   2. every non-/admin href is on the APPROVED trader allowlist — the union of
 *      everything a human trader can ever reach.
 *
 * (2) is what catches the real defect class: a path on NO allowlist
 * (/alert-preferences, /protective-auto-close) can only ever redirect home, for
 * every tier, no matter how the component gates it.
 *
 * Links that are approved-only must additionally be gated in the component, so
 * a PENDING trader is not shown them — asserted separately below by requiring
 * the tier gate to be present in any file that carries an approved-only href.
 */
const SURFACES: string[] = [
  "artifacts/trading-dashboard/src/components/layout/Topbar.tsx",
  "artifacts/trading-dashboard/src/components/layout/MobileBottomNav.tsx",
  "artifacts/trading-dashboard/src/components/alerts/AlertsDrawer.tsx",
  "artifacts/trading-dashboard/src/components/alerts/AlertDetailCard.tsx",
  "artifacts/trading-dashboard/src/pages/settings.tsx",
  "artifacts/trading-dashboard/src/pages/notifications.tsx",
  "artifacts/trading-dashboard/src/pages/help-center.tsx",
  "artifacts/trading-dashboard/src/pages/alert-preferences.tsx",
  "artifacts/trading-dashboard/src/components/risk/PendingIncreasesPanel.tsx",
  "artifacts/trading-dashboard/src/components/risk/RiskLimitsEditor.tsx",
];

/**
 * Paths exempt from the trader-allowlist rule, each with the reason it is
 * legitimately off it. Kept explicit and tiny so an exemption is a decision,
 * not a default.
 */
const EXEMPT: Record<string, string> = {
  // The INVESTOR bottom bar. Investors are contained by isInvestorAllowedPath,
  // a different allowlist entirely (INVESTOR_EXACT).
  "/investor": "investor-only surface, governed by isInvestorAllowedPath",
};

describe("the route table parser is real (non-vacuous)", () => {
  const routes = declaredRoutes();

  it("finds a substantial route table", () => {
    expect(routes.size).toBeGreaterThan(100);
  });

  it("recognises a route that exists and rejects one that does not", () => {
    expect(routeExists("/my-account", routes)).toBe(true);
    expect(routeExists("/admin/diagnostics", routes)).toBe(true);
    // The two dead Topbar targets this guard was written for.
    expect(routeExists("/operator-dashboard", routes)).toBe(false);
    expect(routeExists("/admin-diagnostics", routes)).toBe(false);
  });

  it("the allowlist is not simply everything (the check can fail)", () => {
    // If isNormalUserAllowedPath returned true for any path, the assertions
    // below would be vacuous. Prove a real product route is off it.
    expect(isNormalUserAllowedPath("/admin/data-management")).toBe(false);
    expect(isNormalUserAllowedPath("/operator-dashboard")).toBe(false);
    // And that the pending tier really is narrower than the approved tier.
    expect(isNormalUserAllowedPath("/market-scanner")).toBe(true);
    expect(isPendingTraderAllowedPath("/market-scanner")).toBe(false);
  });
});

describe("every in-app href on a trader-visible surface resolves and is allowlisted", () => {
  const routes = declaredRoutes();

  for (const file of SURFACES) {
    const src = read(file);
    const hrefs = hrefsIn(src);
    const short = file.split("/").slice(-1)[0];

    it(`${short}: every href points at a declared route`, () => {
      const missing = hrefs.filter((h) => !routeExists(h, routes));
      expect(
        missing,
        `${short} links to paths no <Route> declares: ${missing.join(", ")}`,
      ).toEqual([]);
    });

    it(`${short}: every non-admin href is reachable by some human trader`, () => {
      const deadEnds = hrefs.filter(
        (h) => !h.startsWith("/admin/") && !(h in EXEMPT) && !isNormalUserAllowedPath(h),
      );
      expect(
        deadEnds,
        `${short} links to paths RouteAccessGuard redirects for EVERY trader tier ` +
          `(add to routeAccess.ts, gate behind isAdmin, or remove): ${deadEnds.join(", ")}`,
      ).toEqual([]);
    });

    it(`${short}: any approved-only href is behind a tier gate`, () => {
      const approvedOnly = hrefs.filter(
        (h) => !h.startsWith("/admin/") && !(h in EXEMPT)
          && isNormalUserAllowedPath(h) && !isPendingTraderAllowedPath(h),
      );
      if (approvedOnly.length === 0) return;
      expect(
        src,
        `${short} links to approved-only path(s) ${approvedOnly.join(", ")} but never reads ` +
          `an approval tier — a pending trader would be silently redirected home`,
      ).toMatch(/isApprovedTrader|useTraderTier|PENDING_ITEMS/);
    });
  }
});

describe("the investor exemption is real, not a hole", () => {
  it("/investor is genuinely on the investor allowlist", () => {
    expect(isInvestorAllowedPath("/investor")).toBe(true);
    // …and is NOT quietly reachable by a human trader.
    expect(isNormalUserAllowedPath("/investor")).toBe(false);
  });
});

describe("admin-only links are rendered behind an admin check", () => {
  it("the Topbar status drawer gates its /admin/* links on isAdmin", () => {
    const src = read("artifacts/trading-dashboard/src/components/layout/Topbar.tsx");
    // Both operator links must live inside the `p.isAdmin && (…)` block.
    const gated = /\{p\.isAdmin && \(([\s\S]*?)\)\}/.exec(src)?.[1] ?? "";
    expect(gated).toMatch(/\/admin\/operator-command-center/);
    expect(gated).toMatch(/\/admin\/diagnostics/);
  });

  it("no trader-visible surface uses a plain <a> for an in-app route", () => {
    // A plain <a href="/x"> is a full page reload in a wouter SPA: it re-runs
    // the whole bundle and lands on RouteAccessGuard, which is what turned two
    // wrong Topbar paths into a hard 404 instead of a no-op.
    for (const file of SURFACES) {
      const src = read(file);
      const anchors = [...src.matchAll(/<a\s[^>]*href="(\/[^"]*)"/g)].map((m) => m[1]);
      const inApp = anchors.filter((h) => !h.startsWith("/api/"));
      expect(inApp, `${file} uses <a href> for in-app route(s): ${inApp.join(", ")}`).toEqual([]);
    }
  });
});

describe("the Help Center catalogue only advertises reachable pages", () => {
  // RANK 51 — 100% of the Help Center's "Open page" links were un-followable.
  // The catalogue is server-side, so it is checked as data here; the page also
  // re-checks each route against the viewer's own tier before rendering.
  const helpSrc = read("artifacts/api-server/src/lib/onboarding/help.ts");
  const routes = declaredRoutes();
  const pageRoutes = [...helpSrc.matchAll(/page_route:\s*"([^"]+)"/g)].map((m) => m[1]);

  it("the catalogue actually has routed topics", () => {
    expect(pageRoutes.length).toBeGreaterThan(10);
  });

  it("every topic route is a declared route", () => {
    const missing = pageRoutes.filter((r) => !routeExists(r, routes));
    expect(missing, `help topics point at undeclared routes: ${missing.join(", ")}`).toEqual([]);
  });

  it("every topic route is on the approved-trader allowlist", () => {
    const off = pageRoutes.filter((r) => !isNormalUserAllowedPath(r));
    expect(off, `help topics point off the trader allowlist: ${off.join(", ")}`).toEqual([]);
  });

  it("the retired dead targets are gone", () => {
    for (const dead of ["/trading-cockpit", "/paper-testing-launch", "/active-paper-session", "/risk-settings", "/broker-readonly"]) {
      expect(pageRoutes, `help must not point at ${dead}`).not.toContain(dead);
    }
  });

  it("the help-center page re-validates each route for the viewer's tier", () => {
    const page = read("artifacts/trading-dashboard/src/pages/help-center.tsx");
    expect(page).toMatch(/isHumanTraderAllowedPath/);
    expect(page).toMatch(/canOpen\(t\.page_route\)/);
  });
});

describe("the onboarding step catalogue only advertises reachable pages", () => {
  // The IDENTICAL RANK 51 defect, in the onboarding step catalogue: two
  // REQUIRED steps linked "Open /trading-cockpit →" and "Open
  // /paper-testing-launch →" (both routes deleted in Phase 3), REQUIRED steps
  // pointed at /readiness-checklist and /risk-settings (on no trader
  // allowlist, so RouteAccessGuard silently bounced the click home), and the
  // completion alert told the user to "Use the Trading Cockpit as your home
  // base" about the removed page. The catalogue is server-side data
  // (lib/onboarding/steps.ts, page_route: string | null with null = no page);
  // the onboarding page also re-checks each route against the viewer's own
  // tier before rendering the link.
  const stepsSrc = read("artifacts/api-server/src/lib/onboarding/steps.ts");
  const routes = declaredRoutes();
  const stepRoutes = [...stepsSrc.matchAll(/page_route: "([^"]+)"/g)].map((m) => m[1]);

  it("the catalogue actually has routed steps", () => {
    expect(stepRoutes.length).toBeGreaterThan(8);
  });

  it("every step route is a declared route", () => {
    const missing = stepRoutes.filter((r) => !routeExists(r, routes));
    expect(missing, `onboarding steps point at undeclared routes: ${missing.join(", ")}`).toEqual([]);
  });

  it("every step route is on the approved-trader allowlist", () => {
    const off = stepRoutes.filter((r) => !isNormalUserAllowedPath(r));
    expect(off, `onboarding steps point off the trader allowlist: ${off.join(", ")}`).toEqual([]);
  });

  it("every REQUIRED step route is reachable by a PENDING trader or tier-gated in the page", () => {
    // Required steps a brand-new (pending) trader is told to complete should
    // land for them; approved-only routes are tolerated ONLY because the page
    // hides the link for tiers that cannot open it (asserted below).
    const requiredRoutes = [...stepsSrc.matchAll(/page_route: "([^"]+)"[^\n]*required: true/g)].map((m) => m[1]);
    expect(requiredRoutes.length).toBeGreaterThan(2);
    for (const r of requiredRoutes) {
      expect(isNormalUserAllowedPath(r), `required step route ${r} unreachable by any trader`).toBe(true);
    }
  });

  it("the retired dead targets are gone", () => {
    for (const dead of ["/trading-cockpit", "/paper-testing-launch", "/readiness-checklist", "/risk-settings", "/session-report", "/replay-simulator", "/data-import", "/system-health", "/trader-coach"]) {
      expect(stepRoutes, `onboarding steps must not point at ${dead}`).not.toContain(dead);
    }
  });

  it("the onboarding page re-validates each route for the viewer's tier and drops the removed-page copy", () => {
    const page = read("artifacts/trading-dashboard/src/pages/onboarding.tsx");
    expect(page).toMatch(/useCanOpenRoute/);
    expect(page).toMatch(/canOpen\(s\.page_route\)/);
    // The completion alert must not send users to the removed page by name.
    // (Strip comments first — the honesty note quoting the OLD copy is fine.)
    const rendered = page.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/[^\n]*/gm, "");
    expect(rendered).not.toMatch(/Use the Trading Cockpit/);
  });

  it("the step catalogue no longer names the removed Trading Cockpit page", () => {
    // Strip comments (the honesty note describing the OLD defect is allowed
    // to name it) and check only the data.
    const data = stepsSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    expect(data).not.toMatch(/Trading Cockpit/);
  });
});
