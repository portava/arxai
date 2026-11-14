// Shared read-policy integration: production Truth composer, Scanner final read,
// Eleanor permissions and selected-panel cap consume one controlled observation.
// Component source reads are injected; no DB, model, provider or order is called.
import "../../calibration/__qa__/_offlineEnv.js";
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { evaluateMarketDataSufficiency } from "@workspace/domain/market";
import { buildSymbolTruthSnapshot, type TruthSnapshotDeps } from "../symbolTruthSnapshot.js";
import { computeFinalRead, type ScannerOpportunity } from "../../marketScanner.js";
import { deriveEleanorReadLayers } from "../../assistant/eleanorReadLayers.js";
import { capSelectedMarketByTruth } from "../../scannerSelected/selectedMarketTruthCap.js";
import type { SelectedMarketResult } from "../../scannerSelected/selectedMarket.js";
import type { EleanorChartContext } from "../../data/chart/eleanorChartContext.js";
import { recordStateCandleWindow } from "../../data/chart/stateCandleWindow.js";
import { CHART_TIMEFRAMES } from "../../data/chart/timeframes.js";
import { marketFixture } from "./marketEvidenceFixtures.js";

const now = Date.parse("2026-11-13T12:34:10Z");
mock.timers.enable({ apis: ["Date"], now });

for (const timeframe of CHART_TIMEFRAMES) {
  test(`${timeframe}: Truth, Scanner and Eleanor respect the same live/stale/thin evidence`, async () => {
    for (const scenario of ["live", "stale", "thin"] as const) {
      const count = scenario === "thin" ? 3 : 80;
      const fixture = marketFixture({ now, timeframe, symbol: "V25_1S", count });
      // Monthly observations must use real calendar boundaries, not 31-day steps.
      if (timeframe === "MN1") {
        fixture.chart.candles.forEach((bar, i) => {
          const start = new Date(Date.UTC(2026, 10 - count + i, 1));
          const end = new Date(Date.UTC(2026, 11 - count + i, 1));
          bar.openTime = start.toISOString();bar.closeTime = end.toISOString();
          bar.isComplete = true;bar.isForming = false;bar.isFinal = true;
        });
        fixture.evidence.lastClosedCandleAt = "2026-11-01T00:00:00.000Z";
      }
      const live = scenario !== "stale";
      fixture.chart.feedStatus.isLive = live;
      fixture.chart.feedStatus.stale = !live;
      fixture.chart.feedStatus.quality = live ? "clean" : "stale";
      const sufficiency = evaluateMarketDataSufficiency({ symbol: "V25_1S", timeframe,
        freshnessVerdict: live ? "LIVE" : "AWAITING", availableClosedCandles: count });
      const price = fixture.chart.candles.at(-1)!.close;
      const signal = { symbol: "V25_1S", timeframe, generatedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 30_000).toISOString(),
        marketEvidence: { ...fixture.evidence, userId: 1 }, dataSource: "LIVE_FEED",
        freshness: "FRESH", hasSufficientData: true, direction: "BUY", bias: "BULLISH",
        lifecycleStage: "ENTRY_WINDOW_OPEN", evidence: { meetsMinimum: true },
        entryZone: { from: price - .0001, to: price + .0001 }, stopLoss: price - .001,
        invalidationPrice: price - .001, takeProfitZones: [{ from: price + .002, to: price + .0022 }] };
      const truth = await buildSymbolTruthSnapshot("V25_1S", timeframe, 1, {
        getUserBridgeFn: async () => null,
        getChartCandlesFn: async () => fixture.chart,
        buildNewsFn: async () => { throw new Error("Synthetic instrument has no economic calendar mapping"); },
        buildScannerFn: async () => signal,
        evaluateScalpFn: async () => { throw new Error("No scalp observation in this fixture"); },
        computeTimingFn: async () => ({ symbol: "V25_1S", timeframe, marketEvidence: fixture.evidence,
          generatedAt: new Date(now).toISOString(), dataQuality: { label: "real", hasCandleData: true },
          pressureBias: "BUY", timingGrade: "A", entryPermission: "ENTER_NOW" }),
      } as unknown as Partial<TruthSnapshotDeps>);
      const scanner = computeFinalRead({ symbol: "V25_1S", timeframe, confidenceScore: 90,
        recommendedAction: "BUY", statusBadge: "HOT_SETUP", chartConfirmed: true,
        dataSource: live ? "LIVE_FEED" : "STALE_FEED", sufficiency,
      } as ScannerOpportunity);
      const eleanor = deriveEleanorReadLayers({ closedBarsCount: count,
        freshnessVerdict: live ? "LIVE" : "AWAITING", canShowTradeSetup: sufficiency.canShowTradeSetup,
        clientFeedUnconfirmed: !live });
      const context = { basis: live ? "VERIFIED" : "PARTIAL", sufficiency,
        closedBarsCount: count, state: {} } as EleanorChartContext;
      recordStateCandleWindow(context.state, fixture.chart.candles, fixture.evidence);
      const selected = capSelectedMarketByTruth({ ok: true, symbol: "V25_1S", timeframe,
        marketEvidence: fixture.evidence, generatedAt: new Date(now).toISOString(),
        dataState: live ? "LIVE_CONFIRMED" : "STALE", highlights: {}, explanation: { cautions: [] },
      } as unknown as SelectedMarketResult, truth, context, now) as SelectedMarketResult;
      assert.equal(truth.data.sourceIdentity, fixture.evidence.sourceIdentity);
      assert.equal(truth.data.lastCandleAt, fixture.evidence.lastClosedCandleAt);
      if (scenario !== "live") {
        assert.equal(truth.levels.withheld, true, `${scenario}: Truth withheld`);
        assert.notEqual(scanner.label, "TRADE_WATCH", `${scenario}: Scanner withheld`);
        assert.equal(eleanor.canShowLiveTradeSetup, false, `${scenario}: Eleanor withheld`);
        assert.equal(eleanor.canUseCurrentCandleForEntry, false, `${scenario}: entry confirmation withheld`);
        assert.equal(selected.levelsWithheld, true, `${scenario}: selected panel withheld`);
        assert.equal(selected.highlights.entryZone, null);
      } else {
        assert.equal(truth.data.state, "LIVE_CONFIRMED");
        assert.equal(eleanor.layer, "FULL");
        assert.equal(selected.highlights.confidenceScore, null, "raw evidence is not a measured probability");
        if (!selected.levelsWithheld) {
          assert.deepEqual(selected.highlights.entryZone, { low: truth.levels.entryFrom, high: truth.levels.entryTo });
          assert.equal(selected.highlights.suggestedStop, truth.levels.stopLoss);
          assert.equal(selected.highlights.suggestedTakeProfit, truth.levels.takeProfit[0]);
        }
      }
    }
  });
}
