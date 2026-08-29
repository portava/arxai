// AACI spread-history recorder — in-process rolling quote-spread samples.
//
// The platform has no persisted tick/quote history, so this recorder keeps a
// bounded rolling window of RELATIVE spread observations (spread/mid) per
// symbol, fed by the callers that already read quotes (the AACI decision path
// and the change-point driver's sampling pass).
//
// HONESTY: this is observational plumbing only. A symbol with too few samples
// returns null — the uncertainty channel then fails CLOSED to its full
// penalty. Restarting the process empties the window; that is reported as
// null (honest "cannot measure yet"), never a fabricated history.

export interface SpreadSample {
  relSpread: number; // spread / mid
  atMs: number;
}

const MAX_SAMPLES_PER_SYMBOL = 240;
const MAX_SYMBOLS = 200;
/** Samples older than this are ignored on read (stale market ≠ evidence). */
export const SPREAD_SAMPLE_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour

const bySymbol = new Map<string, SpreadSample[]>();

/** Record one relative-spread observation. Non-finite / non-positive mids and
 *  negative spreads are refused — bad quotes never become evidence. */
export function recordSpreadSample(
  symbol: string,
  spread: number,
  mid: number,
  nowMs: number = Date.now(),
): boolean {
  if (!symbol) return false;
  if (!Number.isFinite(spread) || !Number.isFinite(mid) || mid <= 0 || spread < 0) return false;
  let list = bySymbol.get(symbol);
  if (!list) {
    if (bySymbol.size >= MAX_SYMBOLS) return false; // bounded memory
    list = [];
    bySymbol.set(symbol, list);
  }
  list.push({ relSpread: spread / mid, atMs: nowMs });
  if (list.length > MAX_SAMPLES_PER_SYMBOL) list.splice(0, list.length - MAX_SAMPLES_PER_SYMBOL);
  return true;
}

/**
 * Recent relative-spread history for a symbol (oldest→newest), or null when
 * fewer than `minSamples` fresh observations exist (fail-closed upstream).
 */
export function getSpreadRelHistory(
  symbol: string,
  opts: { minSamples?: number; maxAgeMs?: number; nowMs?: number } = {},
): number[] | null {
  const minSamples = opts.minSamples ?? 5;
  const maxAgeMs = opts.maxAgeMs ?? SPREAD_SAMPLE_MAX_AGE_MS;
  const nowMs = opts.nowMs ?? Date.now();
  const list = bySymbol.get(symbol);
  if (!list) return null;
  const fresh = list.filter((s) => nowMs - s.atMs <= maxAgeMs);
  if (fresh.length < minSamples) return null;
  return fresh.map((s) => s.relSpread);
}

/** Symbols with at least one recorded sample (change-point driver input). */
export function spreadHistorySymbols(): string[] {
  return Array.from(bySymbol.keys());
}

/** Tests only. */
export function clearSpreadHistory(): void {
  bySymbol.clear();
}
