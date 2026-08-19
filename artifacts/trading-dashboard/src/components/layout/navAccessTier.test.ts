// THEME H (cross-cut) — a nav entry must not lead to a 403.
//
// THE DEFECT
//   Six items were marked `approvedOnly` in the nav while every backing route
//   is `requireAdmin` (ADMIN/OWNER) in routes/shadowMode.ts. An approved
//   NON-admin trader therefore saw the menu entry, clicked it, watched the page
//   render — and then every fetch on it returned 403. The nav promised access
//   the server refuses.
//
// WHICH WAY TO FIX IT
//   The audit offered "open the routes to approved traders OR move the entries
//   to the admin group". The admin gate is deliberate — shadowMode.ts states
//   that shadow / forward / tournament / calibration / readiness are all
//   non-live SHADOW surfaces and every read is admin-only. Loosening
//   authorization to fix a menu bug would be the wrong direction entirely, so
//   the NAV is what changed.
//
// THE JOURNAL ENTRY WAS ALSO JUST WRONG
//   "Journal" in Performance & History pointed at /shadow-journal — admin-gated
//   SHADOW data, not the trader's own journal. A real per-user journal exists
//   at /journal, backed by requireUser and scoped to req.authUser.id. The entry
//   (and the assistant's "journal" / "notes" / "diary" aliases) now point
//   there; /shadow-journal keeps an explicitly-labelled admin entry.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../../../..");

function read(rel: string): string {
  return readFileSync(resolve(ROOT, rel), "utf8");
}

const nav = read("artifacts/trading-dashboard/src/components/layout/AppLayout.tsx");
const shadowRoutes = read("artifacts/api-server/src/routes/shadowMode.ts");

/** The nav entry line for a given href, if present. */
function entry(href: string): string | null {
  const rx = new RegExp(`\\{ href: "${href.replace(/\//g, "\\/")}",[^}]*\\}`);
  return rx.exec(nav)?.[0] ?? null;
}

/** Routes whose reads are admin-gated server-side. */
const ADMIN_GATED = [
  "/shadow-mode",
  "/strategy-tournament",
  "/strategy-promotion",
  "/confidence-calibration",
  "/ai-readiness-score",
  "/shadow-journal",
];

describe("H — the backend gate is genuinely admin-only", () => {
  for (const href of ["/shadow-mode/status", "/strategy-tournament/leaderboard", "/strategy-promotion", "/confidence-calibration", "/ai-readiness-score", "/shadow-journal"]) {
    it(`GET ${href} requires admin`, () => {
      const rx = new RegExp(`router\\.get\\("${href.replace(/\//g, "\\/")}",\\s*requireAdmin`);
      expect(shadowRoutes).toMatch(rx);
    });
  }
});

describe("H — no approvedOnly nav entry points at an admin-gated route", () => {
  for (const href of ADMIN_GATED) {
    it(`${href} is marked adminOnly in the nav`, () => {
      const e = entry(href);
      expect(e, `${href} must still have a nav entry`).not.toBeNull();
      expect(e!).toMatch(/adminOnly:\s*true/);
    });
  }
});

describe("H — Journal points at the trader's own journal", () => {
  it("the Journal entry targets /journal, not the shadow journal", () => {
    const e = entry("/journal");
    expect(e).not.toBeNull();
    expect(e!).toMatch(/label: "Journal"/);
    expect(e!).not.toMatch(/adminOnly/);
  });

  it("/journal is per-user on the server", () => {
    const route = read("artifacts/api-server/src/routes/journal.ts");
    expect(route).toMatch(/router\.get\("\/journal",\s*requireUser/);
    expect(route).toMatch(/req\.authUser!\.id/);
  });

  it("the assistant's journal aliases route to the real journal", () => {
    expect(nav).toMatch(/"\/journal":\s*\{ aliases: \[[^\]]*"journal"/);
    expect(nav).not.toMatch(/"\/shadow-journal":\s*\{ aliases: \[[^\]]*"journal"/);
  });

  it("the shadow journal keeps an honestly-labelled admin entry", () => {
    const e = entry("/shadow-journal");
    expect(e).not.toBeNull();
    expect(e!).toMatch(/label: "Shadow Journal"/);
    expect(e!).toMatch(/adminOnly:\s*true/);
  });
});

describe("H — the assistant does not call admin data 'yours'", () => {
  it("the readiness-score description says it is admin, not per-user", () => {
    expect(nav).toMatch(/"\/ai-readiness-score":[^\n]*Admin:/);
    expect(nav).not.toMatch(/"\/ai-readiness-score":[^\n]*Your trading discipline score/);
  });
});

// Same defect class, second batch: simulator/operator surfaces whose backing
// mutations are requireAdmin were still visible to approved non-admin traders.
// Each tuple pins the nav tier AND a representative server-side admin gate so
// neither can silently drift apart again.
const SIM_OPERATOR_GATED: Array<[href: string, routeFile: string, gate: RegExp]> = [
  ["/positions",                "artifacts/api-server/src/routes/oms.ts",             /router\.post\("\/oms\/positions\/:id\/close",\s*requireAdmin/],
  ["/orders",                   "artifacts/api-server/src/routes/oms.ts",             /router\.post\("\/orders\/create",\s*requireAdmin/],
  ["/news-risk",                "artifacts/api-server/src/routes/marketDataLayer.ts", /router\.post\("\/news-risk\/events",\s*requireAdmin/],
  ["/autopilot-control-center", "artifacts/api-server/src/routes/autopilot.ts",       /router\.post\("\/autopilot\/start",\s*requireAdmin/],
  ["/market-replay",            "artifacts/api-server/src/routes/aiBrain.ts",         /router\.post\("\/market-replay\/start",\s*requireAdmin/],
];

describe("H — simulator/operator surfaces are adminOnly in the nav", () => {
  for (const [href, routeFile, gate] of SIM_OPERATOR_GATED) {
    it(`${href} is marked adminOnly and its backend mutation is requireAdmin`, () => {
      const e = entry(href);
      expect(e, `${href} must still have a nav entry`).not.toBeNull();
      expect(e!).toMatch(/adminOnly:\s*true/);
      expect(read(routeFile)).toMatch(gate);
    });
  }
});

describe("H — authorization was NOT loosened to fix a menu bug", () => {
  it("no shadow route was opened to non-admins", () => {
    // Every read in this module must still be admin-gated.
    const reads = shadowRoutes.match(/router\.get\("[^"]+",\s*\w+/g) ?? [];
    expect(reads.length).toBeGreaterThan(0);
    for (const r of reads) {
      expect(r, `${r} must remain admin-gated`).toMatch(/requireAdmin$/);
    }
  });
});
