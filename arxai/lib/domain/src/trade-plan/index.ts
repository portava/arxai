// Build K — AI Trade Plan Builder pure domain.
//
// Composes existing safety surfaces into a deterministic pre-trade checklist.
// Inputs are gathered by the route layer (permission verdict, broker health,
// plan fields) and passed in. No I/O, no clock — `nowIso` is injected so the
// summarizer is replayable.

export type ChecklistStatus = "PASS" | "FAIL" | "WARN" | "UNKNOWN";

export interface ChecklistItem {
  key: string;
  label: string;
  status: ChecklistStatus;
  detail: string;
}

export interface ChecklistInputs {
  // Plan-side
  symbol: string | null;
  directionBias: string | null;
  strategyId: string | null;
  marketCondition: string | null;       // TRENDING | RANGING | NO_TRADE | UNKNOWN
  entryPrice: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  riskAmount: number | null;
  maxLossAllowed: number | null;
  rewardToRiskTarget: number | null;    // user-set target; default 1.5
  confidenceLevel: number | null;       // 0..100

  // Context-side (from existing systems — gathered by the route layer)
  permissionStatus: "CLEAR" | "CAUTION" | "LOCKED" | "LIVE_TRADING_DISABLED";
  permissionBlockers: string[];
  permissionWarnings: string[];
  brokerStatus: "CONNECTED" | "DEGRADED" | "DOWN" | "DISABLED" | "UNKNOWN";
  hasActiveRiskLock: boolean;
}

export interface ChecklistResult {
  items: ChecklistItem[];
  passCount: number;
  failCount: number;
  warnCount: number;
  isReady: boolean;
  rewardToRisk: number | null;
}

const MIN_RR_DEFAULT = 1.5;
const MIN_CONFIDENCE = 60;

function rewardToRisk(entry: number | null, sl: number | null, tp: number | null): number | null {
  if (entry == null || sl == null || tp == null) return null;
  const risk = Math.abs(entry - sl);
  if (risk <= 0) return null;
  const reward = Math.abs(tp - entry);
  return reward / risk;
}

export function evaluateChecklist(input: ChecklistInputs): ChecklistResult {
  const items: ChecklistItem[] = [];
  const rr = rewardToRisk(input.entryPrice, input.stopLoss, input.takeProfit);
  const minRr = (input.rewardToRiskTarget && input.rewardToRiskTarget > 0) ? input.rewardToRiskTarget : MIN_RR_DEFAULT;

  // 1. Market condition supports setup
  if (input.marketCondition === "TRENDING" || input.marketCondition === "RANGING") {
    items.push({ key: "MARKET_CONDITION", label: "Market condition supports setup", status: "PASS", detail: input.marketCondition });
  } else if (input.marketCondition === "NO_TRADE") {
    items.push({ key: "MARKET_CONDITION", label: "Market condition supports setup", status: "FAIL", detail: "Current condition is NO_TRADE." });
  } else {
    items.push({ key: "MARKET_CONDITION", label: "Market condition supports setup", status: "WARN", detail: "Market condition not classified." });
  }

  // 2. Strategy fit acceptable (proxied by confidence level)
  if (input.confidenceLevel == null) {
    items.push({ key: "STRATEGY_FIT", label: "Strategy fit is acceptable", status: "WARN", detail: "Confidence level not set." });
  } else if (input.confidenceLevel >= MIN_CONFIDENCE) {
    items.push({ key: "STRATEGY_FIT", label: "Strategy fit is acceptable", status: "PASS", detail: `Confidence ${input.confidenceLevel}% (≥ ${MIN_CONFIDENCE}%).` });
  } else {
    items.push({ key: "STRATEGY_FIT", label: "Strategy fit is acceptable", status: "FAIL", detail: `Confidence ${input.confidenceLevel}% (< ${MIN_CONFIDENCE}%).` });
  }

  // 3. Reward-to-risk acceptable
  if (rr == null) {
    items.push({ key: "RR_OK", label: "Reward-to-risk is acceptable", status: "FAIL", detail: "Entry / SL / TP missing." });
  } else if (rr >= minRr) {
    items.push({ key: "RR_OK", label: "Reward-to-risk is acceptable", status: "PASS", detail: `R:R ${rr.toFixed(2)} (≥ ${minRr.toFixed(2)}).` });
  } else {
    items.push({ key: "RR_OK", label: "Reward-to-risk is acceptable", status: "FAIL", detail: `R:R ${rr.toFixed(2)} (< ${minRr.toFixed(2)}).` });
  }

  // 4. Stop loss defined
  items.push(input.stopLoss != null
    ? { key: "SL_DEFINED", label: "Stop loss is defined", status: "PASS", detail: String(input.stopLoss) }
    : { key: "SL_DEFINED", label: "Stop loss is defined", status: "FAIL", detail: "Missing." });

  // 5. Take profit defined
  items.push(input.takeProfit != null
    ? { key: "TP_DEFINED", label: "Take profit is defined", status: "PASS", detail: String(input.takeProfit) }
    : { key: "TP_DEFINED", label: "Take profit is defined", status: "FAIL", detail: "Missing." });

  // 6. Risk amount within limit
  if (input.riskAmount == null || input.maxLossAllowed == null) {
    items.push({ key: "RISK_AMOUNT", label: "Risk amount is within limit", status: "WARN", detail: "Risk amount or max loss not set." });
  } else if (input.riskAmount <= input.maxLossAllowed) {
    items.push({ key: "RISK_AMOUNT", label: "Risk amount is within limit", status: "PASS", detail: `Risk ${input.riskAmount} ≤ max ${input.maxLossAllowed}.` });
  } else {
    items.push({ key: "RISK_AMOUNT", label: "Risk amount is within limit", status: "FAIL", detail: `Risk ${input.riskAmount} > max ${input.maxLossAllowed}.` });
  }

  // 7. Trading permission CLEAR (CAUTION = warn, others = fail)
  if (input.permissionStatus === "CLEAR") {
    items.push({ key: "PERMISSION", label: "Trading permission is CLEAR", status: "PASS", detail: "CLEAR" });
  } else if (input.permissionStatus === "CAUTION") {
    items.push({ key: "PERMISSION", label: "Trading permission is CLEAR", status: "WARN", detail: input.permissionWarnings[0] ?? "CAUTION" });
  } else {
    items.push({ key: "PERMISSION", label: "Trading permission is CLEAR", status: "FAIL", detail: input.permissionBlockers[0] ?? input.permissionStatus });
  }

  // 8. Broker health CONNECTED
  if (input.brokerStatus === "CONNECTED") {
    items.push({ key: "BROKER_HEALTH", label: "Broker health is CONNECTED", status: "PASS", detail: "CONNECTED" });
  } else if (input.brokerStatus === "DEGRADED") {
    items.push({ key: "BROKER_HEALTH", label: "Broker health is CONNECTED", status: "WARN", detail: "Heartbeat degraded." });
  } else {
    items.push({ key: "BROKER_HEALTH", label: "Broker health is CONNECTED", status: "FAIL", detail: input.brokerStatus });
  }

  // 9. No active risk lock
  items.push(input.hasActiveRiskLock
    ? { key: "NO_RISK_LOCK", label: "No active risk lock", status: "FAIL", detail: "Active risk lock present." }
    : { key: "NO_RISK_LOCK", label: "No active risk lock", status: "PASS", detail: "Clear." });

  const failCount = items.filter((i) => i.status === "FAIL").length;
  const warnCount = items.filter((i) => i.status === "WARN").length;
  const passCount = items.filter((i) => i.status === "PASS").length;

  return { items, passCount, failCount, warnCount, isReady: failCount === 0, rewardToRisk: rr };
}

// ── AI plan review (deterministic, advisory-only) ──────────────────────────

export interface PlanForReview {
  symbol: string | null;
  directionBias: string | null;
  strategyId: string | null;
  rewardToRisk: number | null;
  rewardToRiskTarget: number | null;
  confidenceLevel: number | null;
}

export function summarizePlan(plan: PlanForReview, checklist: ChecklistResult, _nowIso: string): string {
  const parts: string[] = [];
  const sym = plan.symbol ?? "this symbol";
  const dir = plan.directionBias ?? "directional";
  parts.push(`${dir.toUpperCase()} plan on ${sym}${plan.strategyId ? ` using ${plan.strategyId}` : ""}.`);

  if (plan.rewardToRisk != null) {
    const target = plan.rewardToRiskTarget ?? 1.5;
    parts.push(plan.rewardToRisk >= target
      ? `Reward-to-risk ${plan.rewardToRisk.toFixed(2)} meets your ${target.toFixed(2)} target.`
      : `Reward-to-risk ${plan.rewardToRisk.toFixed(2)} is below your ${target.toFixed(2)} target — consider tighter stop or wider target.`);
  } else {
    parts.push("Reward-to-risk cannot be computed — entry, stop, and take-profit are required.");
  }

  if (plan.confidenceLevel != null) {
    parts.push(plan.confidenceLevel >= 75 ? "Confidence is strong."
      : plan.confidenceLevel >= 60 ? "Confidence is acceptable."
      : "Confidence is low — wait for a cleaner setup.");
  }

  const fails = checklist.items.filter((i) => i.status === "FAIL");
  const warns = checklist.items.filter((i) => i.status === "WARN");
  if (fails.length > 0) {
    parts.push(`Blocking issues: ${fails.map((f) => f.label.toLowerCase()).join("; ")}.`);
  } else if (warns.length > 0) {
    parts.push(`Cautions to acknowledge: ${warns.map((w) => w.label.toLowerCase()).join("; ")}.`);
  } else {
    parts.push("All pre-trade checks pass. Proceed only if your written plan still matches what you see on the chart.");
  }

  // Inviolable advisory note — Safety Core, not this layer, gates execution.
  parts.push("Final execution remains gated by the live-execution safety layer.");

  return parts.join(" ");
}
