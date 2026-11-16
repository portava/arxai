/** Normalized transport evidence for hook tests that seed the shared cache. */
export function withOriginalChartResponse<T extends {
  candles: { time: number; open: number; high: number; low: number; close: number }[];
  feedStatus: { symbol: string; source: string };
}>(input: T, timeframe = "M1", intervalMs = 60_000) {
  const iso = (ms: number) => Number.isFinite(new Date(ms).getTime()) ? new Date(ms).toISOString() : "invalid";
  const lastClosed = input.candles.filter(c => c.time + intervalMs <= Date.now()).at(-1);
  const marketEvidence = {
    symbol: input.feedStatus.symbol, timeframe, source: input.feedStatus.source,
    sourceIdentity: "a".repeat(64), lastClosedCandleAt: lastClosed ? iso(lastClosed.time + intervalMs) : null,
  };
  return { ...input, marketEvidence, originalResponse: {
    marketEvidence,
    symbol: input.feedStatus.symbol, timeframe, source: input.feedStatus.source,
    quality: "clean", aiUsable: true, feedStatus: input.feedStatus,
    candles: input.candles.map(c => ({ ...c, time: undefined,
      symbol: input.feedStatus.symbol, timeframe, source: input.feedStatus.source, sourceMode: "live", qualityFlags: [],
      openTime: iso(c.time), closeTime: iso(c.time + intervalMs),
      isComplete: c.time + intervalMs <= Date.now(),
      isForming: c.time + intervalMs > Date.now(), isFinal: c.time + intervalMs <= Date.now(),
    })),
  } };
}
