// THEME G-FINISH — the News Risk page reads the real pipeline, not a simulator.
//
// BEFORE
//   The page was a CRUD form over `/api/news-risk/events`, an admin-gated
//   IN-MEMORY store in marketDataLayer that literally responds with
//   `dataSource: "SIMULATOR"`. Traders opening "News Risk" saw a hand-typed
//   list of made-up events; and because those endpoints are admin-only, an
//   approved NON-admin trader got a 403 and an empty page. Nothing on it came
//   from a real calendar, and nothing typed into it ever reached the risk
//   engine the trade surfaces consult.
//
// AFTER
//   The page composes the three components the rest of the app already uses,
//   all reading real DB-backed endpoints:
//     HighImpactEventBanner → /api/economic-events/upcoming (economic_events)
//     NewsRiskCard          → /api/news-risk/latest        (news_risk_reports)
//     UpcomingEventsList    → /api/economic-events/upcoming (economic_events)
//
//   NewsRiskCard is the same surface the Trade Plan Builder renders, so this
//   page and the trade path now show the SAME verdict from the SAME source.
//
// Asserted at the source level: the surface is a composition, and what matters
// is which endpoints it can reach and which it no longer can.
//
// SURFACE CONSOLIDATION (item E): the composition moved from the standalone
// pages/news-risk.tsx into components/news/NewsRiskSection.tsx, rendered as
// the "News Risk" tab of the unified Economic Calendar. The old /news-risk
// route is a redirect to /economic-calendar?tab=news-risk. Every honesty
// assertion below now pins the folded section.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "..");

function read(rel: string): string {
  return readFileSync(resolve(SRC, rel), "utf8");
}

const page = read("components/news/NewsRiskSection.tsx");
/** Section source with comments stripped — the header documents the old simulator. */
const pageCode = page
  .split("\n")
  .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
  .join("\n");

describe("G-FINISH — the simulator CRUD surface is gone", () => {
  it("no longer reads the in-memory events store", () => {
    expect(pageCode).not.toMatch(/news-risk\/events/);
  });

  it("no longer performs CRUD against it", () => {
    expect(pageCode).not.toMatch(/method:\s*["'](POST|PATCH|DELETE)["']/);
  });

  it("no longer sends the admin role header", () => {
    // The old page forced `x-security-role: ADMIN` on every call, which both
    // assumed admin and broke for approved non-admin traders.
    expect(pageCode).not.toMatch(/x-security-role/);
  });
});

describe("G-FINISH — it reads the real, DB-backed pipeline", () => {
  it("renders NewsRiskCard (news_risk_reports via /news-risk/latest)", () => {
    expect(pageCode).toMatch(/<NewsRiskCard\b/);
    const card = read("components/news/NewsRiskCard.tsx");
    expect(card).toMatch(/\/api\/news-risk\/latest/);
  });

  it("renders the upcoming-events list (economic_events)", () => {
    expect(pageCode).toMatch(/<UpcomingEventsList\b/);
    const list = read("components/news/UpcomingEventsList.tsx");
    expect(list).toMatch(/\/api\/economic-events\/upcoming/);
  });

  it("renders the high-impact banner (economic_events)", () => {
    expect(pageCode).toMatch(/<HighImpactEventBanner\b/);
    const banner = read("components/news/HighImpactEventBanner.tsx");
    expect(banner).toMatch(/\/api\/economic-events\/upcoming/);
  });

  it("shares its verdict surface with the trade path", () => {
    // Trade Plan Builder already renders NewsRiskCard. Same component, same
    // endpoint — the page cannot disagree with the trade surface.
    const tradePlan = read("components/tradePlan/TradePlanBuilderPanel.tsx");
    expect(tradePlan).toMatch(/<NewsRiskCard\b/);
  });
});

describe("G-FINISH — honesty is preserved by reuse", () => {
  it("NewsRiskCard still checks provider status before presenting a verdict", () => {
    const card = read("components/news/NewsRiskCard.tsx");
    expect(card).toMatch(/market-heat\/diagnostics/);
    expect(card).toMatch(/providersUnavailable/);
  });

  it("the page does not claim an empty list means no risk", () => {
    expect(page).toMatch(/not that risk is absent/i);
  });

  it("the page places no trades and mutates nothing", () => {
    expect(pageCode).not.toMatch(/execute|dispatch|placeOrder|trade-action/i);
  });
});

describe("G-FINISH + E — the surface is still reachable", () => {
  it("/news-risk still routes, as a redirect to the calendar's news-risk tab", () => {
    const app = read("App.tsx");
    expect(app).toMatch(/<Route path="\/news-risk"/);
    expect(app).toMatch(/pages\/news-risk/);
    const redirect = read("pages/news-risk.tsx");
    expect(redirect).toMatch(/\/economic-calendar\?tab=news-risk/);
    // The redirect page must not have grown back any data reads of its own.
    expect(redirect).not.toMatch(/fetch\(|useQuery|api\//);
  });

  it("the Economic Calendar hosts the folded section as a tab", () => {
    const calendar = read("pages/economic-calendar.tsx");
    expect(calendar).toMatch(/<NewsRiskSection \/>/);
    expect(calendar).toMatch(/TabsTrigger value="news-risk"/);
    // ?tab=news-risk deep links (from the redirect) select the tab.
    expect(calendar).toMatch(/get\("tab"\)/);
  });
});
