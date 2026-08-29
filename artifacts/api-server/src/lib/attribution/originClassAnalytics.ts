// Capability #45 — origin-class attribution (pure analytics).
//
// Every trade is tagged at creation as MANUAL / ASSISTED / MODIFIED /
// AUTOMATED. Historical rows created before tagging carry NULL and are
// reported as an honest UNTAGGED bucket — they are NEVER guessed into a class.
//
// P/L honesty follows the trades.pnlStatus contract exactly: a row whose
// pnlStatus is "UNKNOWN" is EXCLUDED from every P/L aggregate (and counted so
// the exclusion is visible); OPEN rows contribute to counts but not outcomes.
//
// Discipline is NOT synthesized: no per-trade stop-respect telemetry exists in
// tradesTable, so the discipline metric is a typed honest null, not a proxy
// dressed up as a measurement.

export const TRADE_ORIGIN_CLASSES = ["MANUAL", "ASSISTED", "MODIFIED", "AUTOMATED"] as const;
export type TradeOriginClass = (typeof TRADE_ORIGIN_CLASSES)[number];

/** Classes a CLIENT may declare. AUTOMATED is server-stamped only: a browser
 *  claiming its trade was placed by automation would be fabricated provenance. */
export const CLIENT_DECLARABLE_ORIGIN_CLASSES = ["MANUAL", "ASSISTED", "MODIFIED"] as const;

export function isTradeOriginClass(v: unknown): v is TradeOriginClass {
  return typeof v === "string" && (TRADE_ORIGIN_CLASSES as readonly string[]).includes(v);
}

export interface OriginAnalyticsTradeRow {
  originClass: string | null;
  status: string;          // OPEN | CLOSED_WIN | CLOSED_LOSS | CANCELLED
  pnl: number | null;
  pnlStatus: string | null; // null | PENDING | COMPUTED | UNKNOWN
}

export interface OriginClassStats {
  originClass: TradeOriginClass | "UNTAGGED";
  count: number;
  openCount: number;
  closedCount: number;
  wins: number;
  losses: number;
  /** null when closedCount is 0 — never a fabricated 0%. */
  winRate: number | null;
  /** Mean realized pnl over closed rows with an honest computed P/L; null when
   *  no such rows exist. */
  expectancy: number | null;
  /** Closed rows excluded from expectancy because pnlStatus="UNKNOWN" or pnl
   *  is missing. Visible so the aggregate can never silently shrink. */
  pnlExcludedCount: number;
  /** Typed honest null: no stop-respect / plan-adherence telemetry exists on
   *  tradesTable, so per-class discipline cannot be measured yet. */
  discipline: null;
  disciplineUnavailableReason: "NO_PER_TRADE_DISCIPLINE_TELEMETRY";
}

export interface OriginClassAnalytics {
  classes: OriginClassStats[];
  totalTrades: number;
  taggedTrades: number;
  untaggedTrades: number;
  /** True when at least two tagged classes have closed trades — the minimum
   *  for the comparison to mean anything. */
  comparable: boolean;
  notes: string[];
}

function emptyStats(cls: OriginClassStats["originClass"]): OriginClassStats {
  return {
    originClass: cls,
    count: 0, openCount: 0, closedCount: 0, wins: 0, losses: 0,
    winRate: null, expectancy: null, pnlExcludedCount: 0,
    discipline: null,
    disciplineUnavailableReason: "NO_PER_TRADE_DISCIPLINE_TELEMETRY",
  };
}

/** Row is closed with an honest, computed realized P/L per the pnlStatus
 *  contract: UNKNOWN is always excluded; null/COMPUTED with a numeric pnl count. */
function hasComputedPnl(r: OriginAnalyticsTradeRow): boolean {
  if (r.pnlStatus === "UNKNOWN" || r.pnlStatus === "PENDING") return false;
  return typeof r.pnl === "number" && Number.isFinite(r.pnl);
}

export function computeOriginClassAnalytics(rows: readonly OriginAnalyticsTradeRow[]): OriginClassAnalytics {
  const buckets = new Map<OriginClassStats["originClass"], OriginClassStats>();
  for (const cls of TRADE_ORIGIN_CLASSES) buckets.set(cls, emptyStats(cls));
  buckets.set("UNTAGGED", emptyStats("UNTAGGED"));
  const sums = new Map<OriginClassStats["originClass"], { pnlSum: number; pnlCount: number }>();

  for (const r of rows) {
    const key: OriginClassStats["originClass"] = isTradeOriginClass(r.originClass) ? r.originClass : "UNTAGGED";
    const b = buckets.get(key)!;
    b.count += 1;
    const closed = r.status === "CLOSED_WIN" || r.status === "CLOSED_LOSS";
    if (r.status === "OPEN") b.openCount += 1;
    if (closed) {
      b.closedCount += 1;
      if (r.status === "CLOSED_WIN") b.wins += 1;
      else b.losses += 1;
      if (hasComputedPnl(r)) {
        const s = sums.get(key) ?? { pnlSum: 0, pnlCount: 0 };
        s.pnlSum += r.pnl as number;
        s.pnlCount += 1;
        sums.set(key, s);
      } else {
        b.pnlExcludedCount += 1;
      }
    }
  }

  for (const [key, b] of buckets) {
    if (b.closedCount > 0) b.winRate = b.wins / b.closedCount;
    const s = sums.get(key);
    if (s && s.pnlCount > 0) b.expectancy = s.pnlSum / s.pnlCount;
  }

  const classes = [...buckets.values()];
  const tagged = classes.filter((c) => c.originClass !== "UNTAGGED");
  const untagged = buckets.get("UNTAGGED")!;
  const withClosed = tagged.filter((c) => c.closedCount > 0).length;

  const notes: string[] = [];
  if (untagged.count > 0) {
    notes.push(`${untagged.count} historical trade(s) predate origin tagging and are reported UNTAGGED, not guessed.`);
  }
  if (withClosed < 2) {
    notes.push("Fewer than two origin classes have closed trades — cross-class comparison is not yet meaningful.");
  }

  return {
    classes,
    totalTrades: rows.length,
    taggedTrades: tagged.reduce((n, c) => n + c.count, 0),
    untaggedTrades: untagged.count,
    comparable: withClosed >= 2,
    notes,
  };
}
