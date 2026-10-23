// ── AACI Conflict Detector + Graph Cohesion (G) — pure ──────────────────────
//
// Graph Cohesion (G) measures whether ARX systems AGREE. The detector compares
// cross-system state (selected symbol across pages, Scanner bias vs Smart Chart
// bias, Ruby vs Scanner/Chart, Heat vs News, MT5 vs app open positions, etc.)
// and flags disagreements as conflicts. Conflicts lower G and steer the
// recommended action toward WAIT_FOR_CONFIRMATION / WATCH_ONLY / RECONCILE_SYSTEM.
// Unknown inputs are NOT treated as conflicts (fail-open) — only genuine,
// observed disagreement counts.

import type {
  AaciChartBias,
  AaciConflict,
  AaciDirectionalBias,
  AaciSharedTruthSnapshot,
} from "./types";

// Collapse a chart bias into a directional bias for comparison.
function chartToDirectional(bias?: AaciChartBias): AaciDirectionalBias | undefined {
  if (!bias) return undefined;
  if (bias === "bullish") return "buy";
  if (bias === "bearish") return "sell";
  if (bias === "neutral") return "neutral";
  return "mixed";
}

// Two directional biases conflict only when both are committed AND opposite.
// neutral/mixed/undefined never conflict (honest non-commitment, not disagreement).
function directionalConflict(a?: AaciDirectionalBias, b?: AaciDirectionalBias): boolean {
  if (!a || !b) return false;
  if (a === "neutral" || a === "mixed" || b === "neutral" || b === "mixed") return false;
  return a !== b;
}

export interface AaciCohesionReport {
  // G — graph cohesion score (0–100). 100 = full agreement, drops per conflict.
  score: number;
  conflicts: AaciConflict[];
  // True when MT5/app open-position counts disagree (drives RECONCILE_SYSTEM).
  positionMismatch: boolean;
}

/**
 * Detect cross-system conflicts and compute Graph Cohesion (G) from a Shared
 * Truth Snapshot. Pure. Each detected conflict deducts from a perfect score by
 * a severity-weighted amount.
 */
export function detectConflictsAndCohesion(
  snapshot: AaciSharedTruthSnapshot,
): AaciCohesionReport {
  const conflicts: AaciConflict[] = [];

  const scannerBias = snapshot.scanner?.bias;
  const chartBias = chartToDirectional(snapshot.smartChart?.bias);
  const rubyBias = snapshot.ruby?.bias;

  // Scanner bias vs Smart Chart bias.
  if (directionalConflict(scannerBias, chartBias)) {
    conflicts.push({
      code: "SCANNER_CHART_DISAGREE",
      severity: "warning",
      systems: ["Scanner", "SmartChart"],
      detail: `Scanner bias ${scannerBias} disagrees with chart bias ${snapshot.smartChart?.bias}.`,
    });
  }

  // Ruby explanation vs Scanner.
  if (directionalConflict(rubyBias, scannerBias)) {
    conflicts.push({
      code: "RUBY_SCANNER_DISAGREE",
      severity: "warning",
      systems: ["Ruby", "Scanner"],
      detail: `Ruby bias ${rubyBias} disagrees with scanner bias ${scannerBias}.`,
    });
  }

  // Ruby explanation vs Smart Chart.
  if (directionalConflict(rubyBias, chartBias)) {
    conflicts.push({
      code: "RUBY_CHART_DISAGREE",
      severity: "warning",
      systems: ["Ruby", "SmartChart"],
      detail: `Ruby bias ${rubyBias} disagrees with chart bias ${snapshot.smartChart?.bias}.`,
    });
  }

  // Heat exhaustion vs a committed directional bias (entering exhausted heat).
  const moveStage = snapshot.heat?.moveStage?.toUpperCase();
  const heatExhausted = moveStage === "EXHAUSTED" || moveStage === "MATURE";
  const anyCommittedEntry =
    (scannerBias === "buy" || scannerBias === "sell") ||
    (rubyBias === "buy" || rubyBias === "sell");
  if (heatExhausted && anyCommittedEntry) {
    conflicts.push({
      code: "EXHAUSTED_HEAT_VS_ENTRY",
      severity: "warning",
      systems: ["MarketTimingBrain", "Scanner"],
      detail: `Heat move stage ${snapshot.heat?.moveStage} conflicts with a committed entry bias.`,
    });
  }

  // Heat vs News: critical news while heat invites entry.
  const newsRisk = snapshot.news?.riskLevel;
  const heatInvitesEntry =
    snapshot.heat?.bestAction === "BUY" || snapshot.heat?.bestAction === "SELL";
  if ((newsRisk === "critical" || newsRisk === "high") && heatInvitesEntry) {
    conflicts.push({
      code: "HEAT_NEWS_DISAGREE",
      severity: "warning",
      systems: ["MarketTimingBrain", "EconomicCalendar"],
      detail: `Heat invites entry while news risk is ${newsRisk}.`,
    });
  }

  // Position sync mismatch (MT5 vs app open-position counts).
  const positionMismatch = Boolean(snapshot.positions.mismatch) || mismatchFromCounts(snapshot);
  if (positionMismatch) {
    conflicts.push({
      code: "POSITION_SYNC_MISMATCH",
      severity: "critical",
      systems: ["MT5Bridge", "OpenTrades"],
      detail: `Open-position counts disagree (mt5=${snapshot.positions.mt5OpenCount ?? "?"}, app=${snapshot.positions.appOpenCount ?? "?"}).`,
    });
  }

  // Selected-symbol consistency across surfaces (symbol drift).
  if (symbolDrift(snapshot)) {
    conflicts.push({
      code: "SYMBOL_CONTEXT_DRIFT",
      severity: "info",
      systems: ["Scanner", "SmartChart", "Ruby"],
      detail: "Selected symbol differs across scanner / chart / Ruby surfaces.",
    });
  }

  // Risk Governor hard block while a committed directional entry exists.
  if (snapshot.risk?.hardPass === false && anyCommittedEntry) {
    conflicts.push({
      code: "RISK_TRADE_DISAGREE",
      severity: "critical",
      systems: ["RiskGovernor"],
      detail: "Risk Governor is blocking while a committed entry bias exists.",
    });
  }

  const score = cohesionScore(conflicts);
  return { score, conflicts, positionMismatch };
}

function mismatchFromCounts(snapshot: AaciSharedTruthSnapshot): boolean {
  const { mt5OpenCount, appOpenCount } = snapshot.positions;
  if (typeof mt5OpenCount === "number" && typeof appOpenCount === "number") {
    return mt5OpenCount !== appOpenCount;
  }
  return false;
}

function symbolDrift(snapshot: AaciSharedTruthSnapshot): boolean {
  const ctx = snapshot.symbolContext;
  const symbols = [ctx.scannerSymbol, ctx.chartSymbol, ctx.rubySymbol].filter(
    (s): s is string => typeof s === "string" && s.length > 0,
  );
  if (symbols.length < 2) return false;
  const first = symbols[0]!.toUpperCase();
  return symbols.some((s) => s.toUpperCase() !== first);
}

// Severity-weighted deductions from a perfect cohesion score of 100.
const CONFLICT_DEDUCTION: Record<AaciConflict["severity"], number> = {
  info: 8,
  warning: 18,
  critical: 35,
};

function cohesionScore(conflicts: AaciConflict[]): number {
  let score = 100;
  for (const c of conflicts) score -= CONFLICT_DEDUCTION[c.severity];
  return Math.max(0, Math.min(100, score));
}
