// Truth audit 2026-10-27 — event risk that could not be checked is not "no risk".
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRubyMarketEdge, type SignalEngineInput } from "@workspace/domain/signal-intelligence";
import { buildSymbolTruthSnapshot, type TruthSnapshotDeps } from "../symbolTruthSnapshot.js";
import { TRUTH_EVIDENCE_REASON_TEXT } from "@workspace/domain/truth";
import { NOW, marketFixture } from "./marketEvidenceFixtures.js";

const fixture = marketFixture();
const absent = async (): Promise<never> => { throw new Error("offline unavailable"); };
const inputs: SignalEngineInput = { symbol: "EURUSD", displayName: "EURUSD", timeframe: "M15", assetClass: "forex", candles: fixture.result.candles,
  currentPrice: 1.098, dataSource: "LIVE_FEED", scanner: { bias: "bullish", recommendedAction: "BUY", confidenceScore: 85, entrySniperScore: 85, riskRewardRatio: 2,
    setupType: "Trend", entry: 1.098, entryZone: { from: 1.0978, to: 1.0982 }, stopLoss: 1.097, takeProfit: 1.1, reasonForTrade: "", reasonToAvoid: "" },
  scalp: null, execution: null, newsRiskLevel: null, previous: null, now: NOW };
const signal = () => ({ ...buildRubyMarketEdge(inputs), marketEvidence: { ...fixture.evidence, userId: 1 } });

type Radar = Awaited<ReturnType<TruthSnapshotDeps["buildNewsFn"]>>;
function radar(connected: boolean, name: string, over: Partial<Radar["radar"]> = {}): Radar {
  return { radar: { symbol: "EURUSD", provider: { connected, name, note: "" }, events: [], topSeverity: null, highImpactWindowActive: false, summary: "", ...over },
    behavior: { mode: connected ? "NORMAL" : "NO_PROVIDER", note: "" } };
}
function snapshot(buildNewsFn: TruthSnapshotDeps["buildNewsFn"]) {
  return buildSymbolTruthSnapshot("EURUSD", "M15", 1, {
    getChartCandlesFn: async () => fixture.chart as never, buildNewsFn,
    evaluateScalpFn: absent, computeTimingFn: absent, buildScannerFn: async () => signal(),
  });
}

test("control: connected quiet calendar keeps a genuine BUY", async () => {
  const s = await snapshot(async () => radar(true, "trading_economics"));
  assert.equal(s.verdict.bestAction, "BUY");
});

test("control: no calendar configured stays technicals-only (documented design)", async () => {
  const s = await snapshot(async () => radar(false, "none"));
  assert.equal(s.verdict.bestAction, "BUY");
  // Copy and evidence agree: not configured is "not connected".
  assert.equal(s.news.riskUnchecked, false);
  assert.equal(s.evidence.news.reason, "NO_CALENDAR");
  assert.match(s.news.disclaimer ?? "", /No economic-calendar provider is connected/);
});

for (const [name, build] of Object.entries({
  "configured calendar whose fetch failed": async () => radar(false, "trading_economics"),
  "calendar provider threw inside the radar": async () => radar(false, "unavailable"),
  "radar build rejected": absent,
} as Record<string, TruthSnapshotDeps["buildNewsFn"]>)) test(`${name} cannot read as all-clear`, async () => {
  const s = await snapshot(build);
  assert.notEqual(s.verdict.bestAction, "BUY");
  assert.notEqual(s.verdict.bestAction, "SELL");
  assert.equal(s.news.providerConnected, false);
  assert.doesNotMatch(s.news.riskLabel, /No scheduled events|No event calendar is connected/);
  // Review 2026-10-27 finding 5: the evidence reason, risk label and
  // disclaimer all say "could not be checked" — none says "not connected".
  assert.equal(s.news.riskUnchecked, true);
  assert.deepEqual(s.evidence.news, { evidenceClass: "unavailable", reason: "CALENDAR_UNCHECKED", observedAt: null });
  for (const copy of [s.news.riskLabel, s.news.disclaimer ?? "", TRUTH_EVIDENCE_REASON_TEXT[s.evidence.news.reason]]) {
    assert.match(copy, /could not be checked/, copy);
    assert.doesNotMatch(copy, /connected/, copy);
  }
});

test("synthetic instruments are not held back by a failed macro calendar", async () => {
  const f = marketFixture({ symbol: "V50", source: "deriv_public" });
  const valid = { ...signal(), symbol: "V50", marketEvidence: { ...f.evidence, userId: 1 } };
  const s = await buildSymbolTruthSnapshot("V50", "M15", 1, { getChartCandlesFn: async () => f.chart as never,
    buildNewsFn: async () => radar(false, "trading_economics", { symbol: "V50" }), evaluateScalpFn: absent, computeTimingFn: absent, buildScannerFn: async () => valid });
  assert.equal(s.components.scanner.present, true);
  assert.notEqual(s.verdict.bestAction, "WAIT_FOR_NEWS");
});
