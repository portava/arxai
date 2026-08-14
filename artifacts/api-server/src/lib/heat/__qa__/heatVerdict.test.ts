// Deterministic tests for the honesty-aware heat verdict (Task #611). Run via:
//   pnpm --filter @workspace/api-server run test:market-heat-verdict
//
// These lock the NON-NEGOTIABLE honesty rules: a missing news/calendar provider
// NEVER produces fake neutral / low-risk heat. They also lock the advisory-only
// boundary — the verdict carries no execution field and cannot bypass a trade
// gate.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeHeatVerdict,
  type HeatVerdictInput,
  type PriceSignal,
  type NewsSignal,
  type CalendarSignal,
} from "@workspace/domain/market-heat";

const livePrice: PriceSignal = {
  available: true,
  momentum: 0.5,
  volatility: 0.5,
  freshness: "LIVE",
  updatedAt: "2026-06-19T00:00:00.000Z",
  source: "twelve_data",
  candleCount: 60,
};

const noPrice: PriceSignal = {
  available: false,
  momentum: 0,
  volatility: 0,
  freshness: "UNAVAILABLE",
  updatedAt: null,
  source: "none",
  candleCount: 0,
};

const connectedNews: NewsSignal = {
  configured: true,
  connected: true,
  riskScore: 0.6,
  itemCount: 5,
  updatedAt: "2026-06-19T00:00:00.000Z",
  source: "provider",
  freshness: "LIVE",
};

const missingNews: NewsSignal = {
  configured: false,
  connected: false,
  riskScore: 0,
  itemCount: 0,
  updatedAt: null,
  source: "none",
  freshness: "UNAVAILABLE",
};

const connectedCalendar: CalendarSignal = {
  configured: true,
  connected: true,
  impactScore: 0.5,
  eventCount: 3,
  highImpactActive: false,
  updatedAt: "2026-06-19T00:00:00.000Z",
  source: "provider",
};

const missingCalendar: CalendarSignal = {
  configured: false,
  connected: false,
  impactScore: 0,
  eventCount: 0,
  highImpactActive: false,
  updatedAt: null,
  source: "none",
};

function input(over: Partial<HeatVerdictInput> = {}): HeatVerdictInput {
  return {
    id: "test",
    scope: "country",
    key: "US",
    displayName: "United States",
    affectedSymbols: ["EURUSD"],
    price: livePrice,
    news: connectedNews,
    calendar: connectedCalendar,
    ...over,
  };
}

test("macro scope, BOTH providers missing → gray unavailable, never low-risk", () => {
  const v = computeHeatVerdict(
    input({ news: missingNews, calendar: missingCalendar }),
  );
  assert.equal(v.intensity, "unavailable");
  assert.equal(v.direction, "unavailable");
  assert.equal(v.sourceStatus, "provider_missing");
  assert.equal(v.confidence, "none");
  assert.equal(v.heatScore, 0);
  const r = v.reason.toLowerCase();
  assert.ok(r.includes("unavailable"), "reason must say unavailable");
  // "low risk" / "no events" may appear ONLY when explicitly negated
  // (e.g. "not low risk, not 'no events'") — never as a fabricated claim.
  if (r.includes("low risk")) {
    assert.match(r, /not low risk/, "any 'low risk' mention must be negated");
  }
  if (r.includes("no events")) {
    assert.match(r, /not 'no events'|not 'no events"/, "any 'no events' mention must be negated");
  }
});

test("macro scope, only news missing → unavailable (not low-risk)", () => {
  const v = computeHeatVerdict(input({ news: missingNews }));
  // calendar still connected ⇒ macro is active, so this is NOT provider_missing,
  // but the verdict must still surface "News unavailable" honestly.
  assert.ok(v.reason.includes("News unavailable."), "must surface News unavailable");
  assert.ok(v.warnings.some((w) => w.toLowerCase().includes("news")));
});

test("macro scope, only calendar missing → 'Calendar unavailable', not 'no events'", () => {
  const v = computeHeatVerdict(input({ calendar: missingCalendar }));
  assert.ok(v.reason.includes("Calendar unavailable."), "must surface Calendar unavailable");
  assert.ok(!v.reason.toLowerCase().includes("no events scheduled"));
});

test("symbol scope, price live but news+calendar missing → price_only, capped", () => {
  const v = computeHeatVerdict(
    input({ scope: "symbol", key: "EURUSD", news: missingNews, calendar: missingCalendar }),
  );
  assert.equal(v.sourceStatus, "price_only");
  assert.notEqual(v.confidence, "high");
  assert.ok(v.reason.includes("News unavailable."));
  assert.ok(v.reason.includes("Calendar unavailable."));
});

test("symbol scope, nothing available → gray unavailable", () => {
  const v = computeHeatVerdict(
    input({
      scope: "symbol",
      key: "EURUSD",
      price: noPrice,
      news: missingNews,
      calendar: missingCalendar,
    }),
  );
  assert.equal(v.sourceStatus, "unavailable");
  assert.equal(v.intensity, "unavailable");
  assert.equal(v.confidence, "none");
});

test("all three live + connected → confirmed, can be high confidence", () => {
  const v = computeHeatVerdict(input());
  assert.equal(v.sourceStatus, "confirmed");
  assert.ok(["high", "medium"].includes(v.confidence));
  assert.ok(v.reason.toLowerCase().includes("confirmed"));
});

test("stale price caps confidence to low", () => {
  const v = computeHeatVerdict(
    input({ price: { ...livePrice, freshness: "STALE" } }),
  );
  assert.equal(v.sourceStatus, "stale");
  assert.equal(v.confidence, "low");
});

test("delayed price caps confidence to low", () => {
  const v = computeHeatVerdict(
    input({ price: { ...livePrice, freshness: "DELAYED" } }),
  );
  assert.equal(v.sourceStatus, "delayed");
  assert.equal(v.confidence, "low");
});

test("synthetic scope is price-only HONEST (not degraded) and immune to macro", () => {
  const v = computeHeatVerdict(
    input({
      scope: "synthetic",
      key: "synthetic",
      displayName: "V75",
      news: missingNews,
      calendar: missingCalendar,
    }),
  );
  // Missing news/calendar must NOT make a synthetic "provider_missing".
  assert.notEqual(v.sourceStatus, "provider_missing");
  assert.notEqual(v.intensity, "unavailable");
  assert.ok(v.reason.toLowerCase().includes("price action only"));
});

test("synthetic scope with no price → honest unavailable", () => {
  const v = computeHeatVerdict(
    input({ scope: "synthetic", key: "synthetic", price: noPrice }),
  );
  assert.equal(v.sourceStatus, "unavailable");
  assert.equal(v.confidence, "none");
});

test("advisory-only boundary: verdict carries advisoryOnly:true and NO execution field", () => {
  const v = computeHeatVerdict(input());
  assert.equal(v.advisoryOnly, true);
  const keys = Object.keys(v);
  // No field that an execution gate could read.
  for (const banned of [
    "allowOrderExecution",
    "commandExecutionAllowed",
    "liveLocked",
    "canTrade",
    "execute",
    "gatePass",
  ]) {
    assert.ok(!keys.includes(banned), `verdict must not expose ${banned}`);
  }
});
