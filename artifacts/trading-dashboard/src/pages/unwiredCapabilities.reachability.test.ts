// Reachability guard for the capabilities that shipped without a screen.
//
// Ten routers were mounted with only one UI between them. The worst was
// /me/authority: missionPromotionService refuses an automation increase with
// the words "requires an active owner-pressed authority grant", and the only
// way to create that grant was POST /api/me/authority/grants — a call no
// screen made. The documented blocker was a dead end.
//
// A page file existing is not reachability. A page is reachable only when the
// route is registered in App.tsx AND (for user surfaces) the path is on the
// normal-user containment allowlist — RouteAccessGuard redirects anything else
// home, silently, with no compile-time or test failure. That is exactly how
// /escape-route was already dead for every non-admin trader.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { isNormalUserAllowedPath, isInvestorAllowedPath } from "@/lib/routeAccess";
import { ADMIN_HUB_HREFS } from "@/pages/admin/admin-hub";

const HERE = import.meta.dirname;

function read(rel: string): string {
  return readFileSync(path.resolve(HERE, rel), "utf8");
}

const appSrc = read("../App.tsx");
const routePaths = new Set<string>(
  [...appSrc.matchAll(/path="(\/[^"]*)"/g)].map((m) => m[1]),
);

/** Sanity: a broken parser must not make every assertion below vacuous. */
describe("App.tsx route table", () => {
  it("parses a sane number of routes", () => {
    expect(routePaths.size).toBeGreaterThan(50);
    expect(routePaths.has("/my-account")).toBe(true);
  });
});

describe("user-facing capabilities are actually reachable", () => {
  const USER_SURFACES = [
    // Capability #37 — the press the mission-promotion blocker text names.
    "/authority",
    // Capability #44 — manual takeover of a live position (a safety affordance).
    "/position-control",
    // Capability #46 — the broker escape route. Its page and route already
    // existed; the allowlist entry did not, so a normal trader was bounced home.
    "/escape-route",
  ];

  for (const p of USER_SURFACES) {
    it(`${p} is registered in App.tsx`, () => {
      expect(routePaths.has(p), `${p} has no <Route> in App.tsx`).toBe(true);
    });
    it(`${p} is reachable by an approved trader (not a silent redirect home)`, () => {
      expect(isNormalUserAllowedPath(p), `${p} is missing from the normal-user allowlist`).toBe(true);
    });
    it(`${p} stays closed to investor accounts`, () => {
      expect(isInvestorAllowedPath(p)).toBe(false);
    });
  }
});

describe("admin capabilities are actually reachable", () => {
  const ADMIN_SURFACES = [
    "/admin/governance",      // #52 compliance, #51 lifecycle roles, #27 press, #35 as-of
    "/admin/org-structure",   // #50
    "/admin/engine-drivers",  // #15/#16/#34/#58
    "/admin/edge-capacity",   // #23
  ];

  for (const p of ADMIN_SURFACES) {
    it(`${p} is registered in App.tsx`, () => {
      expect(routePaths.has(p), `${p} has no <Route> in App.tsx`).toBe(true);
    });
    it(`${p} is linked from the Admin Hub`, () => {
      expect(ADMIN_HUB_HREFS.includes(p), `${p} is not linked from the Admin Hub`).toBe(true);
    });
    it(`${p} stays closed to normal users`, () => {
      expect(isNormalUserAllowedPath(p)).toBe(false);
    });
  }
});

describe("the surfaces call the endpoints they claim to", () => {
  const EXPECTED: Array<[string, string]> = [
    ["authority.tsx", "/api/me/authority"],
    ["position-control.tsx", "/api/me/positions/control"],
    ["admin/governance.tsx", "/api/admin/compliance/eligibility"],
    ["admin/governance.tsx", "/api/admin/lifecycle-roles"],
    ["admin/governance.tsx", "/api/admin/execution-policy"],
    ["admin/governance.tsx", "/api/admin/as-of"],
    ["admin/org-structure.tsx", "/api/admin/org-structure"],
    ["admin/engine-drivers.tsx", "/api/admin/intelligence-roi"],
    ["admin/engine-drivers.tsx", "/api/admin/champion-challenger"],
    ["admin/engine-drivers.tsx", "/api/admin/meta-strategy"],
    ["admin/engine-drivers.tsx", "/api/admin/recovery-probation"],
    ["admin/edge-capacity.tsx", "/api/admin/learning/edges"],
    ["admin/reconciliation-center.tsx", "/api/admin/reconciliation-center/broker-absence-candidates"],
    ["admin/reconciliation-center.tsx", "/api/admin/reconciliation-center/broker-absence-reconcile"],
  ];

  for (const [file, endpoint] of EXPECTED) {
    it(`${file} calls ${endpoint}`, () => {
      expect(read(`./${file}`)).toContain(endpoint);
    });
  }
});

describe("the mission-promotion blocker is no longer a dead end", () => {
  // missionPromotionService refuses an automation increase with "requires an
  // active owner-pressed authority grant". Before /authority existed there was
  // nowhere to go: the blocker named an action with no destination.
  const src = read("./profit-missions.tsx");

  it("the promotion card links to the authority press when that gate fails", () => {
    expect(src).toContain("authority-grant-blocker-link");
    expect(src).toContain('href="/authority"');
  });
  it("it keys off the gate the server actually returns", () => {
    expect(src).toContain("authority_grant");
  });
});

describe("the money surfaces state their basis", () => {
  it("Account Analytics renders the ledger-vs-broker basis strip", () => {
    expect(read("./analytics.tsx")).toContain("<LedgerBasisStrip />");
  });
  it("My Account renders the ledger-vs-broker basis strip", () => {
    expect(read("./my-account.tsx")).toContain("<LedgerBasisStrip />");
  });
});

describe("Bridge Preference tells the truth about a disabled personal bridge", () => {
  // The card fetched personalBridgeEnabled and never used it: the
  // "Use my own MT5 bridge — Active" badge was computed purely from !onShared,
  // so a user whose operator had disabled the personal bridge still read
  // "Active" — and toggling off the shared bridge failed with a bare error.
  const src = read("./my-account.tsx");

  it("the badge state depends on personalBridgeEnabled", () => {
    expect(src).toContain('!d.personalBridgeEnabled ? "Unavailable"');
  });
  it("a disabled personal bridge is labelled, not implied", () => {
    expect(src).toContain("badge-personal-bridge-disabled");
    expect(src).toContain("Disabled by your operator");
  });
  it("the shared-bridge switch cannot offer a switch the server will refuse", () => {
    expect(src).toContain("onShared && !d.personalBridgeEnabled");
  });
});
