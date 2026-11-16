// Build EE — Paper execution eligibility rules.
//
// Pure functions. Never side-effects. Never touches DB. Never calls live
// execution. Returns a structured eligibility result with first-fail reason.

import type { TradeDecision } from "../../routes/tradeDecision.js";

export interface EligibilityResult {
  ok: boolean;
  reason: string | null;
  warnings: string[];
}

const MIN_CONFIDENCE = 60;
const MAX_RISK_SCORE = 70;
const MAX_SPREAD_PCT = 0.01;

export function checkEligibility(
  decision: TradeDecision,
  decisionId: number | null,
  ctx: {
    openPaperOrdersForSymbolAndDir: number;
    totalOpenPaperOrders: number;
    duplicateExecutionExists: boolean;
    allowConflicts: boolean;
    maxOpenPaperTrades: number;
    maxSameSymbolPaperTrades: number;
  },
): EligibilityResult {
  const warnings: string[] = [];

  if (decisionId == null) return fail("Missing decision_id — refusing to create unanchored paper trade");

  // 1. Idempotency
  if (ctx.duplicateExecutionExists)
    return fail(`Paper execution already exists for decision_id=${decisionId} — idempotent reject`);

  // 2. AA shouldTrade
  if (decision.shouldTrade !== true)
    return fail(`Decision shouldTrade=false (action=${decision.action}) — paper trade refused`);

  // 3. Action
  if (decision.action !== "BUY" && decision.action !== "SELL")
    return fail(`Decision action=${decision.action} — only BUY/SELL are executable`);

  // 4. Trade window
  if (decision.tradeWindow.status !== "GOOD")
    return fail(`Trade window status=${decision.tradeWindow.status} (${decision.tradeWindow.reason})`);

  // 5. Confidence
  if (!Number.isFinite(decision.confidence) || decision.confidence < MIN_CONFIDENCE)
    return fail(`Confidence ${decision.confidence} below minimum ${MIN_CONFIDENCE}`);

  // 6. Risk score
  if (!Number.isFinite(decision.riskScore) || decision.riskScore > MAX_RISK_SCORE)
    return fail(`Risk score ${decision.riskScore} above maximum ${MAX_RISK_SCORE}`);

  // 7. Market data summary required
  const md = decision.marketDataSummary;
  if (!md) return fail("Missing marketDataSummary — Build DD did not provide market context");

  // 8. Data quality
  if (md.dataQualityStatus === "MISSING")
    return fail(`Market data quality is MISSING — refusing paper trade`);
  if (md.dataQualityStatus === "DEGRADED")
    warnings.push(`Market data quality is DEGRADED — proceeding with caution`);

  // 9. Spread
  if (md.mid > 0 && md.spread / md.mid > MAX_SPREAD_PCT)
    return fail(`Spread ${(md.spread / md.mid * 100).toFixed(3)}% exceeds ${MAX_SPREAD_PCT * 100}% — refusing fill`);

  // 10. Volatility
  if (md.volatilityLevel === "EXTREME")
    return fail(`Volatility is EXTREME — refusing paper trade for safety`);

  // 11/12/13. SL/TP/positionSize
  if (decision.stopLoss == null || !Number.isFinite(decision.stopLoss))
    return fail("Decision missing stopLoss");
  if (decision.takeProfit == null || !Number.isFinite(decision.takeProfit))
    return fail("Decision missing takeProfit");
  if (decision.positionSize == null || !(decision.positionSize > 0))
    return fail("Decision missing or zero positionSize");

  // 14. Critical/HIGH market-data blockers from AA
  const mdBlockers = (md.blockers ?? []) as { reason: string; severity: string }[];
  const critical = mdBlockers.find((b) => b.severity === "CRITICAL" || b.severity === "HIGH");
  if (critical) return fail(`Critical market-data blocker: ${critical.reason}`);

  // 15. AA top-level blockers (defense-in-depth — orchestrator may have added more)
  if (Array.isArray(decision.blockers) && decision.blockers.length > 0)
    return fail(`AA decision still has blockers: ${decision.blockers.slice(0, 3).join("; ")}`);

  // 16. Open trade caps
  if (ctx.totalOpenPaperOrders >= ctx.maxOpenPaperTrades)
    return fail(`Open paper trades cap hit (${ctx.totalOpenPaperOrders} / ${ctx.maxOpenPaperTrades})`);

  // 17. Conflict — same symbol + direction already open
  if (!ctx.allowConflicts && ctx.openPaperOrdersForSymbolAndDir >= ctx.maxSameSymbolPaperTrades)
    return fail(`Conflict: ${ctx.openPaperOrdersForSymbolAndDir} open ${decision.action} paper trade(s) on ${decision.symbol} (cap ${ctx.maxSameSymbolPaperTrades})`);

  return { ok: true, reason: null, warnings };

  function fail(reason: string): EligibilityResult {
    return { ok: false, reason, warnings };
  }
}
