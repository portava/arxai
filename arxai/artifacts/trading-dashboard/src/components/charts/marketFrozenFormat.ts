// Pure display helper for the chart "market closed / frozen quote" indicator.
//
// The tick-stream `feed_status` event reports whether the latest tick's BROKER
// time is stale (the broker is replaying its last quote because the market is
// closed). This helper turns that last broker-quote time into a small, honest
// label so a still-forming bar reads as closed-market, not a broken feed.
//
// Kept out of the chart components (which import lightweight-charts + the whole
// component tree) so it can be unit-tested in isolation — mirrors the
// scannerChartFormat.ts pattern. Nothing here touches a data source, the
// candles/tick-stream contract, or any execution path; it is display-only and
// NEVER fabricates a time (an unknown broker time degrades to a bare label).

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/**
 * Format the market-closed label from the last tick's broker time (epoch ms),
 * e.g. "Market closed — last quote Fri 20:54 UTC". The time is rendered in UTC
 * so it is unambiguous across viewer time zones and matches the broker's quote
 * timestamp. Falls back to a bare "Market closed" when the broker time is
 * unknown / invalid (never fabricates a time).
 */
export function formatMarketClosedLabel(lastBrokerTimeMs: number | null | undefined): string {
  if (lastBrokerTimeMs == null || !Number.isFinite(lastBrokerTimeMs)) {
    return "Market closed";
  }
  const d = new Date(lastBrokerTimeMs);
  const wd = WEEKDAYS[d.getUTCDay()];
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `Market closed — last quote ${wd} ${hh}:${mm} UTC`;
}

function utcStamp(lastBrokerTimeMs: number): string {
  const d = new Date(lastBrokerTimeMs);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${WEEKDAYS[d.getUTCDay()]} ${hh}:${mm} UTC`;
}

/**
 * Chip copy for the tick stream's `marketFrozen` signal. The server sets that
 * flag when the broker keeps repeating one quote (its broker time stopped while
 * ticks still arrive) — which a weekend, a holiday, broker hours or a stuck
 * terminal all produce. It is NOT a session verdict. The chart feed status only
 * calls a market closed inside the instrument's scheduled weekend close, so the
 * chip says "Market closed" only when `scheduledClosure` is true; otherwise it
 * says what was observed ("Quote not moving"). Never fabricates a time.
 */
export function frozenQuoteChip(
  lastBrokerTimeMs: number | null | undefined,
  scheduledClosure: boolean,
): { label: string; title: string } {
  const known = lastBrokerTimeMs != null && Number.isFinite(lastBrokerTimeMs);
  const stamp = known ? utcStamp(lastBrokerTimeMs) : null;
  const stopped = stamp
    ? `the broker's quote time stopped at ${stamp}`
    : "the broker time was not reported";
  if (scheduledClosure) {
    return {
      label: stamp ? `Market closed — last quote ${stamp}` : "Market closed",
      title: `Inside the scheduled weekend close, and the broker keeps repeating its last quote (${stopped}). Prices are not updating.`,
    };
  }
  return {
    label: stamp ? `Quote not moving — last quote ${stamp}` : "Quote not moving",
    title: `The broker keeps sending the same quote (${stopped}). The market may be closed for a holiday or outside broker hours, but no scheduled close applies now, so that is not confirmed. Prices are not updating.`,
  };
}
