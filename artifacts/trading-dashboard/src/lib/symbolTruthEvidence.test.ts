import { describe, expect, it } from "vitest";
import type { MarketTruthResponse } from "@workspace/api-client-react";
import type { ScannerTruth } from "./scannerTruth";
import { classifyTruthEvidence, truthEvidenceRank, type TruthClaimEvidence, type TruthEvidence } from "@workspace/domain/truth";
import { resolveSymbolTruthEvidence, symbolTruthDeadline, symbolTruthRecheckAt, SYMBOL_TRUTH_MAX_AGE_MS, SYMBOL_TRUTH_NEWS_MAX_AGE_MS } from "./symbolTruthEvidence";

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
  it.each(["wrong symbol", "wrong timeframe", "too old even for its calendar state", "future", "invalid time", "failed refresh"])("withdraws the snapshot on %s", (scenario) => {
    const value = input();
    if (scenario === "wrong symbol") value.snapshot!.symbol = "GBPUSD";
    if (scenario === "wrong timeframe") value.snapshot!.timeframe = "M5";
    if (scenario === "too old even for its calendar state") value.nowMs += SYMBOL_TRUTH_NEWS_MAX_AGE_MS + 1;
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


function expectExpiredReadKeepsCalendar(value: Parameters<typeof resolveSymbolTruthEvidence>[0], resolved: ReturnType<typeof resolveSymbolTruthEvidence>) {
  expect(resolved.actionCapped).toBe(true);
  expect(resolved.snapshot).not.toBeNull();
  expect(resolved.snapshot?.news).toEqual(value.snapshot!.news);
  expect(resolved.snapshot?.data.lastCandleAt).toBe(value.snapshot!.data.lastCandleAt);
  expect(resolved.snapshot?.verdict).toMatchObject({ bias: "UNKNOWN", stage: "UNKNOWN", bestAction: "WATCH_ONLY", evidenceFor: [], invalidation: null });
  expect(resolved.snapshot?.levels).toMatchObject({ entryFrom: null, stopLoss: null, takeProfit: [], withheld: true });
  expect(Object.values(resolved.snapshot!.components).every((c) => !c.present && c.alignment === "UNKNOWN")).toBe(true);
}

describe("server component deadline", () => {
  it("uses the earlier exact boundary and cannot extend the existing horizon", () => {
    const value = input();
    Object.assign(value.snapshot!, { validUntil: new Date(NOW + 2000).toISOString() });
    expect(symbolTruthDeadline(value.snapshot)).toBe(NOW + 2000);
    expect(resolveSymbolTruthEvidence({ ...value, nowMs: NOW + 1999 }).actionCapped).toBe(false);
    expectExpiredReadKeepsCalendar(value, resolveSymbolTruthEvidence({ ...value, nowMs: NOW + 2000 }));
    Object.assign(value.snapshot!, { validUntil: new Date(NOW + 999_000).toISOString() });
    expect(symbolTruthDeadline(value.snapshot)).toBe(NOW + SYMBOL_TRUTH_MAX_AGE_MS + 1);
  });
  // A malformed supplied deadline resolves to the build time, i.e. it is treated
  // as ALREADY EXPIRED (never as permission to keep advice alive): the
  // directional read is withdrawn exactly like a past validUntil, while the
  // calendar state the read carries is kept — it is not candle evidence.
  it.each(["invalid", 1234, "", new Date(NOW - 1).toISOString()])("treats a malformed or past supplied deadline as expired advice but keeps the calendar state: %s", (validUntil) => {
    const value = input(); Object.assign(value.snapshot!, { validUntil });
    expectExpiredReadKeepsCalendar(value, resolveSymbolTruthEvidence(value));
  });
  it("owner state (1m bar closed, provider has not delivered the next bar, chart still on the same bar): an expired read never renders as confirmed, and news/data survive", () => {
    const value = input();
    const seeded = JSON.parse(JSON.stringify(value.snapshot)) as MarketTruthResponse;
    Object.assign(value.snapshot!, { validUntil: new Date(NOW - 1).toISOString() });
    // Fully confirmed scanner truth on the SAME candle identity as the snapshot.
    expect(value.scannerTruth?.actionable).toBe(true);
    expect(value.scannerLastCandleAt).toBe(value.snapshot!.data.lastCandleAt);
    const resolved = resolveSymbolTruthEvidence(value);
    expect(resolved.actionCapped).toBe(true);
    expect(resolved.snapshot?.verdict.bestAction).toBe("WATCH_ONLY");
    expect(resolved.snapshot?.levels.withheld).toBe(true);
    expect(resolved.snapshot?.news).toEqual(seeded.news);
    expect(resolved.snapshot?.data).toEqual(seeded.data); // server state kept: only expiry withheld this read
    // The expiry is described as an expiry, never as a feed problem.
    expect(resolved.snapshot?.verdict.headline).toMatch(/expired/i);
    expect(resolved.snapshot?.levels.withheldReason).toBe("The component evidence expired; waiting for a new read.");
    expect(Object.values(resolved.snapshot!.components).every((c) => c.label === "This read expired; waiting for current evidence.")).toBe(true);
    expect(JSON.stringify(resolved.snapshot)).not.toMatch(/live feed isn't confirmed/);
  });
  it("an expired read on an unconfirmed feed keeps the feed wording (the feed is the reason)", () => {
    const value = input(); value.scannerTruth!.actionable = false;
    Object.assign(value.snapshot!, { validUntil: new Date(NOW - 1).toISOString() });
    const resolved = resolveSymbolTruthEvidence(value);
    expect(resolved.snapshot?.verdict.headline).toMatch(/live feed isn't confirmed/);
    expect(resolved.snapshot?.data.state).not.toBe("LIVE_CONFIRMED");
    expect(resolved.snapshot?.news).toEqual(value.snapshot!.news);
  });
  it("never upgrades a server evidence class while keeping an expired read's calendar state", () => {
    const value = input();
    const server = classifyTruthEvidence({ nowMs: NOW, ...value.snapshot! });
    Object.assign(value.snapshot!, { validUntil: new Date(NOW - 1).toISOString(), evidence: server });
    const capped = resolveSymbolTruthEvidence(value).snapshot?.evidence as TruthEvidence;
    expect(capped).toBeTruthy();
    expect(capped.news).toEqual(server.news);
    const pairs: Array<[TruthClaimEvidence, TruthClaimEvidence]> = [
      [capped.price, server.price], [capped.lastCandle, server.lastCandle], [capped.news, server.news],
      [capped.levels, server.levels], [capped.verdict, server.verdict],
      ...(["scanner", "flame", "timing", "scalp"] as const).map((k) => [capped.components[k], server.components[k]] as [TruthClaimEvidence, TruthClaimEvidence]),
    ];
    for (const [after, before] of pairs) expect(truthEvidenceRank(after.evidenceClass)).toBeLessThanOrEqual(truthEvidenceRank(before.evidenceClass));
    expect(capped.verdict.evidenceClass).not.toBe("verified");
    expect(capped.levels.evidenceClass).toBe("unavailable");
  });
  it("rechecks at the advice deadline, then at the calendar-state bound", () => {
    const value = input(); Object.assign(value.snapshot!, { validUntil: new Date(NOW + 2000).toISOString() });
    expect(symbolTruthRecheckAt(value.snapshot, NOW)).toBe(NOW + 2000);
    expect(symbolTruthRecheckAt(value.snapshot, NOW + 2000)).toBe(NOW + SYMBOL_TRUTH_NEWS_MAX_AGE_MS + 1);
    expect(symbolTruthRecheckAt(null, NOW)).toBeNull();
  });
  it("retains the old-server cap when the optional field is absent or null", () => {
    const value = input(); expect(symbolTruthDeadline(value.snapshot)).toBe(NOW + SYMBOL_TRUTH_MAX_AGE_MS + 1);
    Object.assign(value.snapshot!, { validUntil: null });
    expect(symbolTruthDeadline(value.snapshot)).toBe(NOW + SYMBOL_TRUTH_MAX_AGE_MS + 1);
  });
});
