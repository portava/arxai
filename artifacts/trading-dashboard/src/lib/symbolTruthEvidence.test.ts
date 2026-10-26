import { describe, expect, it } from "vitest";
import type { MarketTruthResponse } from "@workspace/api-client-react";
import type { ScannerTruth } from "./scannerTruth";
import { resolveSymbolTruthEvidence, SYMBOL_TRUTH_MAX_AGE_MS } from "./symbolTruthEvidence";

const NOW = Date.parse("2026-10-26T14:00:01.000Z");
const CLOSE = "2026-10-26T14:00:00.000Z";
function input(): Parameters<typeof resolveSymbolTruthEvidence>[0] {
  const component = { present: true, alignment: "BULLISH" as const, label: "Bullish", asOf: CLOSE };
  const snapshot: MarketTruthResponse = {
    symbol: "EURUSD", displaySymbol: "EUR/USD", timeframe: "M1", generatedAt: new Date(NOW).toISOString(),
    data: { state: "LIVE_CONFIRMED", source: "mt5_broker", sourceLabel: "Live broker feed", price: 1.1, lastCandleAt: CLOSE, lastTickAt: CLOSE },
    components: { scanner: component, flame: component, scalp: component, timing: component },
    news: { providerConnected: true, events: [], riskLabel: "No high impact window", highImpactWindowActive: false, disclaimer: null },
    levels: { entryFrom: 1.1, entryTo: 1.11, stopLoss: 1.09, invalidation: 1.09, takeProfit: [1.12], withheld: false, withheldReason: null },
    verdict: { stage: "ALIGNED", bias: "BULLISH", headline: "Bullish", evidenceFor: ["Scanner is bullish"], evidenceAgainst: [], bestAction: "BUY", bestActionText: "Buy", invalidation: { price: 1.09, side: "BELOW" } },
  };
  return { snapshot, symbol: "EURUSD", apiTimeframe: "M1", scannerTruth: {
    actionable: true, symbolInternal: "EURUSD", timeframe: "1m",
    // Chart coordinates use OPEN time; the wire evidence uses CLOSE time.
    candles: { source: "mt5_broker", lastTime: "2026-10-26T13:59:00.000Z", status: "live" },
  } as ScannerTruth, scannerLastCandleAt: CLOSE, scannerError: false, snapshotError: false, nowMs: NOW };
}

describe("composed truth evidence", () => {
  it("preserves a confirmed same-source/same-closed-bar read without conflating open and close times", () => {
    const value = input(); const resolved = resolveSymbolTruthEvidence(value);
    expect(resolved.actionCapped).toBe(false);
    expect(resolved.snapshot).toBe(value.snapshot);
    expect(resolved.snapshot?.verdict.bestAction).toBe("BUY");
  });
  it("allows matching scheduled close boundaries on a current forming bar", () => {
    const value = input();
    value.snapshot!.data.lastCandleAt = new Date(NOW + 59_000).toISOString();
    value.scannerLastCandleAt = value.snapshot!.data.lastCandleAt;
    expect(resolveSymbolTruthEvidence(value).actionCapped).toBe(false);
  });
  it.each(["missing scanner", "scanner not actionable", "scanner error", "source mismatch", "older bar", "different future boundary", "missing bar", "stale snapshot data", "wrong scanner symbol", "wrong scanner timeframe"])("withholds direction and every actionable level on %s", (scenario) => {
    const value = input();
    if (scenario === "missing scanner") value.scannerTruth = null;
    if (scenario === "scanner not actionable") value.scannerTruth!.actionable = false;
    if (scenario === "scanner error") value.scannerError = true;
    if (scenario === "source mismatch") value.snapshot!.data.source = "deriv_public";
    if (scenario === "older bar") value.snapshot!.data.lastCandleAt = "2026-10-26T13:59:00.000Z";
    if (scenario === "different future boundary") value.snapshot!.data.lastCandleAt = new Date(NOW + 1).toISOString();
    if (scenario === "missing bar") value.snapshot!.data.lastCandleAt = null;
    if (scenario === "stale snapshot data") value.snapshot!.data.state = "STALE";
    if (scenario === "wrong scanner symbol") value.scannerTruth!.symbolInternal = "GBPUSD";
    if (scenario === "wrong scanner timeframe") value.scannerTruth!.timeframe = "5m";
    const result = resolveSymbolTruthEvidence(value);
    expect(result.actionCapped).toBe(true);
    expect(result.snapshot?.verdict).toMatchObject({ bias: "UNKNOWN", stage: "UNKNOWN", bestAction: "WATCH_ONLY", evidenceFor: [], invalidation: null });
    expect(result.snapshot?.levels).toMatchObject({ entryFrom: null, stopLoss: null, takeProfit: [], withheld: true });
    expect(Object.values(result.snapshot!.components).every((c) => !c.present && c.alignment === "UNKNOWN")).toBe(true);
    expect(result.snapshot?.data.state).not.toBe("LIVE_CONFIRMED");
    expect(value.snapshot?.verdict.bestAction).toBe("BUY"); // no cache mutation
  });
  it.each(["wrong symbol", "wrong timeframe", "expired", "future", "invalid time", "failed refresh"])("withdraws the snapshot on %s", (scenario) => {
    const value = input();
    if (scenario === "wrong symbol") value.snapshot!.symbol = "GBPUSD";
    if (scenario === "wrong timeframe") value.snapshot!.timeframe = "M5";
    if (scenario === "expired") value.nowMs += SYMBOL_TRUTH_MAX_AGE_MS + 1;
    if (scenario === "future") value.snapshot!.generatedAt = new Date(NOW + 1).toISOString();
    if (scenario === "invalid time") value.snapshot!.generatedAt = "invalid";
    if (scenario === "failed refresh") value.snapshotError = true;
    expect(resolveSymbolTruthEvidence(value)).toEqual({ snapshot: null, actionCapped: true });
  });
  it("keeps legitimate server restrictions instead of upgrading a wait to BUY", () => {
    const value = input(); value.snapshot!.verdict.bestAction = "WAIT_FOR_NEWS";
    expect(resolveSymbolTruthEvidence(value).snapshot?.verdict.bestAction).toBe("WAIT_FOR_NEWS");
  });
  it("withdraws an incomplete response instead of crashing or retaining its advice", () => {
    const value = input(); value.snapshot = { ...value.snapshot!, data: undefined } as unknown as MarketTruthResponse;
    expect(resolveSymbolTruthEvidence(value)).toEqual({ snapshot: null, actionCapped: true });
  });
});
