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
//   /news/calendar  — has TWO live consumers: pages/calendar.tsx (the
//                     Economic Calendar page) and CockpitCards.tsx (the
//                     critical-events card). Both now read it through its
//                     /news/calendar/envelope form (useGetEconomicCalendarEnvelope:
//                     the same events plus the calendar read state, so a failed
//                     read is never shown as "no events"). Theme H5
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
      "two live surfaces depend on this route",
    );
  });

  it("the contract still publishes it", () => {
    assert.ok(/^ {2}\/news\/calendar:/m.test(spec));
    assert.ok(/operationId: getEconomicCalendar\b/.test(spec));
  });

  // Both surfaces read the calendar through its envelope form (same events,
  // plus the read state), so the envelope route and contract are pinned too.
  it("the envelope form both surfaces read is served and published", () => {
    assert.ok(/router\.get\(\s*["']\/news\/calendar\/envelope["']/.test(route));
    assert.ok(/^ {2}\/news\/calendar\/envelope:/m.test(spec));
    assert.ok(/operationId: getEconomicCalendarEnvelope\b/.test(spec));
  });

  it("the Economic Calendar page still consumes it", () => {
    const page = read("artifacts/trading-dashboard/src/pages/calendar.tsx");
    assert.ok(/useGetEconomicCalendar(?:Envelope)?\(/.test(page));
  });

  it("the cockpit critical-events card still consumes it", () => {
    const cockpit = read("artifacts/trading-dashboard/src/components/dashboard/cockpit/CockpitCards.tsx");
    assert.ok(/useGetEconomicCalendar(?:Envelope)?\(/.test(cockpit));
  });

  it("neither surface calls the removed /news/risk route", () => {
    for (const rel of [
      "artifacts/trading-dashboard/src/pages/calendar.tsx",
      "artifacts/trading-dashboard/src/components/dashboard/cockpit/CockpitCards.tsx",
    ]) {
      const src = read(rel);
      assert.ok(!/getNewsRisk|useGetNewsRisk|\/news\/risk\b/.test(src), rel);
    }
  });

  it("the generated client still exposes the hooks both pages import", () => {
    const client = read("lib/api-client-react/src/generated/api.ts");
    assert.ok(/export function useGetEconomicCalendar\b/.test(client));
    assert.ok(/export function useGetEconomicCalendarEnvelope\b/.test(client));
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
