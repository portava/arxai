import { describe, expect, it } from "vitest";
import type { MarketTruthResponse } from "@workspace/api-client-react";
import { classifyTruthEvidence, type TruthEvidence } from "@workspace/domain/truth";
import type { ScannerTruth } from "./scannerTruth";
import { resolveSymbolTruthEvidence, SYMBOL_TRUTH_MAX_AGE_MS } from "./symbolTruthEvidence";

// Client-side re-validation of the server's per-claim evidence classes. The
// client may only DOWNGRADE: each claim keeps the weaker of the server class and
// a local re-classification of the snapshot as it will be displayed.

const NOW = Date.parse("2026-10-26T14:00:01.000Z");
const CLOSE = "2026-10-26T14:00:00.000Z";

function baseSnapshot(): MarketTruthResponse {
  const component = { present: true, alignment: "BULLISH" as const, label: "Bullish", asOf: CLOSE };
  return {
    symbol: "EURUSD", displaySymbol: "EUR/USD", timeframe: "M1", generatedAt: new Date(NOW).toISOString(),
    data: { state: "LIVE_CONFIRMED", source: "mt5_broker", sourceLabel: "Live broker feed", price: 1.1, lastCandleAt: CLOSE, lastTickAt: CLOSE },
    components: { scanner: component, flame: component, scalp: component, timing: component },
    news: { providerConnected: true, events: [], riskLabel: "No high impact window", highImpactWindowActive: false, disclaimer: null },
    levels: { entryFrom: 1.1, entryTo: 1.11, stopLoss: 1.09, invalidation: 1.09, takeProfit: [1.12], withheld: false, withheldReason: null },
    verdict: { stage: "ALIGNED", bias: "BULLISH", headline: "Bullish", evidenceFor: ["Scanner is bullish"], evidenceAgainst: [], bestAction: "BUY", bestActionText: "Buy", invalidation: { price: 1.09, side: "BELOW" } },
  };
}
function serverEvidence(s: MarketTruthResponse): TruthEvidence {
  return classifyTruthEvidence({ nowMs: NOW, data: s.data, news: s.news, components: s.components, levels: s.levels, verdict: s.verdict });
}
function input(withEvidence = true): Parameters<typeof resolveSymbolTruthEvidence>[0] {
  const snapshot = baseSnapshot();
  if (withEvidence) snapshot.evidence = serverEvidence(snapshot);
  return { snapshot, symbol: "EURUSD", apiTimeframe: "M1", scannerTruth: {
    actionable: true, symbolInternal: "EURUSD", timeframe: "1m",
    candles: { source: "mt5_broker", lastTime: "2026-10-26T13:59:00.000Z", status: "live" },
  } as ScannerTruth, scannerLastCandleAt: CLOSE, scannerError: false, snapshotError: false, nowMs: NOW };
}

describe("evidence classes after the client cap", () => {
  it("keeps a consistent confirmed classification and the same snapshot object", () => {
    const value = input();
    const resolved = resolveSymbolTruthEvidence(value);
    expect(resolved.actionCapped).toBe(false);
    expect(resolved.snapshot).toBe(value.snapshot);
    expect(resolved.snapshot?.evidence?.price).toEqual({ evidenceClass: "verified", reason: "LIVE_FEED_OBSERVATION", observedAt: CLOSE });
    expect(resolved.snapshot?.evidence?.verdict.evidenceClass).toBe("estimate");
    expect(resolved.snapshot?.evidence?.levels.evidenceClass).toBe("estimate");
  });

  it("never promotes a weaker server class, even when local facts look live", () => {
    const value = input();
    value.snapshot!.evidence!.price = { evidenceClass: "stale", reason: "FEED_STALE", observedAt: CLOSE };
    value.snapshot!.evidence!.components.timing = { evidenceClass: "unavailable", reason: "COMPONENT_ABSENT", observedAt: null };
    const ev = resolveSymbolTruthEvidence(value).snapshot?.evidence;
    expect(ev?.price.evidenceClass).toBe("stale");
    expect(ev?.components.timing.evidenceClass).toBe("unavailable");
  });

  it("downgrades an inflated server class (a heuristic claimed as verified)", () => {
    const value = input();
    value.snapshot!.evidence!.levels = { evidenceClass: "verified", reason: "LIVE_FEED_OBSERVATION", observedAt: CLOSE };
    value.snapshot!.evidence!.verdict = { evidenceClass: "verified", reason: "LIVE_FEED_OBSERVATION", observedAt: CLOSE };
    const resolved = resolveSymbolTruthEvidence(value);
    expect(resolved.snapshot).not.toBe(value.snapshot);
    expect(resolved.snapshot?.evidence?.levels).toEqual({ evidenceClass: "estimate", reason: "MODEL_ESTIMATE", observedAt: CLOSE });
    expect(resolved.snapshot?.evidence?.verdict.evidenceClass).toBe("estimate");
    expect(value.snapshot!.evidence!.levels.evidenceClass).toBe("verified"); // no cache mutation
  });

  it.each([
    ["scanner not actionable", "estimate", "FEED_UNCONFIRMED"],
    ["chart stale", "stale", "FEED_STALE"],
    ["chart unavailable", "unavailable", "NO_FEED"],
  ] as const)("downgrades every claim when the cap applies: %s", (scenario, priceClass, priceReason) => {
    const value = input();
    if (scenario === "scanner not actionable") value.scannerTruth!.actionable = false;
    if (scenario === "chart stale") { value.scannerTruth!.actionable = false; value.scannerTruth!.candles.status = "stale"; }
    if (scenario === "chart unavailable") { value.scannerTruth!.actionable = false; value.scannerTruth!.candles.status = "unavailable"; }
    const resolved = resolveSymbolTruthEvidence(value);
    expect(resolved.actionCapped).toBe(true);
    const ev = resolved.snapshot!.evidence!;
    expect(ev.price).toMatchObject({ evidenceClass: priceClass, reason: priceReason });
    for (const c of Object.values(ev.components)) expect(c).toMatchObject({ evidenceClass: "unavailable", reason: "COMPONENT_ABSENT" });
    expect(ev.levels).toMatchObject({ evidenceClass: "unavailable", reason: "LEVELS_WITHHELD" });
    expect(ev.verdict).toMatchObject({ evidenceClass: "unavailable", reason: "INSUFFICIENT_DATA" });
    expect(Object.values(ev).some((c) => (c as { evidenceClass?: string }).evidenceClass === "verified")).toBe(false);
  });

  it("invents nothing for an older server that sends no classification", () => {
    const value = input(false);
    const resolved = resolveSymbolTruthEvidence(value);
    expect(resolved.snapshot).toBe(value.snapshot);
    expect(resolved.snapshot?.evidence).toBeUndefined();
    value.scannerTruth!.actionable = false;
    expect(resolveSymbolTruthEvidence(value).snapshot?.evidence).toBeUndefined();
  });

  it("treats malformed server claims as unavailable and a non-object as absent", () => {
    const value = input();
    (value.snapshot!.evidence as unknown as Record<string, unknown>).price = { evidenceClass: "verified", reason: "MODEL_ESTIMATE", observedAt: CLOSE };
    expect(resolveSymbolTruthEvidence(value).snapshot?.evidence?.price).toEqual({ evidenceClass: "unavailable", reason: "UNCLASSIFIED", observedAt: null });
    const junk = input();
    (junk.snapshot as unknown as Record<string, unknown>).evidence = "verified";
    expect(resolveSymbolTruthEvidence(junk).snapshot?.evidence).toBeUndefined();
  });

  it("an expired snapshot is withdrawn entirely, classes included", () => {
    const value = input(); value.nowMs += SYMBOL_TRUTH_MAX_AGE_MS + 1;
    expect(resolveSymbolTruthEvidence(value)).toEqual({ snapshot: null, actionCapped: true });
  });
  // Review 2026-10-27 finding 5: an unchecked calendar has its own reason.
  it("labels an unchecked calendar CALENDAR_UNCHECKED and downgrades a server claim that hides it", () => {
    const value = input();
    value.snapshot!.news = { ...value.snapshot!.news, providerConnected: false, riskUnchecked: true,
      riskLabel: "Event risk is unavailable — the economic calendar could not be checked.",
      disclaimer: "The economic calendar could not be checked, so scheduled events are not shown." };
    // A server claim that still says "connected calendar" (estimate) is weaker-capped.
    value.snapshot!.evidence!.news = { evidenceClass: "estimate", reason: "CALENDAR_FETCH_TIME_UNKNOWN", observedAt: null };
    expect(resolveSymbolTruthEvidence(value).snapshot?.evidence?.news)
      .toEqual({ evidenceClass: "unavailable", reason: "CALENDAR_UNCHECKED", observedAt: null });
    // The server's own CALENDAR_UNCHECKED claim stands as supplied.
    const fresh = input();
    fresh.snapshot!.news = { ...value.snapshot!.news };
    fresh.snapshot!.evidence = serverEvidence(fresh.snapshot!);
    expect(fresh.snapshot!.evidence.news.reason).toBe("CALENDAR_UNCHECKED");
    expect(resolveSymbolTruthEvidence(fresh).snapshot?.evidence?.news.reason).toBe("CALENDAR_UNCHECKED");
  });
});
