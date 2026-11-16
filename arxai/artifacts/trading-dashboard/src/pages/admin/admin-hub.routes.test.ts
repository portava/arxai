import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ADMIN_HUB_HREFS } from "./admin-hub";
import { isNormalUserAllowedPath, isInvestorAllowedPath } from "@/lib/routeAccess";

// ── Admin Hub link-drift guard ──────────────────────────────────────────────
// The Admin Hub (/admin) is a navigation hub: every tab deep-links to an
// existing admin route. If one of those routes is later renamed or removed,
// the hub link would silently dead-end. These tests fail the build in that case
// and also re-assert that the admin surface stays gated away from non-admins.

/** Parse the set of static route paths registered in App.tsx. */
function readAppRoutePaths(): Set<string> {
  const appSrc = readFileSync(
    path.resolve(import.meta.dirname, "..", "..", "App.tsx"),
    "utf8",
  );
  const paths = new Set<string>();
  const re = /path="(\/[^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(appSrc)) !== null) {
    paths.add(m[1]);
  }
  return paths;
}

const routePaths = readAppRoutePaths();

describe("Admin Hub link-drift guard", () => {
  it("exposes a non-empty list of hub hrefs", () => {
    expect(ADMIN_HUB_HREFS.length).toBeGreaterThan(0);
  });

  it("every hub href is an absolute path", () => {
    for (const href of ADMIN_HUB_HREFS) {
      expect(href.startsWith("/"), `hub href is not absolute: ${href}`).toBe(true);
    }
  });

  it("App.tsx exposes a sane route table", () => {
    // Sanity-check the parser itself so a regex break can't make the
    // resolution test vacuously pass.
    expect(routePaths.size).toBeGreaterThan(50);
    expect(routePaths.has("/admin")).toBe(true);
  });

  it("every Admin Hub href resolves to a real route in App.tsx", () => {
    const dead = ADMIN_HUB_HREFS.filter((href) => !routePaths.has(href));
    expect(dead, `Admin Hub links with no matching App.tsx route: ${dead.join(", ")}`).toEqual([]);
  });
});

describe("Admin Hub stays admin-gated", () => {
  it("the /admin hub entry is blocked for normal users and investors", () => {
    expect(isNormalUserAllowedPath("/admin")).toBe(false);
    expect(isInvestorAllowedPath("/admin")).toBe(false);
  });

  it("no /admin/* hub link is reachable by normal users or investors", () => {
    const adminLinks = ADMIN_HUB_HREFS.filter((href) => href.startsWith("/admin"));
    expect(adminLinks.length).toBeGreaterThan(0);
    for (const href of adminLinks) {
      expect(isNormalUserAllowedPath(href), `normal user can reach ${href}`).toBe(false);
      expect(isInvestorAllowedPath(href), `investor can reach ${href}`).toBe(false);
    }
  });
});
