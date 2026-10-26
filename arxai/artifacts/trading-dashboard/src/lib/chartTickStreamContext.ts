/** Only a known source from the loaded candle contract can drive its tip. */
export function chartTickSource(value: unknown): "mt5_broker" | "deriv" | "deriv_public" | null {
  return value === "mt5_broker" || value === "deriv" || value === "deriv_public" ? value : null;
}

export function matchesChartTickContext(
  message: unknown,
  source: string, symbol: string, timeframe: string,
): boolean {
  if (typeof message !== "object" || message === null || Array.isArray(message)) return false;
  const frame = message as Record<string, unknown>;
  return chartTickSource(source) !== null && frame.source === source &&
    frame.symbol === symbol && frame.timeframe === timeframe;
}
