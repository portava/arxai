// (O) Build O — Portfolio & Exposure Risk Engine (pure domain).
//
// Inputs: account snapshot (balance/equity), open positions, risk settings.
// Outputs: portfolio risk snapshot (overall LOW/MODERATE/HIGH/CRITICAL with
// reasons/warnings/blockers) + correlation risk reports (per symbol-group).
//
// Rules per spec:
//   - Warn if total account risk exceeds user limit
//   - Warn if too many positions are open (> maxOpenTrades)
//   - Warn if multiple trades expose same currency/index/asset family
//   - Warn if unrealized drawdown is near daily loss limit (≥80% of cap)
//   - Block (CRITICAL) if portfolio risk is CRITICAL
//   - Block (CRITICAL) if total open risk exceeds max allowed risk (>1.5× cap)
//   - Flag correlated trades moving in the same direction (CAUTION+)
//
// SAFETY: pure, side-effect-free. Never closes trades. Never claims certainty.
// AI summaries close with the standard disclaimer.

export type PortfolioRiskLevel = "LOW" | "MODERATE" | "HIGH" | "CRITICAL";
export type DirectionBias = "BUY" | "SELL" | "MIXED";

export interface OpenPositionInput {
  symbol: string;
  direction: "BUY" | "SELL";
  lotSize: number;
  unrealizedPnl: number;
  // Risk amount = the per-position currency value at risk if SL is hit.
  // Caller supplies this from trades.riskAmount (already validated upstream).
  riskAmount: number;
}

export interface PortfolioInputs {
  accountBalance: number;
  accountEquity: number;
  positions: OpenPositionInput[];
  // Risk settings (subset relevant here).
  maxOpenTrades: number;
  maxDailyLossPct: number;       // e.g. 2 = 2%
  riskPerTradePct: number;       // e.g. 0.5 = 0.5% per trade
  // Daily realized loss already booked, in account currency. Optional —
  // when present, escalates risk if combined with unrealized drawdown.
  dailyRealizedLoss?: number;
}

// ── Symbol → group mapping ────────────────────────────────────────────────
// Each symbol belongs to one or more groups for correlation purposes. A
// position contributes its (signed) lot size to every group it belongs to.
const SYMBOL_GROUPS: Record<string, string[]> = {
  EURUSD: ["EUR", "USD", "FOREX_MAJOR"],
  GBPUSD: ["GBP", "USD", "FOREX_MAJOR"],
  USDJPY: ["USD", "JPY", "FOREX_MAJOR"],
  AUDUSD: ["AUD", "USD", "FOREX_MAJOR"],
  USDCAD: ["USD", "CAD", "FOREX_MAJOR"],
  EURJPY: ["EUR", "JPY", "FOREX_CROSS"],
  GBPJPY: ["GBP", "JPY", "FOREX_CROSS"],
  US30:   ["USD", "EQUITY_INDEX_US"],
  NAS100: ["USD", "EQUITY_INDEX_US"],
  SPX500: ["USD", "EQUITY_INDEX_US"],
  AAPL: ["USD", "EQUITY_US_TECH"],
  TSLA: ["USD", "EQUITY_US_TECH"],
  MSFT: ["USD", "EQUITY_US_TECH"],
};

function groupsFor(symbol: string): string[] {
  if (SYMBOL_GROUPS[symbol]) return SYMBOL_GROUPS[symbol];
  // Synthetic: own-symbol group only (no macro correlation).
  if (/^(Volatility|Crash|Boom|Step|Jump|Vol\d|R_\d|V\d)/i.test(symbol)) {
    return [`SYNTHETIC:${symbol}`];
  }
  return [`OTHER:${symbol}`];
}

export interface CorrelationGroupResult {
  symbolGroup: string;
  positionsInGroup: number;
  symbols: string[];
  totalExposure: number;            // sum of |lotSize|
  directionBias: DirectionBias;
  correlationWarning: string | null;
  riskLevel: PortfolioRiskLevel;
  aiSummary: string;
}

export function buildCorrelationReports(positions: OpenPositionInput[]): CorrelationGroupResult[] {
  const buckets = new Map<string, OpenPositionInput[]>();
  for (const p of positions) {
    for (const g of groupsFor(p.symbol)) {
      const arr = buckets.get(g) ?? [];
      arr.push(p);
      buckets.set(g, arr);
    }
  }
  const out: CorrelationGroupResult[] = [];
  for (const [group, members] of buckets) {
    if (members.length < 2) continue;
    const symbols = Array.from(new Set(members.map((m) => m.symbol)));
    const totalExposure = members.reduce((s, m) => s + Math.abs(m.lotSize), 0);
    const buys = members.filter((m) => m.direction === "BUY").reduce((s, m) => s + m.lotSize, 0);
    const sells = members.filter((m) => m.direction === "SELL").reduce((s, m) => s + m.lotSize, 0);
    const directionBias: DirectionBias =
      buys > 0 && sells === 0 ? "BUY"
      : sells > 0 && buys === 0 ? "SELL"
      : "MIXED";
    let riskLevel: PortfolioRiskLevel = "LOW";
    let warning: string | null = null;
    if (directionBias !== "MIXED" && members.length >= 3) {
      riskLevel = "CRITICAL";
      warning = `${members.length} ${directionBias} positions in ${group} group — heavy correlated exposure.`;
    } else if (directionBias !== "MIXED" && members.length === 2) {
      riskLevel = "HIGH";
      warning = `2 ${directionBias} positions in ${group} group — same-direction correlation.`;
    } else if (directionBias === "MIXED" && members.length >= 3) {
      riskLevel = "MODERATE";
      warning = `${members.length} positions in ${group} group with mixed direction — net exposure partially hedged but still concentrated.`;
    } else {
      riskLevel = "LOW";
    }
    const aiSummary = `${group}: ${members.length} positions across ${symbols.join(", ")} (bias ${directionBias}, total ${totalExposure.toFixed(2)} lots). Risk: ${riskLevel}. ${warning ?? "No correlated-direction warning."} This is not a guarantee, gated by live-execution safety layer.`;
    out.push({
      symbolGroup: group,
      positionsInGroup: members.length,
      symbols, totalExposure, directionBias,
      correlationWarning: warning, riskLevel, aiSummary,
    });
  }
  // Sort: CRITICAL → HIGH → MODERATE → LOW; then by exposure desc.
  const rank: Record<PortfolioRiskLevel, number> = { CRITICAL: 0, HIGH: 1, MODERATE: 2, LOW: 3 };
  out.sort((a, b) => rank[a.riskLevel] - rank[b.riskLevel] || b.totalExposure - a.totalExposure);
  return out;
}

export interface PortfolioRiskSnapshotResult {
  accountBalance: number;
  accountEquity: number;
  openPositionsCount: number;
  totalOpenLotSize: number;
  totalUnrealizedPnl: number;
  totalRiskAmount: number;
  totalRiskPercent: number;
  correlatedExposureScore: number;       // 0..100
  portfolioRiskLevel: PortfolioRiskLevel;
  reasons: string[];
  warnings: string[];                    // soft, advisory
  blockers: string[];                    // hard, must-block
  aiSummary: string;
  correlationReports: CorrelationGroupResult[];
}

export function computePortfolioRisk(input: PortfolioInputs): PortfolioRiskSnapshotResult {
  const { accountBalance, accountEquity, positions } = input;
  const openPositionsCount = positions.length;
  const totalOpenLotSize  = positions.reduce((s, p) => s + Math.abs(p.lotSize), 0);
  const totalUnrealizedPnl = positions.reduce((s, p) => s + p.unrealizedPnl, 0);
  const totalRiskAmount   = positions.reduce((s, p) => s + Math.max(0, p.riskAmount), 0);
  const totalRiskPercent  = accountBalance > 0 ? (totalRiskAmount / accountBalance) * 100 : 0;

  const reasons: string[] = [];
  const warnings: string[] = [];
  const blockers: string[] = [];

  // Max allowed total open risk: positions × per-trade limit, capped to 1×daily loss limit.
  const perTradeCapPct = input.riskPerTradePct;
  const maxAllowedRiskPct = Math.min(perTradeCapPct * input.maxOpenTrades, input.maxDailyLossPct);
  const dailyLossCapAmount = accountBalance * (input.maxDailyLossPct / 100);

  // Rule A — total open risk vs. cap.
  if (totalRiskPercent > maxAllowedRiskPct * 1.5) {
    blockers.push(`Total open risk ${totalRiskPercent.toFixed(2)}% exceeds 1.5× allowed (${(maxAllowedRiskPct * 1.5).toFixed(2)}%).`);
  } else if (totalRiskPercent > maxAllowedRiskPct) {
    warnings.push(`Total open risk ${totalRiskPercent.toFixed(2)}% exceeds your ${maxAllowedRiskPct.toFixed(2)}% cap.`);
  }

  // Rule B — too many positions.
  if (openPositionsCount > input.maxOpenTrades * 1.5) {
    blockers.push(`Open position count ${openPositionsCount} exceeds 1.5× your max (${input.maxOpenTrades}).`);
  } else if (openPositionsCount > input.maxOpenTrades) {
    warnings.push(`Open position count ${openPositionsCount} exceeds your max (${input.maxOpenTrades}).`);
  }

  // Rule D — unrealized drawdown vs daily-loss limit.
  const unrealizedLoss = Math.max(0, -totalUnrealizedPnl);
  const realizedLoss   = Math.max(0, input.dailyRealizedLoss ?? 0);
  const combinedDrawdown = unrealizedLoss + realizedLoss;
  if (dailyLossCapAmount > 0) {
    const ratio = combinedDrawdown / dailyLossCapAmount;
    if (ratio >= 1) {
      blockers.push(`Combined drawdown ${combinedDrawdown.toFixed(2)} has reached your daily loss cap (${dailyLossCapAmount.toFixed(2)}).`);
    } else if (ratio >= 0.8) {
      warnings.push(`Combined drawdown ${combinedDrawdown.toFixed(2)} is ${Math.round(ratio * 100)}% of your daily loss cap (${dailyLossCapAmount.toFixed(2)}).`);
    }
  }

  // Rule C/G — correlation. We compute reports always; pull warnings/blockers
  // from group-level CRITICAL and HIGH classifications.
  const correlationReports = buildCorrelationReports(positions);
  for (const r of correlationReports) {
    if (r.riskLevel === "CRITICAL" && r.correlationWarning) {
      blockers.push(`Correlation: ${r.correlationWarning}`);
    } else if (r.riskLevel === "HIGH" && r.correlationWarning) {
      warnings.push(`Correlation: ${r.correlationWarning}`);
    } else if (r.riskLevel === "MODERATE" && r.correlationWarning) {
      reasons.push(`Correlation note: ${r.correlationWarning}`);
    }
  }

  // Correlation score 0..100: largest group share of total exposure × 100.
  let correlatedExposureScore = 0;
  if (totalOpenLotSize > 0 && correlationReports.length > 0) {
    const top = correlationReports[0]!;
    correlatedExposureScore = Math.min(100, Math.round((top.totalExposure / totalOpenLotSize) * 100));
  }

  // Overall classification — first matching rule wins (highest severity).
  let portfolioRiskLevel: PortfolioRiskLevel;
  if (blockers.length > 0) portfolioRiskLevel = "CRITICAL";
  else if (warnings.length >= 2 || (warnings.length >= 1 && correlatedExposureScore >= 60)) portfolioRiskLevel = "HIGH";
  else if (warnings.length >= 1 || correlatedExposureScore >= 40) portfolioRiskLevel = "MODERATE";
  else portfolioRiskLevel = "LOW";

  if (reasons.length === 0) {
    if (openPositionsCount === 0) reasons.push("No open positions.");
    else reasons.push(`${openPositionsCount} open position(s), total risk ${totalRiskPercent.toFixed(2)}%, equity ${accountEquity.toFixed(2)}.`);
  }

  const aiSummary = `Portfolio risk: ${portfolioRiskLevel}. ${openPositionsCount} open position(s), total open lots ${totalOpenLotSize.toFixed(2)}, total risk ${totalRiskPercent.toFixed(2)}% of balance, unrealized P&L ${totalUnrealizedPnl >= 0 ? "+" : ""}${totalUnrealizedPnl.toFixed(2)}, correlation concentration score ${correlatedExposureScore}/100.${blockers.length ? ` BLOCKERS: ${blockers.join(" ")}` : warnings.length ? ` WARNINGS: ${warnings.join(" ")}` : ""} This is not a guarantee, gated by live-execution safety layer.`;

  return {
    accountBalance, accountEquity,
    openPositionsCount, totalOpenLotSize, totalUnrealizedPnl,
    totalRiskAmount, totalRiskPercent,
    correlatedExposureScore, portfolioRiskLevel,
    reasons, warnings, blockers, aiSummary, correlationReports,
  };
}
