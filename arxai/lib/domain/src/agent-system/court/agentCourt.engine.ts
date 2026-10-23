// Agent Ecosystem — Layer 3 Agent Court for disagreements (§13). PURE.
//
// PURPOSE
//   When agents disagree, do NOT average opinions. Weigh each position by
//   specialty authority for THIS setup, recent performance in this exact
//   condition / symbol / timeframe / trade-type, calibration, and speed fit;
//   honor a Risk AI veto; and resolve to a single protective outcome. Produce a
//   persistable disagreement record so the system can learn who was right later.
//
// SAFETY / SCOPE (inviolable):
//   - ADVISORY ONLY. The court resolves a RANKING/recommendation; it never gates
//     execution and can only ever DOWNGRADE toward caution (protective bias).
//   - A Risk AI veto always wins toward caution/reject — capital protection
//     outranks opportunity (Constitution law 7 & 1).
//   - PURE: deterministic, no I/O, no clock, no DB.

export type CourtDecision = "approve" | "caution" | "reject" | "no_trade" | "observe";
export type CourtTradeType = "scalp" | "intraday" | "swing" | "no_trade";
export type CourtOutcome =
  | "APPROVE" | "CAUTION" | "WATCHLIST" | "REJECT" | "NO_TRADE";

/** One agent's position entering the court. */
export interface CourtPosition {
  agentKey: string;
  agentName: string;
  department: string;
  decision: CourtDecision;
  direction?: "BUY" | "SELL" | "NEUTRAL" | null;
  confidence: number;          // 0-100
  /** True when this agent owns specialty authority for this setup type. */
  hasSpecialtyAuthority: boolean;
  /** True for the Risk agent — enables the protective veto path. */
  isRiskAgent?: boolean;
  /** 0-100 performance in this exact market condition (recent). */
  conditionPerformance?: number;
  symbolPerformance?: number;  // 0-100
  timeframePerformance?: number; // 0-100
  tradeTypePerformance?: number; // 0-100
  /** 0-100 confidence calibration (how well-calibrated this agent is). */
  calibration?: number;
  /** Base advisory authority weight 0-1 (rank-derived). */
  authorityWeight: number;
}

export interface CourtContext {
  symbol: string;
  timeframe: string;
  tradeType: CourtTradeType;
  /** Free-text market-condition tag (e.g. "ranging", "high_vol"). */
  condition: string;
  /** Count of similar historical disagreements (informational). */
  similarHistoryCount?: number;
  /** True when the current mode requires speed (down-weights slow positions). */
  speedRequired?: boolean;
}

export interface CourtPositionWeight {
  agentKey: string;
  decision: CourtDecision;
  weight: number;           // final computed weight
  specialtyBoost: number;
}

export interface CourtResolution {
  outcome: CourtOutcome;
  /** The winning camp's decision label. */
  winningDecision: CourtDecision;
  winningAgentKeys: string[];
  /** Neutral machine reasoning; Ruby translates to plain English. */
  reasoning: string;
  riskVetoApplied: boolean;
  resolvedByAuthorityNotAverage: true;
  perPositionWeights: CourtPositionWeight[];
  /** Net direction of the winning camp, if any. */
  direction: "BUY" | "SELL" | "NEUTRAL" | null;
  /** A record ready to persist for later who-was-right resolution. */
  disagreementRecord: DisagreementRecordDraft;
}

export interface DisagreementRecordDraft {
  symbol: string;
  timeframe: string;
  tradeType: CourtTradeType;
  condition: string;
  positions: { agentKey: string; decision: CourtDecision; confidence: number; weight: number }[];
  resolvedOutcome: CourtOutcome;
  winningDecision: CourtDecision;
  winningAgentKeys: string[];
  riskVetoApplied: boolean;
  reasoning: string;
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}
function pct(n: number | undefined, fallback: number): number {
  return clamp01((typeof n === "number" ? n : fallback) / 100);
}

/**
 * Resolve a disagreement by weighted specialty authority — never by averaging.
 * Risk AI's reject/no_trade applies a protective veto that caps the outcome at
 * CAUTION/WATCHLIST even when a louder bullish camp exists (the §13 example).
 */
export function resolveDisagreement(
  positions: readonly CourtPosition[],
  ctx: CourtContext,
): CourtResolution {
  if (positions.length === 0) {
    throw new Error("resolveDisagreement: no positions provided");
  }

  // Compute a weight per position. Weight blends base authority with specialty
  // ownership, recent condition/symbol/timeframe/trade-type performance, and
  // calibration. Speed-required mode mildly down-weights uncertain positions.
  const perPositionWeights: CourtPositionWeight[] = positions.map((p) => {
    const specialtyBoost = p.hasSpecialtyAuthority ? 1.5 : 1.0;
    const condition = pct(p.conditionPerformance, 50);
    const symbol = pct(p.symbolPerformance, 50);
    const timeframe = pct(p.timeframePerformance, 50);
    const tradeType = pct(p.tradeTypePerformance, 50);
    const calibration = pct(p.calibration, 50);
    const conf = clamp01(p.confidence / 100);

    // Performance composite (0-1), weighted toward the exact-condition record.
    const perf =
      condition * 0.4 + symbol * 0.2 + timeframe * 0.2 + tradeType * 0.2;

    // Base authority floor so even a 0-authority shadow agent has a tiny voice.
    const base = Math.max(0.05, clamp01(p.authorityWeight));

    let weight = base * specialtyBoost * (0.5 + perf) * (0.6 + 0.4 * calibration) * (0.6 + 0.4 * conf);
    if (ctx.speedRequired && p.confidence < 50) weight *= 0.8;

    return { agentKey: p.agentKey, decision: p.decision, weight: +weight.toFixed(4), specialtyBoost };
  });

  // Sum weight per decision label.
  const weightByDecision = new Map<CourtDecision, number>();
  for (const w of perPositionWeights) {
    weightByDecision.set(w.decision, (weightByDecision.get(w.decision) ?? 0) + w.weight);
  }

  // Determine the winning camp by summed weight (deterministic tie-break order).
  const DECISION_ORDER: CourtDecision[] = ["reject", "no_trade", "caution", "observe", "approve"];
  let winningDecision: CourtDecision = "observe";
  let best = -1;
  for (const d of DECISION_ORDER) {
    const w = weightByDecision.get(d) ?? 0;
    if (w > best) { best = w; winningDecision = d; }
  }

  // Risk AI protective veto: if Risk says reject/no_trade/caution, the outcome
  // can never be a clean APPROVE — capital protection outranks opportunity.
  const riskPosition = positions.find((p) => p.isRiskAgent);
  const riskVeto =
    !!riskPosition &&
    (riskPosition.decision === "reject" ||
      riskPosition.decision === "no_trade" ||
      riskPosition.decision === "caution");

  let outcome = decisionToOutcome(winningDecision);
  let reasoning: string;

  if (riskVeto && (outcome === "APPROVE")) {
    // Downgrade an approve to WATCHLIST when Risk objects (the §13 example).
    outcome = "WATCHLIST";
    reasoning =
      `risk_veto_downgrade: strongest camp was '${winningDecision}' but Risk AI raised ` +
      `'${riskPosition!.decision}' — capital protection outranks opportunity; watchlist only until confirmation improves`;
    winningDecision = "caution";
  } else if (riskVeto && outcome === "CAUTION") {
    reasoning = `risk_veto_caution: Risk AI '${riskPosition!.decision}' confirms a cautious stance`;
  } else {
    reasoning = `authority_weighted_resolution: '${winningDecision}' camp carried the most specialty-weighted authority (not an average)`;
  }

  // Winning agent keys = positions matching the (possibly downgraded) winner OR,
  // when a veto downgraded, the Risk agent + any cautious/reject voices.
  const winningAgentKeys = riskVeto && outcome === "WATCHLIST"
    ? positions
        .filter((p) => p.isRiskAgent || p.decision === "reject" || p.decision === "no_trade" || p.decision === "caution")
        .map((p) => p.agentKey)
    : positions.filter((p) => p.decision === winningDecision).map((p) => p.agentKey);

  const direction = resolveDirection(positions, winningDecision, outcome);

  const disagreementRecord: DisagreementRecordDraft = {
    symbol: ctx.symbol,
    timeframe: ctx.timeframe,
    tradeType: ctx.tradeType,
    condition: ctx.condition,
    positions: positions.map((p) => ({
      agentKey: p.agentKey,
      decision: p.decision,
      confidence: p.confidence,
      weight: perPositionWeights.find((w) => w.agentKey === p.agentKey)!.weight,
    })),
    resolvedOutcome: outcome,
    winningDecision,
    winningAgentKeys,
    riskVetoApplied: riskVeto,
    reasoning,
  };

  return {
    outcome,
    winningDecision,
    winningAgentKeys,
    reasoning,
    riskVetoApplied: riskVeto,
    resolvedByAuthorityNotAverage: true,
    perPositionWeights,
    direction,
    disagreementRecord,
  };
}

function decisionToOutcome(d: CourtDecision): CourtOutcome {
  switch (d) {
    case "approve": return "APPROVE";
    case "caution": return "CAUTION";
    case "reject": return "REJECT";
    case "no_trade": return "NO_TRADE";
    case "observe": return "WATCHLIST";
  }
}

function resolveDirection(
  positions: readonly CourtPosition[],
  winningDecision: CourtDecision,
  outcome: CourtOutcome,
): "BUY" | "SELL" | "NEUTRAL" | null {
  if (outcome === "REJECT" || outcome === "NO_TRADE") return "NEUTRAL";
  const dirs = positions
    .filter((p) => p.decision === winningDecision && p.direction && p.direction !== "NEUTRAL")
    .map((p) => p.direction!);
  if (dirs.length === 0) return null;
  const buys = dirs.filter((d) => d === "BUY").length;
  const sells = dirs.filter((d) => d === "SELL").length;
  if (buys === sells) return "NEUTRAL";
  return buys > sells ? "BUY" : "SELL";
}
