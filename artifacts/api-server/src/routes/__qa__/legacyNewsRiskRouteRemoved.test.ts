// THEME G-CUT — the legacy /news/risk route is gone; /news/calendar STAYS.
//
// The menu sweep listed BOTH legacy /news routes as "fabricate data, no
// frontend consumer". Half of that is right and half of it would have broken a
// page the same fix pack promises to keep:
//
//   /news/risk      — genuinely zero consumers. Nothing in the dashboard, the
//                     server, the scripts or the generated client called
//                     getNewsRisk. It scored risk from a hardcoded mock
//                     calendar, so its only possible output was invented.
//                     DELETED.
//
//   /news/calendar  — has TWO live consumers through useGetEconomicCalendar:
//                     pages/calendar.tsx (the Economic Calendar page) and
//                     CockpitCards.tsx (the critical-events card). Theme H5
//                     additionally names the Economic Calendar as the calendar
//                     surface to KEEP. Cutting it would have broken the very
//                     page the consolidation preserves. KEPT.
//
// This suite pins both halves so the asymmetry is deliberate and stays that
// way. The remaining mock fallback inside /news/calendar is addressed on the
// Theme A branch, which makes that route honest-or-empty unconditionally.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../../../..");

function read(rel: string): string {
  return readFileSync(resolve(ROOT, rel), "utf8");
}

const route = read("artifacts/api-server/src/routes/news.ts");
const spec = read("lib/api-spec/openapi.yaml");

describe("G-CUT — /news/risk is removed", () => {
  it("the route handler is gone", () => {
    assert.ok(!/router\.get\(\s*["']\/news\/risk["']/.test(route));
  });

  it("the scorer import it needed is gone with it", () => {
    assert.ok(!/newsRiskScorer/.test(route));
    assert.ok(!/GetNewsRiskQueryParams/.test(route));
  });

  it("the contract no longer publishes it", () => {
    assert.ok(!/^ {2}\/news\/risk:/m.test(spec));
    assert.ok(!/operationId: getNewsRisk\b/.test(spec));
  });

  it("the generated client has no getNewsRisk binding", () => {
    assert.ok(!/getNewsRisk\b/.test(read("lib/api-client-react/src/generated/api.ts")));
  });
});

describe("G-CUT — /news/calendar is deliberately kept", () => {
  it("the route handler still exists", () => {
    assert.ok(
      /router\.get\(\s*["']\/news\/calendar["']/.test(route),
      "the cockpit critical-events card depends on this route",
    );
  });

  it("the contract still publishes it", () => {
    assert.ok(/^ {2}\/news\/calendar:/m.test(spec));
    assert.ok(/operationId: getEconomicCalendar\b/.test(spec));
  });

  it("the merged Economic Calendar page consumes the unified endpoint instead", () => {
    // Surface consolidation folded pages/calendar.tsx into
    // pages/economic-calendar.tsx, which reads the unified
    // /api/economic-calendar/events path rather than the legacy hook.
    // The legacy route survives for the cockpit card below.
    const page = read("artifacts/trading-dashboard/src/pages/economic-calendar.tsx");
    assert.ok(/\/api\/economic-calendar\/events/.test(page));
    assert.ok(!/useGetEconomicCalendar\b/.test(page));
  });

  it("the cockpit critical-events card still consumes it", () => {
    const cockpit = read("artifacts/trading-dashboard/src/components/dashboard/cockpit/CockpitCards.tsx");
    assert.ok(/useGetEconomicCalendar\(/.test(cockpit));
  });

  it("the generated client still exposes the hook the cockpit imports", () => {
    const client = read("lib/api-client-react/src/generated/api.ts");
    assert.ok(/useGetEconomicCalendar/.test(client));
  });
});

describe("G-CUT — the shared news-risk engine is untouched", () => {
  it("the scorer module still exists for its real callers", async () => {
    // newsIntelligenceService and selectedMarket both score against REAL
    // connected events; only the mock-fed HTTP route was removed.
    const mod = await import("../../lib/news/calendar/newsRiskScorer.js");
    assert.equal(typeof mod.scoreNewsRisk, "function");
  });

  it("its honest callers still call it", () => {
    assert.ok(/scoreNewsRisk\(/.test(read("artifacts/api-server/src/lib/news/newsIntelligenceService.ts")));
    assert.ok(/scoreNewsRisk\(/.test(read("artifacts/api-server/src/lib/scannerSelected/selectedMarket.ts")));
  });
});
