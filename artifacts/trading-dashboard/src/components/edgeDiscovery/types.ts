export interface EdgeReport {
  id: number;
  edgeName: string;
  symbol: string | null;
  strategyId: number | null;
  timeframe: string | null;
  sessionName: string | null;
  marketCondition: string | null;
  sampleSize: number;
  winRate: number;
  averageRr: number;
  expectancy: number;
  profitFactor: number;
  disciplineScoreAvg: number;
  executionScoreAvg: number;
  emotionalScoreAvg: number;
  confidenceScore: number;
  status: "STRONG_EDGE"|"DEVELOPING_EDGE"|"WEAK_EDGE"|"NO_EDGE"|"INSUFFICIENT_DATA";
  aiSummary: string;
  createdAt: string;
  /** What the behaviour scores describe (server); absent on older servers. */
  behaviourBasis?: EdgeBehaviourBasis;
}
/**
 * SLICE_DEBRIEFS = averaged over debriefs linked to this slice's trades;
 * NOT_MEASURED = no linked debrief (stored 0s are placeholders);
 * ACCOUNT_WIDE_LEGACY = older report averaged over all of the user's debriefs.
 */
export type EdgeBehaviourBasis = "SLICE_DEBRIEFS" | "NOT_MEASURED" | "ACCOUNT_WIDE_LEGACY";
export interface EdgeWarning {
  id: number;
  edgeReportId: number;
  warningType: string;
  message: string;
  severity: "INFO"|"WARN"|"DANGER";
  createdAt: string;
}

export const STATUS_TONE: Record<EdgeReport["status"], string> = {
  STRONG_EDGE:       "border-emerald-700 bg-emerald-950/30 text-emerald-100",
  DEVELOPING_EDGE:   "border-sky-700 bg-sky-950/30 text-sky-100",
  WEAK_EDGE:         "border-amber-700 bg-amber-950/30 text-amber-100",
  NO_EDGE:           "border-red-700 bg-red-950/30 text-red-100",
  INSUFFICIENT_DATA: "border-slate-700 bg-slate-900/40 text-slate-300",
};

// The server stores 999 in profitFactor when a slice has wins but no losing
// trade (gross loss 0, ratio undefined). That is a marker, not a measurement:
// never print it as "999.00".
export const PF_NO_LOSSES_MARKER = 999;
export function formatProfitFactor(pf: number, short = false): string {
  if (!Number.isFinite(pf)) return "n/a";
  if (pf >= PF_NO_LOSSES_MARKER) return short ? "n/a (no losses)" : "Not measurable — no losing trade recorded";
  return pf.toFixed(2);
}

// Edge reports are historical snapshots, not live reads: every card says when
// its slice was generated (UTC, so it reads the same for every viewer).
export function formatGeneratedAt(createdAt: string | null | undefined): string {
  const t = createdAt ? Date.parse(createdAt) : NaN;
  if (!Number.isFinite(t)) return "Generated: time not recorded";
  const iso = new Date(t).toISOString();
  return `Generated ${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}
