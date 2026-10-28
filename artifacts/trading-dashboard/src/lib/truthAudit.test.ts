// Truth audit 2026-10-27 — regression cases for the client-side evidence cap.
// The client may only DOWNGRADE a server claim. These cases reproduce paths
// where the cap itself replaced a worse server data state with a better one.
import { describe, expect, it } from "vitest";
import type { MarketTruthResponse } from "@workspace/api-client-react";
import type { ScannerTruth } from "./scannerTruth";
import { resolveSymbolTruthEvidence } from "./symbolTruthEvidence";

const NOW = Date.parse("2026-10-27T14:00:01.000Z");
const CLOSE = "2026-10-27T14:00:00.000Z";
type DataState = MarketTruthResponse["data"]["state"];

function input(serverState: DataState, scanner: ScannerTruth | null): Parameters<typeof resolveSymbolTruthEvidence>[0] {
  const component = { present: true, alignment: "BULLISH" as const, label: "Bullish", asOf: CLOSE };
  const snapshot: MarketTruthResponse = {
    symbol: "EURUSD", displaySymbol: "EUR/USD", timeframe: "M1", generatedAt: new Date(NOW).toISOString(),
    data: { state: serverState, source: "mt5_broker", sourceLabel: "Live broker feed", price: 1.1, lastCandleAt: CLOSE, lastTickAt: CLOSE },
    components: { scanner: component, flame: component, scalp: component, timing: component },
    news: { providerConnected: true, events: [], riskLabel: "No scheduled events affect this symbol.", highImpactWindowActive: false, disclaimer: null },
    levels: { entryFrom: null, entryTo: null, stopLoss: null, invalidation: null, takeProfit: [], withheld: true, withheldReason: "x" },
    verdict: { stage: "UNKNOWN", bias: "UNKNOWN", headline: "x", evidenceFor: [], evidenceAgainst: [], bestAction: "WAIT_FOR_DATA", bestActionText: "x", invalidation: null },
  };
  return { snapshot, symbol: "EURUSD", apiTimeframe: "M1", scannerTruth: scanner, scannerLastCandleAt: CLOSE,
    scannerError: false, snapshotError: false, nowMs: NOW };
}
const scanner = (status: ScannerTruth["candles"]["status"]) => ({
  actionable: false, symbolInternal: "EURUSD", timeframe: "1m", candles: { source: "mt5_broker", lastTime: CLOSE, status },
}) as ScannerTruth;

const RANK: Record<DataState, number> = { LIVE_CONFIRMED: 3, SYNCING: 2, STALE: 1, UNAVAILABLE: 0 };

describe("truth audit: capped data state never improves on the server state", () => {
  it.each([
    ["UNAVAILABLE", null],
    ["STALE", null],
    ["UNAVAILABLE", scanner("historical_only")],
    ["STALE", scanner("insufficient")],
    ["UNAVAILABLE", scanner("stale")],
  ] as const)("server %s with chart truth %o stays at least as degraded", (serverState, chart) => {
    const result = resolveSymbolTruthEvidence(input(serverState, chart));
    expect(result.actionCapped).toBe(true);
    const capped = result.snapshot!.data.state;
    expect(RANK[capped]).toBeLessThanOrEqual(RANK[serverState]);
  });
  it("still downgrades a LIVE_CONFIRMED server claim when chart truth is not actionable", () => {
    expect(resolveSymbolTruthEvidence(input("LIVE_CONFIRMED", scanner("stale"))).snapshot!.data.state).toBe("STALE");
    expect(resolveSymbolTruthEvidence(input("LIVE_CONFIRMED", null)).snapshot!.data.state).toBe("SYNCING");
  });
});
