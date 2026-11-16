// Cross-timeframe coverage + explicit higher-timeframe fallback.
//
// The scanner reads every timeframe ARX charts (SCANNER_TIMEFRAMES). When a
// timeframe has no reading of its own — the feed served too little data, the
// read made no directional call, or the per-cycle scan budget skipped it —
// the nearest HIGHER timeframe that does have a directional reading is shown
// instead, and always labelled as such. Never silently: every fallback
// carries `fallback: true`, the timeframe the reading came from, and a plain
// label. A lower timeframe is never used as a stand-in for a higher one (a
// faster chart is noisier, not a summary of the slower one).
//
// Pure. No I/O.

/** Every timeframe the scanner reads, lowest to highest. */
export const SCANNER_TIMEFRAMES = ["M1", "M5", "M15", "M30", "H1", "H4", "D1"] as const;
export type ScannerTimeframe = (typeof SCANNER_TIMEFRAMES)[number];

/** Order in which timeframes keep their slot when a cycle is over budget:
 *  the chart's working timeframes first, the slowest (whose bars change
 *  least often) last. */
export const SCANNER_TIMEFRAME_PRIORITY: readonly ScannerTimeframe[] = ["M5", "M15", "H1", "M1", "M30", "H4", "D1"];

/** Hard cap on (symbol × timeframe) scans in one scanner cycle. Each pair is a
 *  routed candle read plus enrichment, so this bounds provider load per cycle
 *  regardless of universe size (24 symbols × 7 timeframes). */
export const SCANNER_MAX_PAIRS_PER_CYCLE = 168;

export function timeframeRank(tf: string): number {
  return (SCANNER_TIMEFRAMES as readonly string[]).indexOf(tf);
}

/** Timeframes strictly above `tf`, nearest first. Empty for an unknown tf. */
export function higherTimeframes(tf: string): ScannerTimeframe[] {
  const i = timeframeRank(tf);
  return i < 0 ? [] : SCANNER_TIMEFRAMES.slice(i + 1);
}

export interface ScanPair {
  sym: string;
  tf: string;
}

/**
 * The pairs one cycle scans, bounded by `budget`. Under budget: all of them.
 * Over budget: whole timeframe "rounds" in SCANNER_TIMEFRAME_PRIORITY order
 * (every symbol on M5, then every symbol on M15, ...), so a cut always drops
 * the slowest timeframes first. Returns the kept pairs and the skipped ones.
 */
export function planScanPairs(
  syms: readonly string[],
  tfs: readonly string[],
  budget = SCANNER_MAX_PAIRS_PER_CYCLE,
): { pairs: ScanPair[]; skipped: ScanPair[] } {
  const all = syms.flatMap((sym) => tfs.map((tf) => ({ sym, tf })));
  if (all.length <= budget) return { pairs: all, skipped: [] };
  const prio = (tf: string) => {
    const i = (SCANNER_TIMEFRAME_PRIORITY as readonly string[]).indexOf(tf);
    return i < 0 ? SCANNER_TIMEFRAME_PRIORITY.length + timeframeRank(tf) : i;
  };
  const ordered = [...all].sort((a, b) => prio(a.tf) - prio(b.tf) || a.sym.localeCompare(b.sym));
  return { pairs: ordered.slice(0, Math.max(0, budget)), skipped: ordered.slice(Math.max(0, budget)) };
}

/** The minimum a row needs for coverage. */
export interface CoverageRow {
  symbol: string;
  timeframe: string;
  recommendedAction?: string | null;
  /** Scanner rows: live | stale | no_data | simulator_only. Absent = live. */
  dataStatus?: string | null;
}

export type CoverageStatus = "signal" | "no_signal" | "insufficient_data" | "skipped_budget";

export interface TimeframeCoverage {
  symbol: string;
  timeframe: string;
  status: CoverageStatus;
  /** Timeframe whose reading is shown for this slot: its own when
   *  status = signal, the nearest higher one with a signal on fallback, or
   *  null when no timeframe at or above it has one. */
  readingTimeframe: string | null;
  fallback: boolean;
  /** "M5: no signal (insufficient data) — showing the H1 reading (higher-timeframe fallback)". */
  label: string;
}

export function isDirectional(action: string | null | undefined): boolean {
  return ["BUY", "SELL", "LONG", "SHORT"].includes(String(action ?? "").trim().toUpperCase());
}

function hasSignal(row: CoverageRow | undefined): boolean {
  if (!row) return false;
  if (row.dataStatus != null && row.dataStatus !== "live") return false;
  return isDirectional(row.recommendedAction);
}

function ownStatus(row: CoverageRow | undefined, skipped: boolean): CoverageStatus {
  if (skipped) return "skipped_budget";
  if (!row) return "insufficient_data";
  if (row.dataStatus != null && row.dataStatus !== "live") return "insufficient_data";
  return isDirectional(row.recommendedAction) ? "signal" : "no_signal";
}

const WHY: Record<Exclude<CoverageStatus, "signal">, string> = {
  no_signal: "no signal",
  insufficient_data: "no signal (insufficient data)",
  skipped_budget: "not scanned this cycle (scan budget)",
};

/** Resolve one (symbol, timeframe) slot against the rows of the same symbol. */
export function resolveTimeframeReading<R extends CoverageRow>(
  symbol: string,
  timeframe: string,
  rowsForSymbol: readonly R[],
  skipped = false,
): TimeframeCoverage & { row: R | null } {
  const byTf = new Map<string, R>();
  const ambiguous = new Set<string>();
  for (const row of rowsForSymbol) {
    if (row.symbol !== symbol) continue;
    if (byTf.has(row.timeframe)) ambiguous.add(row.timeframe);
    else byTf.set(row.timeframe, row);
  }
  // A caller passing a mixed universe or conflicting duplicate results must
  // not silently attach another market's direction to the requested chart.
  for (const tf of ambiguous) byTf.delete(tf);
  const own = byTf.get(timeframe);
  const status = ownStatus(own, skipped);
  if (status === "signal") {
    return { symbol, timeframe, status, readingTimeframe: timeframe, fallback: false, label: `${timeframe}: own reading`, row: own ?? null };
  }
  for (const hi of higherTimeframes(timeframe)) {
    const r = byTf.get(hi);
    if (hasSignal(r)) {
      return {
        symbol, timeframe, status, readingTimeframe: hi, fallback: true,
        label: `${timeframe}: ${WHY[status]} — showing the ${hi} reading (higher-timeframe fallback)`,
        row: r ?? null,
      };
    }
  }
  return {
    symbol, timeframe, status, readingTimeframe: null, fallback: false,
    label: `${timeframe}: ${WHY[status]}; no higher timeframe has a signal either`,
    row: null,
  };
}

/** Coverage for every requested (symbol, timeframe) slot of one scan. */
export function buildTimeframeCoverage(
  syms: readonly string[],
  tfs: readonly string[],
  rows: readonly CoverageRow[],
  skipped: readonly ScanPair[] = [],
): TimeframeCoverage[] {
  const skippedKeys = new Set(skipped.map((p) => `${p.sym}|${p.tf}`));
  const bySym = new Map<string, CoverageRow[]>();
  for (const r of rows) {
    const arr = bySym.get(r.symbol) ?? [];
    arr.push(r);
    bySym.set(r.symbol, arr);
  }
  const sortedTfs = [...tfs].sort((a, b) => timeframeRank(a) - timeframeRank(b));
  const out: TimeframeCoverage[] = [];
  for (const sym of syms) {
    for (const tf of sortedTfs) {
      const { row: _row, ...c } = resolveTimeframeReading(sym, tf, bySym.get(sym) ?? [], skippedKeys.has(`${sym}|${tf}`));
      out.push(c);
    }
  }
  return out;
}
