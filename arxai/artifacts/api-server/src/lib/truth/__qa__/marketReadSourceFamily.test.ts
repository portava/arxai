import "../../calibration/__qa__/_offlineEnv.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { prepareMarketRead, sameMarketReadSourceFamily } from "../marketReadEvidence.js";
import { marketFixture } from "./marketEvidenceFixtures.js";
import { recordStateCandleWindow, evidenceOfState, copyStateCandleWindow, closedCandlesOfState } from "../../data/chart/stateCandleWindow.js";
import type { ChartIntelligenceState } from "../../data/chart/chartIntelligence.js";
import type { ChartTimeframe } from "../../data/chart/timeframes.js";

const now = Date.parse("2026-11-14T05:40:00Z");
const era = "a".repeat(64);
function native(timeframe: ChartTimeframe) {
  const f = marketFixture({ now, timeframe, symbol: "V25_1S", bridge: 7 });
  f.result.provenance!.sourceId += `:${era}`;
  f.result.provenance!.brokerSymbol = "Volatility 25 (1s) Index";
  return f;
}
const observed = (f: ReturnType<typeof native>, tf: ChartTimeframe) => prepareMarketRead(f.result, "V25_1S", tf, now)?.evidence ?? null;

test("native M5 and H1 share an account-era family while retaining different series identities", () => {
  const primary = observed(native("M5"), "M5"), higher = observed(native("H1"), "H1");
  assert.ok(primary && higher);
  assert.notEqual(primary.sourceIdentity, higher.sourceIdentity, "the old exact-identity comparison always refused HTF");
  assert.equal(sameMarketReadSourceFamily(primary, higher), true);
  assert.equal(sameMarketReadSourceFamily(primary, JSON.parse(JSON.stringify(higher))), false, "wire data cannot assert this binding");
});

for (const [label, change] of Object.entries({
  accountEra: (f: ReturnType<typeof native>) => { f.result.provenance!.sourceId = f.result.provenance!.sourceId.replace(era, "b".repeat(64)); },
  missingAccountEra: (f: ReturnType<typeof native>) => { f.result.provenance!.sourceId = "mt5_broker:V25_1S:H1"; },
  bridge: (f: ReturnType<typeof native>) => { f.result.provenance!.bridgeConnectionId = 8; },
  owner: (f: ReturnType<typeof native>) => { f.result.provenance!.userId = 9; },
  missingOwner: (f: ReturnType<typeof native>) => { f.result.provenance!.userId = null; },
  nativeSymbol: (f: ReturnType<typeof native>) => { f.result.provenance!.brokerSymbol = "other"; },
  environment: (f: ReturnType<typeof native>) => { f.result.provenance!.environment = "live"; },
  subprovider: (f: ReturnType<typeof native>) => { f.result.provenance!.subProviderId = "other"; },
  wrongTimeframeSlot: (f: ReturnType<typeof native>) => { f.result.provenance!.sourceId = `mt5_broker:V25_1S:H12:${era}`; },
  wrongSymbolSlot: (f: ReturnType<typeof native>) => { f.result.provenance!.sourceId = `mt5_broker:V75:H1:${era}`; },
})) {
  test(`higher-timeframe read refuses ${label} mismatch or missing identity`, () => {
    const higher = native("H1"); change(higher);
    assert.equal(sameMarketReadSourceFamily(observed(native("M5"), "M5"), observed(higher, "H1")), false);
  });
}

test("family binding survives frozen state and user enrichment; HTF keeps the primary read cutoff", () => {
  const f = native("H1"), primary = observed(native("M5"), "M5");
  const state = { symbol: "V25_1S", timeframe: "H1", latestClosedCandle: f.chart.candles.at(-1) } as ChartIntelligenceState;
  recordStateCandleWindow(state, f.chart.candles, observed(f, "H1"));
  const enriched = { ...state }; copyStateCandleWindow(state, enriched);
  assert.equal(sameMarketReadSourceFamily(primary, evidenceOfState(enriched)), true);
  assert.equal(closedCandlesOfState(enriched, "2026-11-14T04:00:00Z").length, f.chart.candles.length - 1);
  assert.equal(closedCandlesOfState(enriched, "2026-11-14T04:00:00Z").at(-1)!.time, "2026-11-14T03:00:00.000Z");
});
