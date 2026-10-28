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

export type LevelSide = "OK" | "WRONG" | "MISSING";

export interface PlanGeometry {
  /** Reward ÷ risk, or null when a level is missing or on the wrong side. */
  rr: number | null;
  stopSide: LevelSide;
  targetSide: LevelSide;
  /** Normalised direction the sides were judged against, or null. */
  direction: "BUY" | "SELL" | null;
}

function normDirection(d: string | null | undefined): "BUY" | "SELL" | null {
  const v = (d ?? "").trim().toUpperCase();
  if (v === "BUY" || v === "LONG") return "BUY";
  if (v === "SELL" || v === "SHORT") return "SELL";
  return null;
}

/**
 * Directional reward-to-risk. A BUY's stop must be below entry and its target
 * above; a SELL is the mirror. With no BUY/SELL direction the stop and target
 * must at least sit on opposite sides of entry. A level on the wrong side makes
 * the plan geometrically impossible, so no R:R is returned for it.
 */
export function planRewardToRisk(
  direction: string | null | undefined,
  entry: number | null | undefined,
  sl: number | null | undefined,
  tp: number | null | undefined,
): PlanGeometry {
  const dir = normDirection(direction);
  const has = (x: number | null | undefined): x is number => typeof x === "number" && Number.isFinite(x);
  if (!has(entry)) {
    return { rr: null, stopSide: has(sl) ? "OK" : "MISSING", targetSide: has(tp) ? "OK" : "MISSING", direction: dir };
  }
  let stopSide: LevelSide = "MISSING";
  let targetSide: LevelSide = "MISSING";
  if (dir === "BUY") {
    if (has(sl)) stopSide = sl < entry ? "OK" : "WRONG";
    if (has(tp)) targetSide = tp > entry ? "OK" : "WRONG";
  } else if (dir === "SELL") {
    if (has(sl)) stopSide = sl > entry ? "OK" : "WRONG";
    if (has(tp)) targetSide = tp < entry ? "OK" : "WRONG";
  } else {
    if (has(sl)) stopSide = sl !== entry ? "OK" : "WRONG";
    if (has(tp)) targetSide = tp !== entry ? "OK" : "WRONG";
    if (has(sl) && has(tp) && stopSide === "OK" && targetSide === "OK" && (sl - entry) * (tp - entry) > 0) {
      // Same side of entry: one of them must be wrong, but without a
      // direction we cannot say which — both fail.
      stopSide = "WRONG";
      targetSide = "WRONG";
    }
  }
  if (stopSide !== "OK" || targetSide !== "OK") return { rr: null, stopSide, targetSide, direction: dir };
  const risk = Math.abs(entry - (sl as number));
  if (risk <= 0) return { rr: null, stopSide, targetSide, direction: dir };
  return { rr: Math.abs((tp as number) - entry) / risk, stopSide, targetSide, direction: dir };
}

function wrongSideDetail(kind: "stop" | "target", level: number, entry: number, dir: "BUY" | "SELL" | null): string {
  const where = level > entry ? "above" : level < entry ? "below" : "at";
  const name = kind === "stop" ? "Stop loss" : "Take profit";
  if (dir == null) {
    return `${name} ${level} is ${where} the ${entry} entry, on the same side as the ${kind === "stop" ? "take profit" : "stop loss"} — the plan has no direction to tell which is wrong.`;
  }
  const should = kind === "stop"
    ? (dir === "BUY" ? "below" : "above")
    : (dir === "BUY" ? "above" : "below");
  return `${name} ${level} is ${where} the ${entry} entry — for a ${dir.toLowerCase()} it must be ${should} entry.`;
}

export function evaluateChecklist(input: ChecklistInputs): ChecklistResult {
  const items: ChecklistItem[] = [];
  const geo = planRewardToRisk(input.directionBias, input.entryPrice, input.stopLoss, input.takeProfit);
  const rr = geo.rr;
  const minRr = (input.rewardToRiskTarget && input.rewardToRiskTarget > 0) ? input.rewardToRiskTarget : MIN_RR_DEFAULT;

  // Items 1, 2 and 6 only echo values the user typed (a dropdown, a
  // confidence number, a risk amount): ARX observed no market condition or
  // strategy fit and computed no risk. A satisfied self-reported value is
  // UNKNOWN ("your input — not checked by ARX"), never a PASS; one that breaks
  // the rule still FAILs. Readiness is unchanged (UNKNOWN never blocks).

  // 1. Market condition supports setup
  if (input.marketCondition === "TRENDING" || input.marketCondition === "RANGING") {
    items.push({
      key: "MARKET_CONDITION", label: "Market condition supports setup", status: "UNKNOWN",
      detail: `Your input — not checked by ARX: you marked the market ${input.marketCondition}.`,
    });
  } else if (input.marketCondition === "NO_TRADE") {
    items.push({ key: "MARKET_CONDITION", label: "Market condition supports setup", status: "FAIL", detail: "Current condition is NO_TRADE." });
  } else {
    items.push({ key: "MARKET_CONDITION", label: "Market condition supports setup", status: "WARN", detail: "Market condition not classified." });
  }

  // 2. Strategy fit acceptable (proxied by confidence level)
  if (input.confidenceLevel == null) {
    items.push({ key: "STRATEGY_FIT", label: "Strategy fit is acceptable", status: "WARN", detail: "Confidence level not set." });
  } else if (input.confidenceLevel >= MIN_CONFIDENCE) {
    items.push({
      key: "STRATEGY_FIT", label: "Strategy fit is acceptable", status: "UNKNOWN",
      detail: `Your input — not checked by ARX: you set confidence ${input.confidenceLevel}% (≥ ${MIN_CONFIDENCE}%); no strategy fit was measured.`,
    });
  } else {
    items.push({ key: "STRATEGY_FIT", label: "Strategy fit is acceptable", status: "FAIL", detail: `Confidence ${input.confidenceLevel}% (< ${MIN_CONFIDENCE}%).` });
  }

  // 3. Reward-to-risk acceptable (directional: levels on the wrong side of
  // entry make the plan impossible, so they never yield an R:R).
  if (geo.stopSide === "WRONG" || geo.targetSide === "WRONG") {
    items.push({
      key: "RR_OK", label: "Reward-to-risk is acceptable", status: "FAIL",
      detail: geo.direction
        ? `Stop loss or take profit is on the wrong side of entry for a ${geo.direction.toLowerCase()} — R:R can't be measured.`
        : "Stop loss and take profit are on the same side of entry (wrong side) — R:R can't be measured.",
    });
  } else if (rr == null) {
    items.push({ key: "RR_OK", label: "Reward-to-risk is acceptable", status: "FAIL", detail: "Entry / SL / TP missing." });
  } else if (rr >= minRr) {
    items.push({ key: "RR_OK", label: "Reward-to-risk is acceptable", status: "PASS", detail: `R:R ${rr.toFixed(2)} (≥ ${minRr.toFixed(2)}).` });
  } else {
    items.push({ key: "RR_OK", label: "Reward-to-risk is acceptable", status: "FAIL", detail: `R:R ${rr.toFixed(2)} (< ${minRr.toFixed(2)}).` });
  }

  // 4. Stop loss defined (and on the correct side of entry)
  items.push(input.stopLoss == null
    ? { key: "SL_DEFINED", label: "Stop loss is defined", status: "FAIL", detail: "Missing." }
    : geo.stopSide === "WRONG" && input.entryPrice != null
      ? { key: "SL_DEFINED", label: "Stop loss is defined", status: "FAIL", detail: wrongSideDetail("stop", input.stopLoss, input.entryPrice, geo.direction) }
      : { key: "SL_DEFINED", label: "Stop loss is defined", status: "PASS", detail: String(input.stopLoss) });

  // 5. Take profit defined (and on the correct side of entry)
  items.push(input.takeProfit == null
    ? { key: "TP_DEFINED", label: "Take profit is defined", status: "FAIL", detail: "Missing." }
    : geo.targetSide === "WRONG" && input.entryPrice != null
      ? { key: "TP_DEFINED", label: "Take profit is defined", status: "FAIL", detail: wrongSideDetail("target", input.takeProfit, input.entryPrice, geo.direction) }
      : { key: "TP_DEFINED", label: "Take profit is defined", status: "PASS", detail: String(input.takeProfit) });

  // 6. Risk amount within limit
  if (input.riskAmount == null || input.maxLossAllowed == null) {
    items.push({ key: "RISK_AMOUNT", label: "Risk amount is within limit", status: "WARN", detail: "Risk amount or max loss not set." });
  } else if (input.riskAmount <= input.maxLossAllowed) {
    items.push({
      key: "RISK_AMOUNT", label: "Risk amount is within limit", status: "UNKNOWN",
      detail: `Your input — not checked by ARX: you entered risk ${input.riskAmount} ≤ max ${input.maxLossAllowed}; ARX did not compute risk from the lot size and stop distance.`,
    });
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
  } else if (checklist.items.some((i) =>
    (i.key === "SL_DEFINED" || i.key === "TP_DEFINED") && i.status === "FAIL" && i.detail !== "Missing.")) {
    parts.push("Reward-to-risk cannot be measured — the stop loss or take profit is on the wrong side of entry.");
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
  const unchecked = checklist.items.filter((i) => i.status === "UNKNOWN");
  if (fails.length > 0) {
    parts.push(`Blocking issues: ${fails.map((f) => f.label.toLowerCase()).join("; ")}.`);
  } else if (warns.length > 0) {
    parts.push(`Cautions to acknowledge: ${warns.map((w) => w.label.toLowerCase()).join("; ")}.`);
  } else if (unchecked.length > 0) {
    parts.push("Every check ARX ran passes. Proceed only if your written plan still matches what you see on the chart.");
  } else {
    parts.push("All pre-trade checks pass. Proceed only if your written plan still matches what you see on the chart.");
  }
  if (unchecked.length > 0) {
    parts.push(`Not checked by ARX (your own inputs): ${unchecked.map((u) => u.label.toLowerCase()).join("; ")}.`);
  }

  // Inviolable advisory note — Safety Core, not this layer, gates execution.
  parts.push("Final execution remains gated by the live-execution safety layer.");

  return parts.join(" ");
}
