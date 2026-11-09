// Opportunity Map: a row whose own final read says "No trade right now." or
// "Wait for confirmation." must never be filed under "Ready now".
//
// categoryOf looked only at live data, lateness, high/critical news, the raw
// recommendedAction, edge >= 55 and entry >= 50. It never read finalRead.label,
// so every downgrade computeFinalRead applies (risk rejection, low technical
// confidence, medium news, conflicts, non-live data, sufficiency) was ignored:
// a BUY rejected by risk landed in READY_NOW with the verdict "Ready now",
// bestAction "Entry is open — consider a buy", the row reason "No trade right
// now." and eligibility for Best scalp / Best retest and the "cleaner
// opportunity" banner.
// Run: pnpm --filter @workspace/api-server run test:truth-component-evidence

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  categorizeOpportunities,
  compareBestVsSelected,
} from "@workspace/domain/signal-intelligence";
import { toInput } from "../opportunityMapService.js";
import { computeFinalRead, type ScannerOpportunity } from "../../marketScanner.js";

function mkOpp(overrides: Partial<ScannerOpportunity>): ScannerOpportunity {
  const base = {
    symbol: "EURUSD",
    timeframe: "M5",
    bias: "bullish",
    recommendedAction: "BUY",
    setupType: "retest",
    confidenceScore: 70,
    riskScore: 40,
    entrySniperScore: 75,
    riskRewardRatio: 2,
    reasonForTrade: "test",
    reasonToAvoid: "",
    rulesPassed: [],
    rulesFailed: [],
    statusBadge: "READY",
    opportunity: { score: 57 },
    entry: 1.1,
    stopLoss: 1.09,
    takeProfit: 1.12,
    generatedAt: new Date().toISOString(),
    dataSource: "LIVE_FEED",
    approvedTop250: true,
    dataStatus: "live",
    selectable: true,
    tradeable: true,
    disabledReason: null,
    chartConfirmed: true,
  };
  return { ...base, ...overrides } as unknown as ScannerOpportunity;
}

function mapFor(opp: ScannerOpportunity) {
  const withFinal = { ...opp, finalRead: computeFinalRead(opp) } as ScannerOpportunity;
  const input = toInput(withFinal, { isLate: false } as Parameters<typeof toInput>[1]);
  return { finalRead: withFinal.finalRead!, result: categorizeOpportunities([input]) };
}

const DOWNGRADED: Array<{ name: string; opp: Partial<ScannerOpportunity> }> = [
  { name: "rejected by risk (final NO_TRADE)", opp: { statusBadge: "REJECTED_BY_RISK" } },
  { name: "choppy market (final NO_TRADE)", opp: { statusBadge: "CHOPPY_MARKET" } },
  { name: "low technical confidence (final WAIT)", opp: { statusBadge: "LOW_CONFIDENCE" } },
  { name: "setup wants confirmation (final WAIT)", opp: { statusBadge: "WAIT_FOR_CONFIRMATION" } },
  { name: "chart not confirmed (final WAIT)", opp: { chartConfirmed: false } },
  {
    name: "regime UNKNOWN (final WAIT)",
    opp: { regime: { regime: "UNKNOWN" } as unknown as ScannerOpportunity["regime"] },
  },
  {
    name: "failed chart pattern (final AVOID_FOR_NOW)",
    opp: { patternImpact: { labelHint: "failed_setup" } as unknown as ScannerOpportunity["patternImpact"] },
  },
  {
    name: "trendline trap (final AVOID_FOR_NOW)",
    opp: { trendlineImpact: { labelHint: "trap_risk" } as unknown as ScannerOpportunity["trendlineImpact"] },
  },
  {
    name: "medium news (final WAIT)",
    opp: { newsContext: { riskLevel: "medium", alignsWithScanner: null } as unknown as ScannerOpportunity["newsContext"] },
  },
];

for (const c of DOWNGRADED) {
  test(`${c.name}: never READY_NOW, never a best pick, never the cleaner alternative`, () => {
    const { finalRead, result } = mapFor(mkOpp(c.opp));
    assert.notEqual(finalRead.label, "TRADE_WATCH", "fixture must be a downgraded final read");
    const row = result.rows[0]!;
    assert.notEqual(row.category, "READY_NOW", `${c.name}: final=${finalRead.label} reason="${row.reason}"`);
    assert.notEqual(row.stageLabel, "Ready now");
    assert.doesNotMatch(row.bestAction, /Entry is open/);
    if (finalRead.label === "NO_TRADE" || finalRead.label === "AVOID_FOR_NOW") {
      assert.equal(row.category, "AVOID");
      assert.equal(result.best.bestScalp, null);
      assert.equal(result.best.bestRetest, null);
      const banner = compareBestVsSelected(result, "GBPUSD");
      assert.equal(banner.hasCleanerAlternative, false);
      assert.equal(banner.best, null);
    }
    assert.equal(result.categories.READY_NOW.length, 0);
  });
}

test("a clean TRADE_WATCH live row is still Ready now", () => {
  const { finalRead, result } = mapFor(mkOpp({}));
  assert.equal(finalRead.label, "TRADE_WATCH");
  assert.equal(result.rows[0]!.category, "READY_NOW");
});

test("domain: a row with an unknown final read (null) is not Ready now", () => {
  const base = toInput({ ...mkOpp({}), finalRead: computeFinalRead(mkOpp({})) } as ScannerOpportunity,
    { isLate: false } as Parameters<typeof toInput>[1]);
  const result = categorizeOpportunities([{ ...base, finalReadLabel: null }]);
  assert.notEqual(result.rows[0]!.category, "READY_NOW");
});
