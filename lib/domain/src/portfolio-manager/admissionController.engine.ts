// ═══════════════════════════════════════════════════════════════════════════
// Capability #21 — Position Admission Controller (pure domain, advisory).
//
// Extends the existing concentration/correlation/risk-cap admission (see
// portfolio-risk/computePortfolioRisk, which remains the base gate) with four
// additional evaluation dimensions:
//
//   • portfolio-role     — what the candidate DOES to the book
//                          (DIVERSIFIER / HEDGE / CONCENTRATOR / DUPLICATE)
//   • broker-dependency  — venue concentration + venue trust after admission
//   • opportunity-cost   — candidate's conservative utility vs the best
//                          alternative use of the same risk budget
//   • operational-load   — open-position / pending-order / degraded-worker load
//
// Every decision carries a PORTFOLIO-LEVEL STRESS EVIDENCE RECORD: three
// deterministic scenarios (correlated adverse move, candidate-venue failure,
// liquidity gap) evaluated against the daily-loss cap and an equity ruin
// floor. The record is attached whether the decision is ADMIT or REJECT — an
// admission without stress evidence cannot leave this engine.
//
// SAFETY / tighten-only: the output is ADVISORY and monotonic — dimensions can
// only DOWNGRADE the decision (ADMIT → ADMIT_REDUCED → DEFER → REJECT), never
// upgrade past a harsher one. Missing evidence (unreadable broker health,
// incomplete exposure graph) degrades the decision conservatively with a typed
// reason; it never defaults to permissive. ADMIT here never bypasses any
// existing execution gate.
// ═══════════════════════════════════════════════════════════════════════════

import {
  computePortfolioRisk,
  type OpenPositionInput,
  type PortfolioRiskSnapshotResult,
} from "../portfolio-risk/index";
import type { ConsolidatedExposureSummary } from "./beneficialOwnerExposure.engine";
import { clamp01 } from "./portfolio.types";

export type AdmissionDecisionKind = "ADMIT" | "ADMIT_REDUCED" | "DEFER" | "REJECT";

const DECISION_SEVERITY: Record<AdmissionDecisionKind, number> = {
  ADMIT: 0, ADMIT_REDUCED: 1, DEFER: 2, REJECT: 3,
};

/** Monotonic combiner — the harsher decision always wins. */
export function tightenDecision(
  a: AdmissionDecisionKind, b: AdmissionDecisionKind,
): AdmissionDecisionKind {
  return DECISION_SEVERITY[b] > DECISION_SEVERITY[a] ? b : a;
}

export type PortfolioRole = "DIVERSIFIER" | "HEDGE" | "CONCENTRATOR" | "DUPLICATE";

export interface AdmissionCandidate {
  symbol: string;
  direction: "BUY" | "SELL";
  /** Currency at risk if the stop is hit. */
  riskAmount: number;
  lotSize: number;
  strategyId?: string;
  venue: string;
  expectedHoldMin?: number;
  /** Lower-bound expected R for this candidate (for opportunity-cost). */
  conservativeUtilityR?: number | null;
}

export interface VenueHealthInput {
  venue: string;
  /** 0..1 evidence-backed trust; null = honestly unknown. */
  trust01: number | null;
  statusReason?: string;
}

export interface OperationalLoadInput {
  openPositions: number;
  maxOpenTrades: number;
  pendingOrders: number;
  /** Count of degraded/overdue workers or feeds, if known. */
  degradedComponents?: number;
}

export interface PositionWithVenue extends OpenPositionInput {
  venue?: string;
}

export interface AdmissionInput {
  candidate: AdmissionCandidate;
  accountBalance: number;
  accountEquity: number;
  positions: PositionWithVenue[];
  maxOpenTrades: number;
  maxDailyLossPct: number;
  riskPerTradePct: number;
  dailyRealizedLoss?: number;
  /** Consolidated single-owner exposure from #22; null = graph unavailable. */
  consolidated?: ConsolidatedExposureSummary | null;
  /** Venue health evidence; a venue absent from the list is honestly unknown. */
  venueHealth?: ReadonlyArray<VenueHealthInput>;
  /** Best alternative conservative utility (R) competing for the same budget. */
  bestAlternativeUtilityR?: number | null;
  operationalLoad?: OperationalLoadInput;
}

export interface DimensionEvaluation {
  dimension: "PORTFOLIO_ROLE" | "BROKER_DEPENDENCY" | "OPPORTUNITY_COST" | "OPERATIONAL_LOAD";
  verdict: AdmissionDecisionKind;
  score01: number | null;              // null = not computable (typed reason below)
  evidence: string[];
  degraded: boolean;                   // true when evidence was missing/unreadable
  degradedReason?: string;
}

export interface StressScenarioResult {
  scenarioId: string;
  description: string;
  assumedLossAmount: number;
  equityAfter: number;
  drawdownFraction01: number;
  breachesDailyCap: boolean;
  breachesRuinFloor: boolean;
}

export interface StressEvidenceRecord {
  method: "DETERMINISTIC_STRESS_V1";
  scenarios: StressScenarioResult[];
  worstDrawdownFraction01: number;
  dailyLossCapAmount: number;
  ruinFloorFraction01: number;
  anyBreach: boolean;
}

export interface AdmissionDecision {
  decision: AdmissionDecisionKind;
  /** Only set for ADMIT_REDUCED: the tightened risk ceiling. Always ≤ requested. */
  maxAdmittedRiskAmount: number | null;
  portfolioRole: PortfolioRole;
  dimensions: DimensionEvaluation[];
  /** The pre-existing base gate result (concentration/correlation/caps). */
  baseRisk: PortfolioRiskSnapshotResult;
  stressEvidence: StressEvidenceRecord;
  reasons: string[];
  blockers: string[];
  advisoryOnly: true;
}

const RUIN_FLOOR_FRACTION = 0.2; // losing ≥20% of equity in one stress = reject

// Same grouping notion as portfolio-risk: currency legs + families.
const CANDIDATE_GROUPS: Record<string, string[]> = {
  EURUSD: ["EUR", "USD", "FOREX_MAJOR"], GBPUSD: ["GBP", "USD", "FOREX_MAJOR"],
  USDJPY: ["USD", "JPY", "FOREX_MAJOR"], AUDUSD: ["AUD", "USD", "FOREX_MAJOR"],
  USDCAD: ["USD", "CAD", "FOREX_MAJOR"], USDCHF: ["USD", "CHF", "FOREX_MAJOR"],
  NZDUSD: ["NZD", "USD", "FOREX_MAJOR"], EURJPY: ["EUR", "JPY", "FOREX_CROSS"],
  GBPJPY: ["GBP", "JPY", "FOREX_CROSS"], US30: ["USD", "EQUITY_INDEX_US"],
  NAS100: ["USD", "EQUITY_INDEX_US"], SPX500: ["USD", "EQUITY_INDEX_US"],
  XAUUSD: ["XAU", "USD", "METAL"], XAGUSD: ["XAG", "USD", "METAL"],
};

function groupsFor(symbol: string): string[] {
  const key = symbol.toUpperCase();
  if (CANDIDATE_GROUPS[key]) return CANDIDATE_GROUPS[key];
  if (/^(Volatility|Crash|Boom|Step|Jump|Vol\d|R_\d|V\d|1HZ)/i.test(symbol)) {
    return [`SYNTHETIC:${key}`];
  }
  return [`OTHER:${key}`];
}

function classifyPortfolioRole(
  candidate: AdmissionCandidate, positions: ReadonlyArray<PositionWithVenue>,
): { role: PortfolioRole; evidence: string[] } {
  const evidence: string[] = [];
  const candGroups = new Set(groupsFor(candidate.symbol));

  const sameSymbolSameDir = positions.some(
    (p) => p.symbol.toUpperCase() === candidate.symbol.toUpperCase() && p.direction === candidate.direction);
  if (sameSymbolSameDir) {
    evidence.push(`an open ${candidate.direction} ${candidate.symbol} position already exists — candidate duplicates it`);
    return { role: "DUPLICATE", evidence };
  }

  let sameDirOverlap = 0;
  let oppDirOverlap = 0;
  for (const p of positions) {
    const overlap = groupsFor(p.symbol).some((g) => candGroups.has(g));
    if (!overlap) continue;
    if (p.direction === candidate.direction) sameDirOverlap += 1;
    else oppDirOverlap += 1;
  }
  if (sameDirOverlap === 0 && oppDirOverlap === 0) {
    evidence.push(`no correlation-group overlap with the ${positions.length} open position(s)`);
    return { role: "DIVERSIFIER", evidence };
  }
  if (oppDirOverlap > sameDirOverlap) {
    evidence.push(`offsets ${oppDirOverlap} opposite-direction correlated position(s) vs ${sameDirOverlap} same-direction`);
    return { role: "HEDGE", evidence };
  }
  evidence.push(`stacks onto ${sameDirOverlap} same-direction correlated position(s)`);
  return { role: "CONCENTRATOR", evidence };
}

export function evaluateAdmission(input: AdmissionInput): AdmissionDecision {
  const reasons: string[] = [];
  const blockers: string[] = [];
  const dimensions: DimensionEvaluation[] = [];
  const c = input.candidate;

  // ── Base gate: the EXISTING concentration/correlation/caps engine, with the
  //    candidate simulated into the book. Its blockers are hard REJECTs.
  const simulatedPositions: OpenPositionInput[] = [
    ...input.positions,
    { symbol: c.symbol, direction: c.direction, lotSize: c.lotSize, unrealizedPnl: 0, riskAmount: c.riskAmount },
  ];
  const baseRisk = computePortfolioRisk({
    accountBalance: input.accountBalance,
    accountEquity: input.accountEquity,
    positions: simulatedPositions,
    maxOpenTrades: input.maxOpenTrades,
    maxDailyLossPct: input.maxDailyLossPct,
    riskPerTradePct: input.riskPerTradePct,
    dailyRealizedLoss: input.dailyRealizedLoss,
  });
  let decision: AdmissionDecisionKind = "ADMIT";
  if (baseRisk.blockers.length > 0) {
    decision = "REJECT";
    blockers.push(...baseRisk.blockers.map((b) => `[base] ${b}`));
  } else if (baseRisk.portfolioRiskLevel === "HIGH") {
    decision = tightenDecision(decision, "ADMIT_REDUCED");
    reasons.push(`[base] portfolio risk HIGH with candidate admitted — reduced admission`);
  }

  // ── Dimension 1: portfolio role. ──
  const { role, evidence: roleEvidence } = classifyPortfolioRole(c, input.positions);
  let roleVerdict: AdmissionDecisionKind = "ADMIT";
  if (role === "DUPLICATE") roleVerdict = "REJECT";
  else if (role === "CONCENTRATOR") roleVerdict = "ADMIT_REDUCED";
  dimensions.push({
    dimension: "PORTFOLIO_ROLE", verdict: roleVerdict,
    score01: role === "DIVERSIFIER" ? 1 : role === "HEDGE" ? 0.75 : role === "CONCENTRATOR" ? 0.35 : 0,
    evidence: [`role: ${role}`, ...roleEvidence], degraded: false,
  });
  decision = tightenDecision(decision, roleVerdict);

  // ── Dimension 2: broker dependency. ──
  const brokerDim = evaluateBrokerDependency(input);
  dimensions.push(brokerDim);
  decision = tightenDecision(decision, brokerDim.verdict);

  // ── Dimension 3: opportunity cost. ──
  const oppDim = evaluateOpportunityCost(input, baseRisk);
  dimensions.push(oppDim);
  decision = tightenDecision(decision, oppDim.verdict);

  // ── Dimension 4: operational load. ──
  const loadDim = evaluateOperationalLoad(input);
  dimensions.push(loadDim);
  decision = tightenDecision(decision, loadDim.verdict);

  // ── Portfolio-level stress evidence — attached to EVERY decision. ──
  const stressEvidence = runDeterministicStress(input);
  if (stressEvidence.scenarios.some((s) => s.breachesRuinFloor)) {
    decision = "REJECT";
    blockers.push(`[stress] a deterministic scenario breaches the ${(RUIN_FLOOR_FRACTION * 100).toFixed(0)}% equity ruin floor`);
  } else if (stressEvidence.scenarios.some((s) => s.breachesDailyCap)) {
    decision = tightenDecision(decision, "ADMIT_REDUCED");
    reasons.push(`[stress] a deterministic scenario breaches the daily loss cap — reduced admission`);
  }

  // ── Reduction sizing: only ever DOWN from the requested risk. ──
  let maxAdmittedRiskAmount: number | null = null;
  if (decision === "ADMIT_REDUCED") {
    maxAdmittedRiskAmount = Math.max(0, Math.min(c.riskAmount, c.riskAmount * 0.5));
    reasons.push(`admitted at reduced risk: ${maxAdmittedRiskAmount.toFixed(2)} (≤ 50% of requested ${c.riskAmount.toFixed(2)})`);
  }

  for (const d of dimensions) {
    if (d.degraded) reasons.push(`[${d.dimension}] evidence degraded: ${d.degradedReason ?? "unspecified"} — evaluated conservatively`);
  }
  reasons.push(`decision ${decision} (advisory — existing execution gates are unaffected and still apply)`);

  return {
    decision, maxAdmittedRiskAmount, portfolioRole: role,
    dimensions, baseRisk, stressEvidence, reasons, blockers,
    advisoryOnly: true,
  };
}

function evaluateBrokerDependency(input: AdmissionInput): DimensionEvaluation {
  const c = input.candidate;
  const evidence: string[] = [];
  let verdict: AdmissionDecisionKind = "ADMIT";
  let degraded = false;
  let degradedReason: string | undefined;

  // Venue concentration AFTER admission, preferring the consolidated
  // single-owner exposure (#22) when it is available and complete.
  let venueRisk = 0;
  let totalRisk = 0;
  if (input.consolidated) {
    venueRisk = input.consolidated.byVenueRiskAmount[c.venue] ?? 0;
    totalRisk = input.consolidated.totalGrossRiskAmount;
    if (!input.consolidated.coverageComplete) {
      degraded = true;
      degradedReason = `exposure graph incomplete: ${input.consolidated.coverageGaps.join("; ") || "gaps unspecified"}`;
    }
    evidence.push(`venue risk from consolidated single-owner graph`);
  } else {
    for (const p of input.positions) {
      totalRisk += Math.max(0, p.riskAmount);
      if ((p.venue ?? "unknown") === c.venue) venueRisk += Math.max(0, p.riskAmount);
    }
    degraded = true;
    degradedReason = "consolidated exposure graph unavailable — fell back to single-account positions";
  }
  const venueShareAfter = (venueRisk + c.riskAmount) / Math.max(totalRisk + c.riskAmount, 1e-9);
  const venuesInUse = new Set<string>([
    ...Object.keys(input.consolidated?.byVenueRiskAmount ?? {}),
    ...input.positions.map((p) => p.venue ?? "unknown"),
  ]);
  venuesInUse.add(c.venue);
  evidence.push(`venue ${c.venue} would hold ${(venueShareAfter * 100).toFixed(1)}% of open risk after admission (${venuesInUse.size} venue(s) in use)`);
  if (venuesInUse.size > 1) {
    if (venueShareAfter > 0.9) verdict = tightenDecision(verdict, "DEFER");
    else if (venueShareAfter > 0.7) verdict = tightenDecision(verdict, "ADMIT_REDUCED");
  } else {
    evidence.push(`single-venue book — concentration is structural, flagged not blocked`);
  }

  // Venue trust.
  const health = input.venueHealth?.find((v) => v.venue === c.venue);
  if (!health || health.trust01 === null) {
    degraded = true;
    degradedReason = (degradedReason ? degradedReason + "; " : "") +
      `no trust evidence for venue ${c.venue}` + (health?.statusReason ? ` (${health.statusReason})` : "");
    // Unknown venue health cannot make things MORE permissive: cap at reduced.
    verdict = tightenDecision(verdict, "ADMIT_REDUCED");
    evidence.push(`venue trust: UNKNOWN — admission capped at ADMIT_REDUCED (fail-conservative)`);
  } else {
    const t = clamp01(health.trust01);
    evidence.push(`venue trust ${t.toFixed(2)}`);
    if (t < 0.4) verdict = tightenDecision(verdict, "REJECT");
    else if (t < 0.6) verdict = tightenDecision(verdict, "ADMIT_REDUCED");
  }

  return {
    dimension: "BROKER_DEPENDENCY", verdict,
    score01: 1 - clamp01(venueShareAfter),
    evidence, degraded, degradedReason,
  };
}

function evaluateOpportunityCost(
  input: AdmissionInput, baseRisk: PortfolioRiskSnapshotResult,
): DimensionEvaluation {
  const c = input.candidate;
  const evidence: string[] = [];
  let verdict: AdmissionDecisionKind = "ADMIT";

  if (c.conservativeUtilityR === null || c.conservativeUtilityR === undefined
      || input.bestAlternativeUtilityR === null || input.bestAlternativeUtilityR === undefined) {
    return {
      dimension: "OPPORTUNITY_COST", verdict: "ADMIT", score01: null,
      evidence: [`opportunity-cost not computable — candidate/alternative utility not supplied`],
      degraded: true,
      degradedReason: "utility evidence missing (this dimension cannot tighten OR loosen without it)",
    };
  }
  const cand = c.conservativeUtilityR;
  const best = input.bestAlternativeUtilityR;
  // Capital scarcity: how close the book already is to its allowed risk.
  const scarcity01 = clamp01(baseRisk.totalRiskPercent /
    Math.max(input.riskPerTradePct * input.maxOpenTrades, 1e-9));
  evidence.push(`candidate conservative utility ${cand.toFixed(3)}R vs best alternative ${best.toFixed(3)}R (capital scarcity ${(scarcity01 * 100).toFixed(0)}%)`);
  if (cand <= 0) {
    verdict = "REJECT";
    evidence.push(`candidate conservative utility ≤ 0 — admitting it has negative opportunity cost by construction`);
  } else if (best > 0 && cand < 0.5 * best && scarcity01 > 0.5) {
    verdict = "DEFER";
    evidence.push(`capital is scarce and a ≥2× better alternative exists — defer`);
  } else if (best > 0 && cand < 0.75 * best && scarcity01 > 0.75) {
    verdict = "ADMIT_REDUCED";
  }
  return {
    dimension: "OPPORTUNITY_COST", verdict,
    score01: best > 0 ? clamp01(cand / best) : 1,
    evidence, degraded: false,
  };
}

function evaluateOperationalLoad(input: AdmissionInput): DimensionEvaluation {
  const load = input.operationalLoad;
  if (!load) {
    return {
      dimension: "OPERATIONAL_LOAD", verdict: "ADMIT_REDUCED", score01: null,
      evidence: [`operational load unreadable — admission capped at ADMIT_REDUCED (fail-conservative)`],
      degraded: true, degradedReason: "operational load input missing",
    };
  }
  const evidence: string[] = [];
  let verdict: AdmissionDecisionKind = "ADMIT";
  const cap = Math.max(load.maxOpenTrades, 1);
  const managed = load.openPositions + load.pendingOrders;
  const utilization01 = clamp01(managed / cap);
  evidence.push(`${load.openPositions} open + ${load.pendingOrders} pending vs capacity ${cap} (utilization ${(utilization01 * 100).toFixed(0)}%)`);
  if (load.openPositions >= cap) {
    verdict = "DEFER";
    evidence.push(`open positions at/over the managed capacity — defer new admissions`);
  } else if (utilization01 >= 0.8) {
    verdict = "ADMIT_REDUCED";
  }
  if ((load.degradedComponents ?? 0) > 0) {
    verdict = tightenDecision(verdict, "ADMIT_REDUCED");
    evidence.push(`${load.degradedComponents} degraded component(s) — reduced admission while operationally impaired`);
  }
  return {
    dimension: "OPERATIONAL_LOAD", verdict,
    score01: 1 - utilization01, evidence, degraded: false,
  };
}

/** Three deterministic portfolio-level stress scenarios. Pure arithmetic. */
export function runDeterministicStress(input: AdmissionInput): StressEvidenceRecord {
  const c = input.candidate;
  const equity = Math.max(input.accountEquity, 1e-9);
  const dailyLossCapAmount = input.accountBalance * (input.maxDailyLossPct / 100);
  const candGroups = new Set(groupsFor(c.symbol));

  // S1 — correlated adverse move: candidate + every correlated same-direction
  // position hits its full risk amount simultaneously.
  let correlatedLoss = c.riskAmount;
  for (const p of input.positions) {
    const overlaps = groupsFor(p.symbol).some((g) => candGroups.has(g));
    if (overlaps && p.direction === c.direction) correlatedLoss += Math.max(0, p.riskAmount);
  }

  // S2 — candidate-venue failure: all risk on the candidate's venue becomes
  // unmanageable; assume stops slip 1.5× on that venue.
  let venueRisk = c.riskAmount;
  for (const p of input.positions) {
    if ((p.venue ?? "unknown") === c.venue) venueRisk += Math.max(0, p.riskAmount);
  }
  const venueFailureLoss = venueRisk * 1.5;

  // S3 — liquidity gap: every open position + candidate slips 2× through stops.
  const totalRisk = input.positions.reduce((s, p) => s + Math.max(0, p.riskAmount), 0) + c.riskAmount;
  const gapLoss = totalRisk * 2;

  const mk = (scenarioId: string, description: string, loss: number): StressScenarioResult => {
    const equityAfter = equity - loss;
    const drawdown = clamp01(loss / equity);
    return {
      scenarioId, description,
      assumedLossAmount: loss, equityAfter,
      drawdownFraction01: drawdown,
      breachesDailyCap: dailyLossCapAmount > 0 && loss > dailyLossCapAmount,
      breachesRuinFloor: drawdown >= RUIN_FLOOR_FRACTION,
    };
  };
  const scenarios = [
    mk("S1_CORRELATED_ADVERSE", "candidate + all same-direction correlated positions stopped out together", correlatedLoss),
    mk("S2_VENUE_FAILURE", `venue ${c.venue} fails; its stops slip 1.5×`, venueFailureLoss),
    mk("S3_LIQUIDITY_GAP", "market gaps 2× through every stop", gapLoss),
  ];
  return {
    method: "DETERMINISTIC_STRESS_V1",
    scenarios,
    worstDrawdownFraction01: Math.max(...scenarios.map((s) => s.drawdownFraction01)),
    dailyLossCapAmount,
    ruinFloorFraction01: RUIN_FLOOR_FRACTION,
    anyBreach: scenarios.some((s) => s.breachesDailyCap || s.breachesRuinFloor),
  };
}
