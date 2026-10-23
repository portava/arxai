// Phase 24 — Centralized decisionStatus enum.
//
// SAFETY: pure additive type module. Does NOT replace existing legacy strings
// in scanner / decision tool output. Use `mapLegacyToDecisionStatus()` when
// you want to surface a canonical enum value alongside legacy fields.
//
// Backward compatibility:
//   - Existing UI continues to read `bestOpportunities` / `watchClosely` /
//     `dataInsufficient` / `statusBadge` / `opportunityLabel` as before.
//   - New `decisionStatus` field is OPTIONAL — readers that don't know about
//     it ignore it.

/** Canonical decision status — one literal across scanner, decision engine,
 *  protective-auto-close, and the assistant. Add new values here ONLY. */
export type DecisionStatus =
  | "STRONG_SETUP"
  | "WAIT"
  | "AVOID"
  | "REVIEW"
  | "HOLD"
  | "NEWS_RISK_HIGH"
  | "DATA_INSUFFICIENT"
  | "SCANNER_OFFLINE"
  | "BRIDGE_OFFLINE"
  | "ALERT_ONLY";

export const DECISION_STATUS_VALUES: readonly DecisionStatus[] = [
  "STRONG_SETUP", "WAIT", "AVOID", "REVIEW", "HOLD",
  "NEWS_RISK_HIGH", "DATA_INSUFFICIENT", "SCANNER_OFFLINE",
  "BRIDGE_OFFLINE", "ALERT_ONLY",
] as const;

/** Inputs that the mapper understands. Pass `null`/`undefined` freely. */
export interface DecisionStatusInput {
  /** Section bucket from getTopOpportunitiesForMe / scanner. */
  legacySection?: string | null;
  /** statusBadge from LiveCandidate. */
  statusBadge?: string | null;
  /** opportunityLabel from LiveCandidate. */
  opportunityLabel?: string | null;
  /** liveDataConnected flag (from scanner). */
  liveDataConnected?: boolean | null;
  /** bridgeConnected flag (from MT5 heartbeat). */
  bridgeConnected?: boolean | null;
  /** Protective-auto-close effective mode if known. */
  protectiveMode?: string | null;
  /** True if a high-impact news event blocks the setup. */
  newsRiskHigh?: boolean | null;
}

/** Map legacy fields to the canonical DecisionStatus. The priority order
 *  here is INTENTIONAL — safety-blocking states (offline / news risk /
 *  insufficient data) outrank opportunity grading. */
export function mapLegacyToDecisionStatus(input: DecisionStatusInput): DecisionStatus {
  const {
    legacySection, statusBadge, opportunityLabel,
    liveDataConnected, bridgeConnected, protectiveMode, newsRiskHigh,
  } = input;

  // 1. Hard infrastructure gates first.
  if (liveDataConnected === false) return "SCANNER_OFFLINE";
  if (bridgeConnected === false && (protectiveMode === "ALERT_ONLY")) return "ALERT_ONLY";
  if (bridgeConnected === false) return "BRIDGE_OFFLINE";

  // 2. Data insufficiency.
  const section = (legacySection ?? "").toLowerCase();
  if (section === "datainsufficient" || statusBadge === "LOW_CONFIDENCE" && !legacySection) {
    return "DATA_INSUFFICIENT";
  }

  // 3. News risk.
  if (newsRiskHigh === true) return "NEWS_RISK_HIGH";

  // 4. Protective-auto-close mode (only when explicitly ALERT_ONLY and no
  //    higher-priority gate fired).
  if (protectiveMode === "ALERT_ONLY") return "ALERT_ONLY";

  // 5. Scanner legacy sections.
  if (section === "bestopportunities") return "STRONG_SETUP";
  if (section === "watchclosely") return "WAIT";
  if (section === "waitforconfirmation") return "WAIT";
  if (section === "highriskoravoid") return "AVOID";

  // 6. Badge / label fallbacks.
  switch (statusBadge) {
    case "HOT_SETUP": return "STRONG_SETUP";
    case "WATCHLIST": return "WAIT";
    case "WAIT_FOR_CONFIRMATION": return "WAIT";
    case "REJECTED_BY_RISK": return "AVOID";
    case "CHOPPY_MARKET": return "AVOID";
    case "LOW_CONFIDENCE": return "REVIEW";
  }
  switch (opportunityLabel) {
    case "ELITE": return "STRONG_SETUP";
    case "STRONG": return "STRONG_SETUP";
    case "ACCEPTABLE": return "WAIT";
    case "WEAK": return "REVIEW";
    case "REJECT": return "AVOID";
  }

  return "HOLD";
}

/** Human-readable explanation for a status — for UI tooltips / assistant
 *  responses. NEVER returns "TRADE NOW" wording; status is advisory only. */
export function explainDecisionStatus(status: DecisionStatus): string {
  switch (status) {
    case "STRONG_SETUP":      return "A high-quality setup is present per the scanner. This is advisory — review the full plan before acting.";
    case "WAIT":              return "Setup is forming but not confirmed. Wait for confirmation before acting.";
    case "AVOID":              return "Conditions argue against taking this trade. Avoid for now.";
    case "REVIEW":            return "Setup quality is weak / mixed. Review carefully; do not act on impulse.";
    case "HOLD":              return "No actionable change. Hold current state.";
    case "NEWS_RISK_HIGH":    return "A high-impact news event is in the window. Do not open or add risk; existing trades may need protection.";
    case "DATA_INSUFFICIENT": return "Not enough real candle / quote data to make a call. The assistant must not fabricate an opinion.";
    case "SCANNER_OFFLINE":   return "Live market data is not connected. The scanner cannot produce real candidates.";
    case "BRIDGE_OFFLINE":    return "MT5 bridge is not connected. Auto-close / execution remain blocked.";
    case "ALERT_ONLY":        return "Protective Auto-Close is in ALERT_ONLY mode. The AI can warn you, but cannot close this trade.";
  }
}
