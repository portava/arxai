import { describe, it, expect } from "vitest";
import type { ChartCandlesResponse } from "@workspace/api-client-react";
import {
  captureChartResearchWindow,
  bindChartResearchResult,
  type ChartResearchSnapshot,
} from "./chartResearchEvidence";
const START = Date.parse("2026-10-25T10:00:00Z"),
  STEP = 60_000,
  NOW = START + 10 * STEP;
const expected = { symbol: "EURUSD", timeframe: "M1" };
function fixture() {
  const candles = Array.from({ length: 10 }, (_, i) => ({
    ...expected,
    displaySymbol: "EUR/USD",
    openTime: new Date(START + i * STEP).toISOString(),
    closeTime: new Date(START + (i + 1) * STEP).toISOString(),
    open: 100 + i,
    high: 102 + i,
    low: 99 + i,
    close: 101 + i,
    volume: 0,
    tickVolume: null,
    source: "mt5_broker",
    sourceMode: "live",
    priceBasis: "BID",
    priceBasisEvidence: {kind:"producer_declared",basis:"BID",reason:null},
    // Controlled normalized fixture, not a claim about a shipped MT5 adapter.
    timeBasisEvidence: {kind:"original_utc",basis:"UTC",authority:"offline:utc-clock-fixture-v1",reason:null},
    isComplete: true,
    isFinal: true,
    isForming: false,
    receivedAt: new Date(NOW).toISOString(),
    qualityFlags: [],
  }));
  const data = {
    ...expected,
    source: "mt5_broker",
    quality: "clean",
    candles,
    feedStatus: { source: "mt5_broker" },
    marketEvidence: {
      ...expected,
      source: "mt5_broker",
      sourceIdentity: "a".repeat(64),
      lastClosedCandleAt: candles.at(-1)!.closeTime,
    },
  } as unknown as ChartCandlesResponse;
  const visibleBars = candles.map((c) => ({
    time: Date.parse(c.openTime) / 1000,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
  }));
  return { data, visibleBars, expected, asOfMs: NOW };
}
const capture = () => captureChartResearchWindow(fixture()).snapshot!;
const config = {
  splits: { trainEndExclusive: 4, validationEndExclusive: 7 },
  strategy: { version: "example" },
};
function result(snapshot: ChartResearchSnapshot) {
  return {
    engineVersion: "arx-quote-ohlc-research-v2",
    classification: "diagnostic",
    verification: "unverified",
    pnlUnit: "price_units_per_unit",
    authority: {
      promotionEligible: false,
      brokerVerified: false,
      persistedExperiment: false,
    },
    inputSnapshot: structuredClone(snapshot.researchInput),
    configSnapshot: structuredClone(config),
    partitions: [
      {
        name: "train",
        fromInclusive: 0,
        toExclusive: 4,
        trades: [
          {
            signalIndex: 0,
            entryIndex: 1,
            exitIndex: 2,
            entryTimeMs: START + STEP,
            side: "BUY",
            entryReferencePrice: 101,
            entryPrice: 101.1,
            exitPrice: 102,
            stopPrice: 99,
            targetPrice: 105,
            exitTime: {
              earliestMs: START + 2 * STEP,
              latestMs: START + 3 * STEP,
              precision: "bar_interval",
            },
            reason: "target",
            ambiguousStopAndTarget: false,
          },
        ],
      },
      { name: "validation", fromInclusive: 4, toExclusive: 7, trades: [] },
      { name: "holdout", fromInclusive: 7, toExclusive: 10, trades: [] },
    ],
  };
}
const current = (snapshot: ChartResearchSnapshot) => ({
  contextKey: snapshot.contextKey,
  bars: fixture().visibleBars,
  data: fixture().data,
  asOfMs: NOW,
});

describe("historical chart capture qualification", () => {
  it("captures original BID prices immutably without granting broker or live authority", () => {
    const input = fixture(),
      before = structuredClone(input),
      s = captureChartResearchWindow(input).snapshot!;
    expect(s.researchInput.priceBasis).toBe("BID");
    expect(s.researchInput.source.kind).toBe("historical_unattested");
    expect(s.coverage).toMatchObject({
      closedBars: 10,
      expectedBars: 10,
      gapCount: 0,
      continuity: "contiguous",
    });
    expect(Object.isFrozen(s.researchInput.bars[0])).toBe(true);
    expect(Object.isFrozen(input.data.marketEvidence)).toBe(false);
    expect(input).toEqual(before);
  });
  it("accepts MID and stale historical data without requiring current quote freshness", () => {
    const input = fixture();
    input.data.candles.forEach((c) => {c.priceBasis = "MID"; (c as any).priceBasisEvidence.basis="MID";});
    input.data.quality = "stale";
    expect(
      captureChartResearchWindow(input).snapshot?.researchInput.priceBasis,
    ).toBe("MID");
  });
  it.each([
    [
      "unknown basis",
      (f: ReturnType<typeof fixture>) => {
        f.data.candles[0]!.priceBasis = "UNKNOWN";
      },
    ],
    [
      "last price is not MID",
      (f: ReturnType<typeof fixture>) => {
        f.data.candles[0]!.priceBasis = "LAST";
      },
    ],
    [
      "synthetic is not BID",
      (f: ReturnType<typeof fixture>) => {
        f.data.candles[0]!.priceBasis = "SYNTHETIC";
      },
    ],
    [
      "mixed source mode",
      (f: ReturnType<typeof fixture>) => {
        f.data.candles[0]!.sourceMode = "demo";
      },
    ],
    [
      "mixed basis",
      (f: ReturnType<typeof fixture>) => {
        f.data.candles[0]!.priceBasis = "MID";
      },
    ],
    [
      "missing identity",
      (f: ReturnType<typeof fixture>) => {
        f.data.marketEvidence!.sourceIdentity = "";
      },
    ],
    [
      "source mismatch",
      (f: ReturnType<typeof fixture>) => {
        f.data.feedStatus.source = "deriv_public";
      },
    ],
    [
      "wrong asset",
      (f: ReturnType<typeof fixture>) => {
        f.data.candles[0]!.symbol = "GBPUSD";
      },
    ],
    [
      "wrong interval",
      (f: ReturnType<typeof fixture>) => {
        f.data.candles[0]!.timeframe = "M5";
      },
    ],
    [
      "unclosed flags",
      (f: ReturnType<typeof fixture>) => {
        f.data.candles[0]!.isFinal = false;
      },
    ],
    [
      "bad geometry",
      (f: ReturnType<typeof fixture>) => {
        f.data.candles[0]!.high = 1;
        f.visibleBars[0]!.high = 1;
      },
    ],
    [
      "nonfinite OHLC",
      (f: ReturnType<typeof fixture>) => {
        f.data.candles[0]!.low = NaN;
        f.visibleBars[0]!.low = NaN;
      },
    ],
    [
      "future closed",
      (f: ReturnType<typeof fixture>) => {
        f.asOfMs = NOW - 1;
      },
    ],
    [
      "bad close span",
      (f: ReturnType<typeof fixture>) => {
        f.data.candles[0]!.closeTime = new Date(START + STEP - 1).toISOString();
      },
    ],
    [
      "rendered HA instead of source OHLC",
      (f: ReturnType<typeof fixture>) => {
        f.visibleBars[0]!.close = 100.5;
      },
    ],
    [
      "unsupported deep history",
      (f: ReturnType<typeof fixture>) => {
        f.visibleBars.unshift({
          ...f.visibleBars[0]!,
          time: START / 1000 - 60,
        });
      },
    ],
  ])("refuses %s", (_name, mutate) => {
    const f = fixture();
    mutate(f);
    expect(captureChartResearchWindow(f).status).toBe("unavailable");
  });
  it("does not substitute loaded history for a longer explicit request", () => {
    const f = fixture();
    expect(
      captureChartResearchWindow({
        ...f,
        requestedWindow: { fromInclusiveMs: START - STEP, toExclusiveMs: NOW },
      }).status,
    ).toBe("unavailable");
    expect(
      captureChartResearchWindow({
        ...f,
        requestedWindow: { fromInclusiveMs: START + 1, toExclusiveMs: NOW },
      }).status,
    ).toBe("unavailable");
    const selected = captureChartResearchWindow({
      ...f,
      requestedWindow: {
        fromInclusiveMs: START + STEP,
        toExclusiveMs: NOW - STEP,
      },
    }).snapshot!;
    expect(selected.researchInput.bars).toHaveLength(8);
    expect(selected.coverage.selection).toBe("requested");
  });
  it("preserves gaps as explicit uncertainty and holds when complete history is required", () => {
    const f = fixture();
    f.data.candles.splice(3, 2);
    f.visibleBars.splice(3, 2);
    const exploratory = captureChartResearchWindow(f).snapshot!;
    expect(exploratory.coverage).toMatchObject({
      closedBars: 8,
      expectedBars: 10,
      gapCount: 1,
      missingIntervals: 2,
      continuity: "unverified_gaps",
    });
    expect(exploratory.limitations.join(" ")).toContain(
      "no bars were interpolated",
    );
    expect(
      captureChartResearchWindow({ ...f, requireCompleteHistory: true }).status,
    ).toBe("unavailable");
  });
  it("omits only an explicitly forming visible tail, reports it and does not extend requested coverage", () => {
    const f = fixture(),
      last = f.data.candles.at(-1)!;
    f.data.candles.push({
      ...last,
      openTime: new Date(NOW).toISOString(),
      closeTime: new Date(NOW + STEP).toISOString(),
      isComplete: false,
      isFinal: false,
      isForming: true,
    });
    f.visibleBars.push({ ...f.visibleBars.at(-1)!, time: NOW / 1000 });
    expect(
      captureChartResearchWindow(f).snapshot?.coverage.excludedFormingBars,
    ).toBe(1);
    expect(
      captureChartResearchWindow({
        ...f,
        asOfMs: NOW + STEP,
        requestedWindow: { fromInclusiveMs: START, toExclusiveMs: NOW + STEP },
      }).status,
    ).toBe("unavailable");
  });
  it("refuses replay without original price-basis metadata and malformed response shapes", () => {
    expect(
      captureChartResearchWindow({ ...fixture(), replayActive: true }).status,
    ).toBe("unavailable");
    const f = fixture();
    f.data.candles[0] = null as never;
    expect(captureChartResearchWindow(f).status).toBe("unavailable");
  });
});

describe("historical ledger binds to captured chart bars", () => {
  it("uses bar coordinates separately from modeled intrabar fill intervals", () => {
    const s = capture(),
      r = bindChartResearchResult(s, result(s), current(s), config);
    expect(r.status).toBe("ready");
    expect(r.trades[0]!.entry.fillTime).toEqual({
      earliestMs: START + STEP,
      latestMs: START + STEP,
      precision: "open",
    });
    expect(r.trades[0]!.exit).toMatchObject({
      barOpenMs: START + 2 * STEP,
      fillTime: {
        earliestMs: START + 2 * STEP,
        latestMs: START + 3 * STEP,
        precision: "bar_interval",
      },
    });
  });
  it.each(["stop_gap", "target_gap_capped", "max_hold_next_open"])(
    "retains exact modeled open time for %s",
    (reason) => {
      const s = capture(),
        r = result(s),
        t = r.partitions[0]!.trades[0]!;
      t.reason = reason;
      t.exitTime.precision = "open";
      t.exitTime.latestMs = t.exitTime.earliestMs;
      expect(
        bindChartResearchResult(s, r, current(s), config).trades[0]!.exit
          .fillTime,
      ).toEqual({
        earliestMs: START + 2 * STEP,
        latestMs: START + 2 * STEP,
        precision: "open",
      });
    },
  );
  it("accepts a SELL bracket ordered around its modeled entry fill", () => {
    const s = capture(),
      r = result(s),
      t = r.partitions[0]!.trades[0]!;
    t.side = "SELL";
    t.entryPrice = 100.9;
    t.stopPrice = 103;
    t.targetPrice = 98;
    expect(
      bindChartResearchResult(s, r, current(s), config).trades[0]?.side,
    ).toBe("SELL");
  });
  it.each(["context", "corrected price", "missing bar", "duplicate bar"])(
    "withdraws on current-chart %s",
    (scenario) => {
      const s = capture(),
        c = current(s);
      if (scenario === "context") c.contextKey = "other";
      if (scenario === "corrected price") c.bars[0]!.close += 0.1;
      if (scenario === "missing bar") c.bars.pop();
      if (scenario === "duplicate bar") c.bars.push(c.bars[0]!);
      expect(bindChartResearchResult(s, result(s), c, config).status).toBe(
        "unavailable",
      );
    },
  );
  it.each(["basis", "mode", "finality", "source", "identity", "quality"])(
    "withdraws on original metadata %s",
    (scenario) => {
      const s = capture(),
        c = current(s);
      if (scenario === "basis")
        c.data.candles.forEach((bar) => {
          bar.priceBasis = "MID";
        });
      if (scenario === "mode")
        c.data.candles.forEach((bar) => {
          bar.sourceMode = "demo";
        });
      if (scenario === "finality") c.data.candles[0]!.isFinal = false;
      if (scenario === "source") c.data.source = "deriv_public";
      if (scenario === "identity")
        c.data.marketEvidence!.sourceIdentity = "b".repeat(64);
      if (scenario === "quality") c.data.quality = "invalid";
      expect(bindChartResearchResult(s, result(s), c, config).status).toBe(
        "unavailable",
      );
    },
  );
  it("keeps unchanged historical evidence bound as wall time advances", () => {
    const s = capture(),
      c = current(s);
    c.asOfMs += 86400000;
    c.data.quality = "stale";
    expect(bindChartResearchResult(s, result(s), c, config).status).toBe(
      "ready",
    );
  });
  it.each([
    "input",
    "config",
    "authority",
    "partition",
    "entry",
    "exit interval",
    "false precise stop",
    "future index",
    "overlap",
    "entry reference",
    "inverted bracket",
    "engine version",
  ])("rejects mismatching %s", (scenario) => {
    const s = capture(),
      r = result(s),
      t = r.partitions[0]!.trades[0]!;
    if (scenario === "entry reference") t.entryReferencePrice += 0.1;
    if (scenario === "inverted bracket") t.stopPrice = 105;
    if (scenario === "engine version")
      r.engineVersion = "arx-mid-ohlc-research-v1";
    if (scenario === "input") r.inputSnapshot.bars[0]!.close += 0.1;
    if (scenario === "config") r.configSnapshot.splits.trainEndExclusive = 3;
    if (scenario === "authority") r.authority.brokerVerified = true;
    if (scenario === "partition") r.partitions[0]!.toExclusive = 5;
    if (scenario === "entry") t.entryTimeMs += 1;
    if (scenario === "exit interval") t.exitTime.latestMs -= 1;
    if (scenario === "false precise stop") {
      t.reason = "stop";
      t.exitTime.precision = "open";
      t.exitTime.latestMs = t.exitTime.earliestMs;
    }
    if (scenario === "future index") t.exitIndex = 10;
    if (scenario === "overlap") r.partitions[0]!.trades.push({ ...t });
    expect(bindChartResearchResult(s, r, current(s), config).status).toBe(
      "unavailable",
    );
  });
});


describe("original declared quote-basis evidence",()=>{
  it("refuses the legacy MT5 profile-MID payload without original declaration evidence",()=>{
    const f=fixture();for(const bar of f.data.candles){bar.priceBasis="MID";delete (bar as any).priceBasisEvidence;}
    expect(captureChartResearchWindow(f).status).toBe("unavailable");
  });
  it.each([
    undefined,
    {kind:"unavailable",basis:null,reason:"Profile inference is not producer evidence"},
    {kind:"profile_inferred",basis:"BID",reason:null},
    {kind:"producer_declared",basis:"MID",reason:null},
    {kind:"producer_declared",basis:"BID",reason:"Declaration withheld"},
  ])("holds missing or contradictory basis authority %j",evidence=>{
    const f=fixture();(f.data.candles[0] as any).priceBasisEvidence=evidence;
    expect(captureChartResearchWindow(f).status).toBe("unavailable");
  });
  it("records the explicit declaration authority in the immutable snapshot",()=>{
    const s=capture();expect(s).toMatchObject({version:3,priceBasisEvidence:{kind:"producer_declared",basis:"BID",reason:null}});
  });
  it("withdraws existing markers when declaration metadata disappears with identical prices",()=>{
    const s=capture(),c=current(s);delete (c.data!.candles[0] as any).priceBasisEvidence;
    expect(bindChartResearchResult(s,result(s),c,config).status).toBe("unavailable");
  });
  it.each(["legacy_version","missing_evidence","changed_evidence"])("refuses unsupported snapshot authority %s",scenario=>{
    const s=structuredClone(capture());
    if(scenario==="legacy_version") (s as any).version=1;
    if(scenario==="missing_evidence") delete (s as any).priceBasisEvidence;
    if(scenario==="changed_evidence") s.priceBasisEvidence.basis="MID";
    expect(bindChartResearchResult(s,result(s),current(s),config).status).toBe("unavailable");
  });
});


describe("original UTC research authority", () => {
  it.each([undefined, {kind:"unavailable",basis:"BROKER_SERVER",authority:null,reason:"Broker clock"}, {kind:"original_utc",basis:"UTC",authority:"",reason:null}])("holds raw ISO Z coordinates without qualified original UTC evidence: %j", evidence => {
    const input=fixture();
    (input.data.candles[0] as any).timeBasisEvidence=evidence;
    const read=captureChartResearchWindow(input);
    expect(read.status).toBe("unavailable");
    expect(read.reason).toMatch(/UTC|clock/i);
  });
  it("refuses mixed clock authorities even when prices/timestamps match", () => {
    const input=fixture();
    (input.data.candles[1] as any).timeBasisEvidence.authority="offline:other-clock";
    expect(captureChartResearchWindow(input).status).toBe("unavailable");
  });
  it("withdraws a completed result after original UTC evidence disappears", () => {
    const input=fixture(), snapshot=captureChartResearchWindow(input).snapshot!;
    delete (input.data.candles[0] as any).timeBasisEvidence;
    const bound=bindChartResearchResult(snapshot,result(snapshot),{contextKey:snapshot.contextKey,bars:input.visibleBars,data:input.data,asOfMs:NOW},config);
    expect(bound.status).toBe("unavailable");expect(bound.trades).toEqual([]);
  });
  it("rejects prior version2 snapshots rather than minting missing time authority", () => {
    const input=fixture(), snapshot=captureChartResearchWindow(input).snapshot!;
    const old={...snapshot,version:2};
    const bound=bindChartResearchResult(old as ChartResearchSnapshot,result(snapshot),{contextKey:snapshot.contextKey,bars:input.visibleBars,data:input.data,asOfMs:NOW},config);
    expect(bound.status).toBe("unavailable");
  });
});
