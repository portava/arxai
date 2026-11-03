// One instrument → one display precision on every scanner surface.
//
// Owner screenshots (2026-10-27, V75 1m): the header said 33,588.01 (2 dp,
// grouped), the chart badge 33588.0069 then 33575.372 (raw JS number, 3–4 dp),
// the price axis 33575.37 (lightweight-charts' default 2 dp) and the trade
// modal seeded 2 dp — four precisions for one quote. The server already ships
// the instrument's precision on /api/chart/candles (truthResult.pricePrecision,
// venue-pip-derived in symbolProfile). These pure helpers are the ONE rule:
//
//   display precision = max(server precision, observed quote digits capped at
//                           server + 2)
//
// so a profile that is still wrong can only UNDER-state digits, never round
// away digits the venue actually quoted, and never invent extra ones. With no
// server precision the observed digits decide; with neither, the legacy
// magnitude heuristic is the last resort. Display only — never an order tick
// size, never an execution input.

const MAX_DECIMALS = 8;

function validPrecision(p: unknown): p is number {
  return typeof p === "number" && Number.isSafeInteger(p) && p >= 0 && p <= MAX_DECIMALS;
}

/** Fewest decimals that represent `value` exactly (float noise tolerated). */
export function priceDecimalsOf(value: number): number {
  if (!Number.isFinite(value)) return 0;
  for (let digits = 0; digits <= MAX_DECIMALS; digits++) {
    if (Math.abs(value - Number(value.toFixed(digits))) < 1e-9) return digits;
  }
  return MAX_DECIMALS;
}

/** Most decimals any of the observed quotes carries, or null with no quotes. */
export function observedPriceDecimals(values: Iterable<number | null | undefined>): number | null {
  let max: number | null = null;
  for (const v of values) {
    if (v == null || !Number.isFinite(v)) continue;
    const d = priceDecimalsOf(v);
    max = max == null ? d : Math.max(max, d);
  }
  return max;
}

/**
 * Resolve the display precision for one instrument from the server's declared
 * precision and the quotes actually observed. Returns null only when neither is
 * known (the formatter then falls back to a magnitude heuristic).
 */
export function resolveDisplayPricePrecision(
  serverPrecision: number | null | undefined,
  observed: Iterable<number | null | undefined>,
): number | null {
  const seen = observedPriceDecimals(observed);
  if (validPrecision(serverPrecision)) {
    if (seen == null) return serverPrecision;
    return Math.max(serverPrecision, Math.min(seen, serverPrecision + 2, MAX_DECIMALS));
  }
  return seen == null ? null : Math.min(seen, MAX_DECIMALS);
}

/** Legacy magnitude heuristic — used ONLY when no precision is known at all. */
export function magnitudeDecimals(value: number): number {
  const abs = Math.abs(value);
  return abs < 10 ? 5 : abs < 1000 ? 3 : 2;
}

/**
 * Format a price at the instrument's precision. No thousands grouping, so the
 * header, badge, level labels and the chart's price axis all print the same
 * characters for the same observation. "—" for a missing / non-finite value.
 */
export function formatInstrumentPrice(value: number | null | undefined, precision: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return value.toFixed(validPrecision(precision) ? precision : magnitudeDecimals(value));
}

/**
 * Parseable seed string for an editable price input at the instrument's
 * precision (trailing zeros dropped so the input stays a plain number).
 */
export function seedInstrumentPrice(value: number, precision: number | null | undefined): string {
  if (!Number.isFinite(value)) return "";
  return String(Number(formatInstrumentPrice(value, precision)));
}

/** lightweight-charts series priceFormat for a known precision, else null. */
export function candlestickPriceFormat(
  precision: number | null | undefined,
): { type: "price"; precision: number; minMove: number } | null {
  if (!validPrecision(precision)) return null;
  return { type: "price", precision, minMove: Number((10 ** -precision).toFixed(precision)) };
}

/**
 * Which close is the CURRENT price on a live chart: the forming-bar tip from
 * the tick stream when one has been applied since the last poll (exactly what
 * the price axis shows), otherwise the poll's newest close. Off a live display
 * only the poll close is ever shown (as last-known), never a tick.
 */
export function resolveDisplayClose(args: {
  tipClose: number | null | undefined;
  lastClose: number | null | undefined;
  isLive: boolean;
}): { value: number | null; basis: "tick" | "poll" | null } {
  const last = args.lastClose != null && Number.isFinite(args.lastClose) ? args.lastClose : null;
  if (args.isLive && args.tipClose != null && Number.isFinite(args.tipClose)) {
    return { value: args.tipClose, basis: "tick" };
  }
  return { value: last, basis: last == null ? null : "poll" };
}
