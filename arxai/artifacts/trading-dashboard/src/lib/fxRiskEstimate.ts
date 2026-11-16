// Money at a price distance, for ticket "estimated loss / gain / risk" rows.
//
// Only computed where the arithmetic is known without a broker symbol spec:
// a spot FX pair of two fiat currencies, on the standard 100,000-unit
// contract, with USD on one side (the ticket shows dollars).
//   - XXX/USD: money = distance × 100,000 × lots (already USD).
//   - USD/XXX: money = distance × 100,000 × lots in XXX, ÷ the pair's price.
// Everything else returns null with the reason: cross pairs need another
// USD rate, and metals, indices, crypto and synthetic markets have
// broker-specific contract sizes. A wrong number is worse than none.

export type MoneyEstimate =
  | { usd: number; basis: string }
  | { usd: null; reason: string };

const FIAT = new Set([
  "USD", "EUR", "GBP", "JPY", "CHF", "CAD", "AUD", "NZD",
  "SEK", "NOK", "DKK", "SGD", "HKD", "ZAR", "MXN", "PLN", "TRY", "CNH",
]);
const STANDARD_LOT_UNITS = 100_000;

function bare(symbol: string): string {
  const s = symbol.includes(":") ? symbol.split(":")[1]! : symbol;
  return s.trim().toUpperCase();
}

export function estimateMoneyAtDistance(
  symbol: string, lots: number, refPrice: number, otherPrice: number,
): MoneyEstimate {
  if (!(Number.isFinite(lots) && lots > 0)) return { usd: null, reason: "Set a lot size." };
  if (!(Number.isFinite(refPrice) && refPrice > 0)) return { usd: null, reason: "No reference price." };
  if (!(Number.isFinite(otherPrice) && otherPrice > 0)) return { usd: null, reason: "Set a price level." };
  const s = bare(symbol);
  const base = s.slice(0, 3);
  const quote = s.slice(3, 6);
  if (!/^[A-Z]{6}$/.test(s) || !FIAT.has(base) || !FIAT.has(quote)) {
    return { usd: null, reason: "Not estimated: the contract size for this market is broker-specific." };
  }
  const quoteMoney = Math.abs(refPrice - otherPrice) * STANDARD_LOT_UNITS * lots;
  if (quote === "USD") return { usd: quoteMoney, basis: "Standard 100,000-unit contract, USD-quoted pair." };
  if (base === "USD") return { usd: quoteMoney / refPrice, basis: `Standard 100,000-unit contract, ${quote} converted at the pair's price.` };
  return { usd: null, reason: `Not estimated: ${base}/${quote} needs a ${quote}→USD rate this page does not load.` };
}

/** "≈$2.00", or a short plain reason when no figure can be given. */
export function formatMoneyEstimate(e: MoneyEstimate): string {
  return e.usd == null ? "Not estimated" : `≈$${e.usd.toFixed(2)}`;
}
