import { originalUtcAuthority } from "./chartClockEvidence";
import type { ChartCandlesResponse } from "@workspace/api-client-react";
import type { ChartEngineCandle } from "./types";
import { captureSmartChartBars } from "./smartChartCapture";
import { smartChartIntervalSeconds } from "./smartChartAnalysis";

/** Evidence adapter only. Pricing, signals, costs and metrics belong to the
 * existing causal research engine; no chart display transformation enters it. */
export interface ChartResearchBar {
  openTimeMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
}
export interface ChartResearchInput {
  symbol: string;
  priceBasis: "BID" | "MID";
  intervalMs: number;
  asOfMs: number;
  source: { kind: "historical_unattested"; reference: string };
  bars: readonly ChartResearchBar[];
}
export interface ResearchWindow {
  fromInclusiveMs: number;
  toExclusiveMs: number;
}
export interface ChartResearchSnapshot {
  version: 3;
  timeBasisEvidence: {kind:"original_utc";basis:"UTC";authority:string;reason:null};
  priceBasisEvidence: {kind:"producer_declared";basis:"BID"|"MID";reason:null};
  contextKey: string;
  sourceMode: "live" | "demo";
  sourceEvidence: Readonly<NonNullable<ChartCandlesResponse["marketEvidence"]>>;
  researchInput: ChartResearchInput;
  coverage: ResearchWindow & {
    selection: "visible_closed" | "requested";
    closedBars: number;
    expectedBars: number;
    gapCount: number;
    missingIntervals: number;
    continuity: "contiguous" | "unverified_gaps";
    excludedFormingBars: number;
  };
  limitations: readonly string[];
}
export type ChartResearchCapture =
  | { status: "ready"; snapshot: ChartResearchSnapshot; reason: null }
  | { status: "unavailable"; snapshot: null; reason: string };
const unavailable = (reason: string): ChartResearchCapture => ({
  status: "unavailable",
  snapshot: null,
  reason,
});
const MAX_CHART_RESEARCH_BARS = 5_000;
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const integer = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value);
const positive = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;
const samePrices = (
  a: Pick<ChartEngineCandle, "open" | "high" | "low" | "close">,
  b: Pick<ChartEngineCandle, "open" | "high" | "low" | "close">,
) =>
  a.open === b.open &&
  a.high === b.high &&
  a.low === b.low &&
  a.close === b.close;
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}
export function chartResearchContextKey(
  expected: { symbol: string; timeframe: string },
  source: string | null | undefined,
  sourceIdentity: string | null | undefined,
): string {
  return JSON.stringify([
    expected.symbol,
    expected.timeframe,
    source ?? null,
    sourceIdentity ?? null,
  ]);
}

/** Exact closed coverage only. Older display-adapted pages and replay snapshots
 * lack the original per-bar price basis/finality required here; they cannot be
 * stamped with today's source evidence or recast as MID. */
export function captureChartResearchWindow(args: {
  data: ChartCandlesResponse | undefined;
  expected: { symbol: string; timeframe: string };
  visibleBars: readonly ChartEngineCandle[];
  asOfMs: number;
  requestedWindow?: ResearchWindow;
  replayActive?: boolean;
  requireCompleteHistory?: boolean;
}): ChartResearchCapture {
  try {
    const { data, expected, visibleBars, asOfMs, requestedWindow } = args;
    if (args.replayActive)
      return unavailable(
        "This replay snapshot does not retain original price-basis evidence for historical testing.",
      );
    if (
      !data ||
      !Array.isArray(data.candles) ||
      data.candles.length > MAX_CHART_RESEARCH_BARS + 1 ||
      !integer(asOfMs) ||
      asOfMs <= 0
    )
      return unavailable(
        "A bounded original candle response and valid observation cutoff are required.",
      );
    const bound = captureSmartChartBars(data, expected, [], null, asOfMs);
    if (bound.status !== "ready")
      return unavailable(
        bound.reason ?? "Original candle evidence is unavailable.",
      );
    const intervalMs =
      (smartChartIntervalSeconds(expected.timeframe) ?? 0) * 1000;
    if (!intervalMs || !Array.isArray(visibleBars) || !visibleBars.length)
      return unavailable("The chart needs an applied canonical candle window.");
    const current = new Map(bound.bars.map((bar) => [bar.time, bar]));
    const tip = data.candles.at(-1)!;
    const formingTime =
      tip.isComplete === false &&
      tip.isFinal === false &&
      tip.isForming === true
        ? Date.parse(tip.openTime) / 1000
        : null;
    const visibleClosed: typeof bound.bars = [];
    let excludedFormingBars = 0,
      prior = -Infinity;
    for (const [index, bar] of visibleBars.entries()) {
      if (!bar || !Number.isFinite(bar.time) || bar.time <= prior)
        return unavailable(
          "The applied chart window is malformed or not chronological.",
        );
      prior = bar.time;
      const original = current.get(bar.time);
      if (!original) {
        if (index === visibleBars.length - 1 && bar.time === formingTime) {
          excludedFormingBars++;
          continue;
        }
        return unavailable(
          "Visible history lacks original closed-candle evidence; load a supported source window before testing.",
        );
      }
      if (!samePrices(bar, original))
        return unavailable(
          "The displayed source prices have changed; wait for the chart to apply the matching candle response.",
        );
      visibleClosed.push(original);
    }
    if (!visibleClosed.length)
      return unavailable("No proven closed candles are visible.");
    const fromInclusiveMs =
      requestedWindow?.fromInclusiveMs ?? visibleClosed[0]!.time * 1000;
    const toExclusiveMs =
      requestedWindow?.toExclusiveMs ?? visibleClosed.at(-1)!.closeTime * 1000;
    if (
      !integer(fromInclusiveMs) ||
      !integer(toExclusiveMs) ||
      fromInclusiveMs < 0 ||
      toExclusiveMs <= fromInclusiveMs ||
      toExclusiveMs > asOfMs
    )
      return unavailable(
        "The requested historical window must have valid closed boundaries no later than the observation cutoff.",
      );
    const selected = bound.bars.filter(
      (bar) =>
        bar.time * 1000 >= fromInclusiveMs &&
        bar.closeTime * 1000 <= toExclusiveMs,
    );
    const expectedBars = (toExclusiveMs - fromInclusiveMs) / intervalMs;
    if (
      !integer(expectedBars) ||
      selected.length < 3 ||
      selected.length > MAX_CHART_RESEARCH_BARS ||
      selected.length > expectedBars ||
      selected[0]!.time * 1000 !== fromInclusiveMs ||
      selected.at(-1)!.closeTime * 1000 !== toExclusiveMs
    )
      return unavailable(
        "The exact requested closed-history boundaries are not loaded or cannot be represented. A shorter sample will not be substituted.",
      );
    const originals = new Map(
      data.candles.map((bar) => [Date.parse(bar.openTime) / 1000, bar]),
    );
    let basis: "BID" | "MID" | null = null,
      previousClose = fromInclusiveMs,
      gapCount = 0,
      missingIntervals = 0;
    let clockAuthority: string | null = null;
    let sourceMode: "live" | "demo" | null = null;
    const bars: ChartResearchBar[] = [];
    for (const bar of selected) {
      const openTimeMs = bar.time * 1000,
        closeTimeMs = bar.closeTime * 1000,
        original = originals.get(bar.time)!;
      if (
        !integer(openTimeMs) ||
        !integer(closeTimeMs) ||
        openTimeMs < previousClose ||
        (openTimeMs - previousClose) % intervalMs !== 0 ||
        closeTimeMs - openTimeMs !== intervalMs ||
        closeTimeMs > asOfMs
      )
        return unavailable(
          "Overlapping, irregular or unclosed intervals prevent a historical test.",
        );
      if (openTimeMs > previousClose) {
        gapCount++;
        missingIntervals += (openTimeMs - previousClose) / intervalMs;
      }
      if (
        ![bar.open, bar.high, bar.low, bar.close].every(positive) ||
        bar.high < Math.max(bar.open, bar.low, bar.close) ||
        bar.low > Math.min(bar.open, bar.close)
      )
        return unavailable("Historical candle prices are malformed.");
      const authority = originalUtcAuthority(record(original)?.timeBasisEvidence);
      if (!authority)
        return unavailable("Historical research requires qualified original UTC candle times. These source-clock coordinates have no verified historical UTC mapping; a Z label or current broker offset is insufficient.");
      if (clockAuthority && clockAuthority !== authority)
        return unavailable("The requested candles mix different original UTC clock authorities.");
      clockAuthority = authority;
      if (original.priceBasis !== "BID" && original.priceBasis !== "MID")
        return unavailable(
          "Historical testing currently supports original BID or MID prices only; this source basis is unsupported.",
        );
      const basisEvidence = record(record(original)?.priceBasisEvidence);
      if (basisEvidence?.kind !== "producer_declared" || basisEvidence.basis !== original.priceBasis || basisEvidence.reason !== null)
        return unavailable("The feed has not supplied matching original BID/MID price-basis evidence. An asset profile or older API label cannot establish historical spread costs.");
      if (basis && basis !== original.priceBasis)
        return unavailable("The requested candles mix different price bases.");
      if (
        (original.sourceMode !== "live" && original.sourceMode !== "demo") ||
        (sourceMode && sourceMode !== original.sourceMode)
      )
        return unavailable("The requested candles mix different source modes.");
      sourceMode = original.sourceMode;
      basis = original.priceBasis;
      previousClose = closeTimeMs;
      bars.push({
        openTimeMs,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
      });
    }
    if (args.requireCompleteHistory && gapCount)
      return unavailable(
        "Complete-history testing requires verified continuity; missing bars and session closures cannot be distinguished here.",
      );
    const evidence = data.marketEvidence!;
    const researchInput: ChartResearchInput = {
      symbol: expected.symbol,
      priceBasis: basis!,
      intervalMs,
      asOfMs,
      source: {
        kind: "historical_unattested",
        reference: `chart:${evidence.sourceIdentity}:${expected.timeframe}`,
      },
      bars,
    };
    const snapshot: ChartResearchSnapshot = {
      version: 3,
      timeBasisEvidence: {kind:"original_utc",basis:"UTC",authority:clockAuthority!,reason:null},
      priceBasisEvidence: {kind:"producer_declared",basis:basis!,reason:null},
      sourceMode: sourceMode!,
      contextKey: chartResearchContextKey(
        expected,
        evidence.source,
        evidence.sourceIdentity,
      ),
      sourceEvidence: {
        symbol: evidence.symbol,
        timeframe: evidence.timeframe,
        source: evidence.source,
        sourceIdentity: evidence.sourceIdentity,
        lastClosedCandleAt: evidence.lastClosedCandleAt,
      },
      researchInput,
      coverage: {
        fromInclusiveMs,
        toExclusiveMs,
        selection: requestedWindow ? "requested" : "visible_closed",
        closedBars: bars.length,
        expectedBars,
        gapCount,
        missingIntervals,
        continuity: gapCount ? "unverified_gaps" : "contiguous",
        excludedFormingBars,
      },
      limitations: [
        "The original producer declared the candle price basis; this is retained evidence, not independent broker verification.",
        "Historical source observations are captured, not broker-verified or an immutable persisted experiment.",
        "Prices are original source OHLC, even when the chart displays Heikin Ashi or another transformed style.",
        "Spread, slippage and fees are explicit scenarios; tick counts and current quote freshness do not establish historical execution conditions.",
        "Only the captured closed interval is tested; no missing history, market sessions or future observations are invented.",
        ...(gapCount
          ? [
              `${gapCount} elapsed gaps span ${missingIntervals} unobserved intervals. Session closures and missing bars cannot be distinguished; continuity is unverified and no bars were interpolated.`,
            ]
          : []),
      ],
    };
    return { status: "ready", snapshot: freeze(snapshot), reason: null };
  } catch {
    return unavailable(
      "The original candle evidence is malformed or incomplete.",
    );
  }
}

export interface ChartResearchFill {
  barOpenMs: number;
  price: number;
  fillTime: {
    earliestMs: number;
    latestMs: number;
    precision: "open" | "bar_interval";
  };
}
export interface ChartResearchTradeBinding {
  partition: "train" | "validation" | "holdout";
  tradeIndex: number;
  side: "BUY" | "SELL";
  signalBarOpenMs: number;
  entry: ChartResearchFill;
  exit: ChartResearchFill;
  stopPrice: number;
  targetPrice: number;
  reason: string;
  ambiguousStopAndTarget: boolean;
}
export type ChartResearchBinding =
  | { status: "ready"; trades: ChartResearchTradeBinding[]; reason: null }
  | { status: "unavailable"; trades: []; reason: string };
const stable = (value: unknown): string =>
  JSON.stringify(value, (_key, item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    return Object.fromEntries(
      Object.entries(item).sort(([a], [b]) => a.localeCompare(b)),
    );
  });
/** Bind the existing engine's ledger to the captured original bars. Bar-open
 * coordinates are chart anchors, never claims about intrabar execution time.
 * The controller must also discard obsolete Worker request IDs. */
export function bindChartResearchResult(
  snapshot: ChartResearchSnapshot,
  result: unknown,
  current: {
    contextKey: string;
    bars: readonly ChartEngineCandle[];
    data: ChartCandlesResponse | undefined;
    asOfMs: number;
  },
  expectedConfig: unknown,
): ChartResearchBinding {
  const no = (reason: string): ChartResearchBinding => ({
    status: "unavailable",
    trades: [],
    reason,
  });
  try {
    if (snapshot.version !== 3 || !originalUtcAuthority(snapshot.timeBasisEvidence))
      return no("This historical snapshot lacks qualified original UTC clock evidence; its chart markers are withheld. Older snapshots are not upgraded.");
    if ( snapshot.priceBasisEvidence?.kind !== "producer_declared"
      || snapshot.priceBasisEvidence.basis !== snapshot.researchInput.priceBasis || snapshot.priceBasisEvidence.reason !== null)
      return no("This historical snapshot lacks original price-basis evidence; its chart markers are withheld.");
    if (current.contextKey !== snapshot.contextKey)
      return no(
        "The chart source or market changed; this historical result is no longer bound.",
      );
    const qualified = captureChartResearchWindow({
      data: current.data,
      expected: {
        symbol: snapshot.sourceEvidence.symbol,
        timeframe: snapshot.sourceEvidence.timeframe,
      },
      visibleBars: current.bars,
      asOfMs: current.asOfMs,
      requestedWindow: {
        fromInclusiveMs: snapshot.coverage.fromInclusiveMs,
        toExclusiveMs: snapshot.coverage.toExclusiveMs,
      },
    });
    if (
      qualified.status !== "ready" ||
      qualified.snapshot.contextKey !== snapshot.contextKey ||
      qualified.snapshot.sourceMode !== snapshot.sourceMode ||
      stable(qualified.snapshot.timeBasisEvidence) !== stable(snapshot.timeBasisEvidence) ||
      qualified.snapshot.researchInput.priceBasis !==
        snapshot.researchInput.priceBasis ||
      stable(qualified.snapshot.researchInput.bars) !==
        stable(snapshot.researchInput.bars)
    )
      return no(
        "Original source metadata or closed-history evidence changed; historical markers are withheld.",
      );
    const actual = new Map(current.bars.map((bar) => [bar.time * 1000, bar]));
    if (
      actual.size !== current.bars.length ||
      snapshot.researchInput.bars.some(
        (bar) =>
          !actual.has(bar.openTimeMs) ||
          !samePrices(bar, actual.get(bar.openTimeMs)!),
      )
    )
      return no(
        "The chart no longer contains the exact captured source prices; historical markers are withheld.",
      );
    const r = record(result),
      authority = record(r?.authority),
      input = record(r?.inputSnapshot),
      config = record(r?.configSnapshot);
    if (
      !r ||
      r.engineVersion !== "arx-quote-ohlc-research-v2" ||
      r.classification !== "diagnostic" ||
      r.verification !== "unverified" ||
      r.pnlUnit !== "price_units_per_unit" ||
      !authority ||
      authority.promotionEligible !== false ||
      authority.brokerVerified !== false ||
      authority.persistedExperiment !== false ||
      !input ||
      stable(input) !== stable(snapshot.researchInput) ||
      !config ||
      stable(config) !== stable(expectedConfig) ||
      !Array.isArray(r.partitions) ||
      r.partitions.length !== 3
    )
      return no(
        "The historical result does not match its captured inputs, configuration or diagnostic authority.",
      );
    const splits = record(config.splits),
      count = snapshot.researchInput.bars.length;
    const bounds = [
      0,
      splits?.trainEndExclusive,
      splits?.validationEndExclusive,
      count,
    ];
    if (
      !bounds.every(integer) ||
      !(
        (bounds[1] as number) > 0 &&
        (bounds[2] as number) > (bounds[1] as number) &&
        (bounds[2] as number) < count
      )
    )
      return no("Historical partition boundaries are invalid.");
    const trades: ChartResearchTradeBinding[] = [];
    for (const [partitionIndex, raw] of r.partitions.entries()) {
      const p = record(raw),
        name = (["train", "validation", "holdout"] as const)[partitionIndex]!;
      const from = bounds[partitionIndex] as number,
        to = bounds[partitionIndex + 1] as number;
      if (
        !p ||
        p.name !== name ||
        p.fromInclusive !== from ||
        p.toExclusive !== to ||
        !Array.isArray(p.trades)
      )
        return no(
          "The historical ledger partitions do not match the captured split.",
        );
      let previousExit = -1;
      for (const [tradeIndex, rawTrade] of p.trades.entries()) {
        const t = record(rawTrade),
          exit = record(t?.exitTime);
        if (
          !t ||
          !integer(t.signalIndex) ||
          !integer(t.entryIndex) ||
          !integer(t.exitIndex) ||
          t.signalIndex < from ||
          t.entryIndex !== t.signalIndex + 1 ||
          t.entryIndex <= previousExit ||
          t.exitIndex < t.entryIndex ||
          t.exitIndex >= to ||
          (t.side !== "BUY" && t.side !== "SELL") ||
          ![t.entryPrice, t.exitPrice, t.stopPrice, t.targetPrice].every(
            positive,
          ) ||
          typeof t.ambiguousStopAndTarget !== "boolean" ||
          typeof t.reason !== "string" ||
          !exit
        )
          return no(
            "A historical trade cannot be mapped to valid captured bars.",
          );
        const signal = snapshot.researchInput.bars[t.signalIndex]!,
          entry = snapshot.researchInput.bars[t.entryIndex]!,
          end = snapshot.researchInput.bars[t.exitIndex]!;
        if (
          t.entryReferencePrice !== entry.open ||
          (t.side === "BUY"
            ? !(
                Number(t.stopPrice) < Number(t.entryPrice) &&
                Number(t.entryPrice) < Number(t.targetPrice)
              )
            : !(
                Number(t.targetPrice) < Number(t.entryPrice) &&
                Number(t.entryPrice) < Number(t.stopPrice)
              ))
        )
          return no(
            "A historical entry reference or protective bracket conflicts with the captured ledger.",
          );
        const precision = [
          "stop_gap",
          "target_gap_capped",
          "max_hold_next_open",
        ].includes(t.reason)
          ? "open"
          : ["stop", "target"].includes(t.reason)
            ? "bar_interval"
            : null;
        if (
          !precision ||
          exit.precision !== precision ||
          (t.ambiguousStopAndTarget && t.reason !== "stop") ||
          t.entryTimeMs !== entry.openTimeMs ||
          exit.earliestMs !== end.openTimeMs ||
          (exit.precision !== "open" && exit.precision !== "bar_interval") ||
          exit.latestMs !==
            (exit.precision === "open"
              ? end.openTimeMs
              : end.openTimeMs + snapshot.researchInput.intervalMs)
        )
          return no(
            "A historical fill time overstates the captured OHLC time precision.",
          );
        previousExit = t.exitIndex;
        trades.push({
          partition: name,
          tradeIndex,
          side: t.side,
          signalBarOpenMs: signal.openTimeMs,
          entry: {
            barOpenMs: entry.openTimeMs,
            price: t.entryPrice as number,
            fillTime: {
              earliestMs: entry.openTimeMs,
              latestMs: entry.openTimeMs,
              precision: "open",
            },
          },
          exit: {
            barOpenMs: end.openTimeMs,
            price: t.exitPrice as number,
            fillTime: {
              earliestMs: exit.earliestMs as number,
              latestMs: exit.latestMs as number,
              precision: exit.precision,
            },
          },
          stopPrice: t.stopPrice as number,
          targetPrice: t.targetPrice as number,
          reason: t.reason,
          ambiguousStopAndTarget: t.ambiguousStopAndTarget,
        });
      }
    }
    return { status: "ready", trades, reason: null };
  } catch {
    return no("The historical result is malformed; no markers were applied.");
  }
}
