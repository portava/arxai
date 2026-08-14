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
