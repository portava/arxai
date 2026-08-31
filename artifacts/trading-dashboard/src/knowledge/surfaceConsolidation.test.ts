// SURFACE CONSOLIDATION — the merge-map end-state, pinned.
//
// Each remaining merge-map item collapsed a duplicated surface into its single
// owning page. This suite pins the end-state at the source level so a future
// change can't quietly resurrect a second copy of any of them:
//
//   A — Heat is ONE surface: GlobalMarketHeatCard lives on the Market Heat Map
//       page (its own tab); the Market Scanner keeps only a link.
//   C — Shadow Mode / Strategy Tournament / Strategy Promotion are Testing Lab
//       tabs; the standalone routes are redirects (detail-pinned in
//       navAccessTier.test.ts).
//   D — The scalp trio is ONE scan surface: RubyScalpScan (rank + optional
//       goal) replaced RubyScalpRanking and RubyScalpBuilder; the Scalp
//       Builder tab is gone; Scalp Focus stays the deep live-quote surface.
//   E — Calendar/news-risk is ONE surface: the unified Economic Calendar hosts
//       the News Risk tab; the legacy /calendar list page is deleted and
//       redirects.

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "..");
const REPO = resolve(SRC, "../../..");

function read(rel: string): string {
  return readFileSync(resolve(SRC, rel), "utf8");
}

const app = read("App.tsx");
const scanner = read("pages/market-scanner.tsx");
const heatMap = read("pages/market-heat-map.tsx");
const calendar = read("pages/economic-calendar.tsx");

describe("A — heat is ONE surface", () => {
  it("the Market Heat Map page hosts GlobalMarketHeatCard as a tab", () => {
    expect(heatMap).toMatch(/GlobalMarketHeatCard/);
    expect(heatMap).toMatch(/id: "global-heat"/);
  });

  it("the Market Scanner no longer renders a second heat surface", () => {
    expect(scanner).not.toMatch(/GlobalMarketHeatCard/);
  });

  it("the scanner keeps a link to the one heat surface", () => {
    expect(scanner).toMatch(/scanner-global-heat-link/);
    expect(scanner).toMatch(/href="\/market-heat-map"/);
  });

  it("the heat tab names its engine instead of blending the two", () => {
    // The page's other tabs read the timing brain; the Global Heat tab reads
    // the market-heat service. The tab copy must say so.
    expect(heatMap).toMatch(/market-heat\s+service/);
    expect(heatMap).toMatch(/timing brain/);
  });

  it("the Admin Data Status tab is hidden from non-admin sessions", () => {
    expect(heatMap).toMatch(/realIsAdmin\s*\?\s*\[\{/);
  });
});

describe("D — the scalp trio is ONE scan surface", () => {
  it("the merged RubyScalpScan replaced Ranking + Builder", () => {
    expect(scanner).toMatch(/RubyScalpScan/);
    expect(scanner).not.toMatch(/RubyScalpRanking|RubyScalpBuilder/);
    expect(existsSync(resolve(SRC, "components/scanner/RubyScalpRanking.tsx"))).toBe(false);
    expect(existsSync(resolve(SRC, "components/scanner/RubyScalpBuilder.tsx"))).toBe(false);
  });

  it("the separate Scalp Builder tab is gone", () => {
    expect(scanner).not.toMatch(/id: "scalp-builder"/);
  });

  it("the goal picker is optional inside the merged surface", () => {
    const merged = read("components/scanner/RubyScalpScan.tsx");
    expect(merged).toMatch(/scalp-goal-toggle/);
    expect(merged).toMatch(/useCreateMeScalpRank/);
    expect(merged).toMatch(/useCreateMeScalpBuild/);
    // The honest no-trade path survives the merge.
    expect(merged).toMatch(/scalp-builder-none/);
    expect(merged).toMatch(/noTradeReason/);
  });

  it("both merged paths ride the live-quote rank inputs (C2) — no o.entry fallback", () => {
    // Server-side: rank AND build share buildRankInputs, which fetches a real
    // quote per symbol and deliberately refuses the old `o.entry` fallback.
    //
    // The per-symbol read was widened from currentPriceFor -> currentQuoteFor
    // (truth wave 2026-08-30): the scalp spread chip needed the LIVE per-symbol
    // spread from the same quote instead of an unaged spec value, so the helper
    // now returns a quote object rather than a bare price. The PROPERTY this
    // pin exists for is unchanged and asserted below: a real per-symbol quote,
    // an honest null when there is none, and never a price borrowed from the
    // opportunity's own entry (which made currentPrice == entry, so
    // `movedToward` was always ~0 and every late/chase gate silently read
    // "not late").
    const svc = readFileSync(
      resolve(REPO, "artifacts/api-server/src/lib/scalp/scalpService.ts"),
      "utf8",
    );
    // 1. a REAL quote is fetched per symbol …
    expect(svc).toMatch(/currentQuoteFor\(o\.symbol\)/);
    // 2. … and its absence degrades to null, never to a substitute number …
    expect(svc).toMatch(/currentPrice:\s*liveQuotes\[i\]\?\.price \?\? null/);
    // 3. … and the banned fallback never returns, in any spelling.
    expect(svc).not.toMatch(/currentPrice:\s*o\.entry/);
    expect(svc).not.toMatch(/currentPrice:\s*[^\n]*\?\?\s*o\.entry/);
  });

  it("Scalp Focus remains the deep live-quote surface on the Focus tab", () => {
    expect(scanner).toMatch(/RubyScalpFocusCard/);
  });
});

describe("E — calendar/news-risk is ONE surface", () => {
  it("the legacy /calendar page is deleted and the route redirects", () => {
    expect(existsSync(resolve(SRC, "pages/calendar.tsx"))).toBe(false);
    expect(app).toMatch(/<Route path="\/calendar"><Redirect to="\/economic-calendar" \/><\/Route>/);
  });

  it("the Economic Calendar hosts the News Risk tab", () => {
    expect(calendar).toMatch(/<NewsRiskSection \/>/);
    expect(calendar).toMatch(/TabsTrigger value="news-risk"/);
  });

  it("/news-risk is a redirect page, not a second surface", () => {
    const page = read("pages/news-risk.tsx");
    expect(page).toMatch(/\/economic-calendar\?tab=news-risk/);
    expect(page).not.toMatch(/NewsRiskCard|UpcomingEventsList|HighImpactEventBanner/);
  });

  it("the kept /news/calendar route documents its one remaining consumer", () => {
    const news = readFileSync(resolve(REPO, "artifacts/api-server/src/routes/news.ts"), "utf8");
    expect(news).toMatch(/CockpitCards/);
    expect(news).not.toMatch(/pages\/calendar\.tsx.*live surface/);
  });
});

describe("C — the Testing Lab owns the folded strategy-research surfaces", () => {
  it("hosts shadow / tournament / promotion as tabs", () => {
    const lab = read("pages/testing-lab.tsx");
    for (const t of ["shadow", "tournament", "promotion"]) {
      expect(lab).toMatch(new RegExp(`TabsContent value="${t}"`));
    }
  });

  it("no standalone page components are routed for the folded surfaces", () => {
    expect(app).not.toMatch(/ShadowModePage|StrategyTournamentPage|StrategyPromotionPage/);
  });
});
