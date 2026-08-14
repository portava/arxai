// Task #199 — Part-42 Ruby Quality metrics aggregator. PURE.
//
// Aggregates resolved signal-outcome rows into the admin-dashboard metrics:
// win/TP/SL/late rates, timing distribution, avg slippage/start-drawdown/MFE/MAE,
// best/worst symbols & sessions, news/execution failures, explanation accuracy,
// ignored warnings, avoided bad trades, missed opportunities, and confidence/
// edge vs outcome buckets.
//
// Only EVIDENCE-RESOLVED rows count toward graded rates. PENDING/UNRESOLVED rows
// are reported separately and never inflate a win/loss rate (no fabrication).

import type { ExitReason, SignalOutcomeStatus, TimingClass } from "./rubyQuality.types";

export interface QualitySampleRow {
  symbol: string;
  session: string | null;
  decision: string;
  direction: string | null;
  outcomeStatus: SignalOutcomeStatus;
  pnlR: number | null;
  timingClass: TimingClass | null;
  exitReason: ExitReason | null;
  newsNearby: boolean;
  userEntered: boolean;
  explanationUsed: boolean;
  noTradeCredited: boolean;
  confidenceScore: number;
  edgeScore: number | null;
  spreadAtSignal: number | null;
  expectedSlippage: number | null;
  actualSlippage: number | null;
  expectedStartDrawdown: number | null;
  actualStartDrawdown: number | null;
  maxFavorableExcursion: number | null;
  maxAdverseExcursion: number | null;
}

export interface ScoreOutcomeBucket {
  bucket: string;          // e.g. "0-60", "60-75", "75-90", "90-100"
  total: number;
  wins: number;
  losses: number;
  winRate: number;         // wins / graded, 0 when none graded
}

export interface SymbolSessionStat {
  key: string;
  graded: number;
  wins: number;
  winRate: number;
  avgPnlR: number | null;
}

export interface RubyQualityMetrics {
  totals: {
    tracked: number;
    resolved: number;
    pending: number;
    graded: number;        // WIN+LOSS+BREAKEVEN (trades that resolved)
  };
  rates: {
    winRate: number;       // wins / graded
    tpRate: number;        // TP exits / entered-resolved
    slRate: number;        // SL exits / entered-resolved
    lateRate: number;      // LATE / entered-with-timing
  };
  timing: Record<TimingClass | "UNKNOWN", number>;
  averages: {
    slippage: number | null;
    startDrawdown: number | null;
    mfe: number | null;
    mae: number | null;
  };
  bestSymbols: SymbolSessionStat[];
  worstSymbols: SymbolSessionStat[];
  bestSessions: SymbolSessionStat[];
  worstSessions: SymbolSessionStat[];
  newsFailures: number;        // entered + LOSS + news nearby
  executionFailures: number;   // actual slippage worse than expected
  explanationAccuracy: number; // win rate among graded rows where explanation was used
  ignoredWarnings: number;     // user entered against a reject/no_trade call
  avoidedBadTrades: number;    // credited no-trades
  missedOpportunities: number; // NO_TRADE_MISSED
  confidenceVsOutcome: ScoreOutcomeBucket[];
  edgeVsOutcome: ScoreOutcomeBucket[];
}

const avg = (xs: number[]): number | null =>
  xs.length === 0 ? null : Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10000) / 10000;

const isGraded = (s: SignalOutcomeStatus): boolean =>
  s === "WIN" || s === "LOSS" || s === "BREAKEVEN";
const isResolved = (s: SignalOutcomeStatus): boolean =>
  s !== "PENDING" && s !== "UNRESOLVED";

function bucketStat(rows: QualitySampleRow[], pick: (r: QualitySampleRow) => number | null, edges: number[]): ScoreOutcomeBucket[] {
  const labels: { label: string; lo: number; hi: number }[] = [];
  for (let i = 0; i < edges.length - 1; i++) {
    labels.push({ label: `${edges[i]}-${edges[i + 1]}`, lo: edges[i], hi: edges[i + 1] });
  }
  return labels.map(({ label, lo, hi }) => {
    const inBucket = rows.filter((r) => {
      const v = pick(r);
      return v != null && v >= lo && v <= hi && isGraded(r.outcomeStatus);
    });
    const wins = inBucket.filter((r) => r.outcomeStatus === "WIN").length;
    const losses = inBucket.filter((r) => r.outcomeStatus === "LOSS").length;
    const gradedN = wins + losses;
    return { bucket: label, total: inBucket.length, wins, losses, winRate: gradedN ? Math.round((wins / gradedN) * 1000) / 1000 : 0 };
  });
}

function groupStats(rows: QualitySampleRow[], keyOf: (r: QualitySampleRow) => string): SymbolSessionStat[] {
  const groups = new Map<string, QualitySampleRow[]>();
  for (const r of rows) {
    const k = keyOf(r);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(r);
  }
  const out: SymbolSessionStat[] = [];
  for (const [key, gr] of groups) {
    const graded = gr.filter((r) => isGraded(r.outcomeStatus));
    const wins = graded.filter((r) => r.outcomeStatus === "WIN").length;
    const pnls = graded.map((r) => r.pnlR).filter((x): x is number => x != null);
    out.push({
      key,
      graded: graded.length,
      wins,
      winRate: graded.length ? Math.round((wins / graded.length) * 1000) / 1000 : 0,
      avgPnlR: avg(pnls),
    });
  }
  return out;
}

export function computeRubyQualityMetrics(rows: QualitySampleRow[]): RubyQualityMetrics {
  const resolved = rows.filter((r) => isResolved(r.outcomeStatus));
  const graded = rows.filter((r) => isGraded(r.outcomeStatus));
  const enteredResolved = resolved.filter((r) => r.userEntered);
  const wins = graded.filter((r) => r.outcomeStatus === "WIN").length;

  const tp = enteredResolved.filter((r) => r.exitReason === "TP").length;
  const sl = enteredResolved.filter((r) => r.exitReason === "SL").length;

  const enteredTimed = enteredResolved.filter((r) => r.timingClass != null);
  const late = enteredTimed.filter((r) => r.timingClass === "LATE").length;

  const timing: Record<TimingClass | "UNKNOWN", number> = { EARLY: 0, ON_TIME: 0, LATE: 0, UNKNOWN: 0 };
  for (const r of rows) timing[r.timingClass ?? "UNKNOWN"]++;

  const expWithExplain = graded.filter((r) => r.explanationUsed);
  const explainWins = expWithExplain.filter((r) => r.outcomeStatus === "WIN").length;

  const symbolStats = groupStats(resolved, (r) => r.symbol);
  const sessionStats = groupStats(resolved, (r) => r.session ?? "unknown");
  const byWinRate = (a: SymbolSessionStat, b: SymbolSessionStat) => b.winRate - a.winRate;
  const rankedSymbols = [...symbolStats].filter((s) => s.graded > 0).sort(byWinRate);
  const rankedSessions = [...sessionStats].filter((s) => s.graded > 0).sort(byWinRate);

  return {
    totals: {
      tracked: rows.length,
      resolved: resolved.length,
      pending: rows.length - resolved.length,
      graded: graded.length,
    },
    rates: {
      winRate: graded.length ? Math.round((wins / graded.length) * 1000) / 1000 : 0,
      tpRate: enteredResolved.length ? Math.round((tp / enteredResolved.length) * 1000) / 1000 : 0,
      slRate: enteredResolved.length ? Math.round((sl / enteredResolved.length) * 1000) / 1000 : 0,
      lateRate: enteredTimed.length ? Math.round((late / enteredTimed.length) * 1000) / 1000 : 0,
    },
    timing,
    averages: {
      slippage: avg(rows.map((r) => r.actualSlippage).filter((x): x is number => x != null)),
      startDrawdown: avg(rows.map((r) => r.actualStartDrawdown).filter((x): x is number => x != null)),
      mfe: avg(rows.map((r) => r.maxFavorableExcursion).filter((x): x is number => x != null)),
      mae: avg(rows.map((r) => r.maxAdverseExcursion).filter((x): x is number => x != null)),
    },
    bestSymbols: rankedSymbols.slice(0, 5),
    worstSymbols: rankedSymbols.slice(-5).reverse(),
    bestSessions: rankedSessions.slice(0, 5),
    worstSessions: rankedSessions.slice(-5).reverse(),
    newsFailures: enteredResolved.filter((r) => r.outcomeStatus === "LOSS" && r.newsNearby).length,
    executionFailures: rows.filter((r) => r.actualSlippage != null && r.expectedSlippage != null && r.actualSlippage > r.expectedSlippage).length,
    explanationAccuracy: expWithExplain.length ? Math.round((explainWins / expWithExplain.length) * 1000) / 1000 : 0,
    ignoredWarnings: rows.filter((r) => r.userEntered && (r.decision === "reject" || r.decision === "no_trade")).length,
    avoidedBadTrades: rows.filter((r) => r.noTradeCredited).length,
    missedOpportunities: rows.filter((r) => r.outcomeStatus === "NO_TRADE_MISSED").length,
    confidenceVsOutcome: bucketStat(rows, (r) => r.confidenceScore, [0, 60, 75, 90, 100]),
    edgeVsOutcome: bucketStat(rows, (r) => r.edgeScore, [0, 50, 70, 85, 100]),
  };
}
