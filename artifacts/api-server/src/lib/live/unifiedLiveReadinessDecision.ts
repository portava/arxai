// Task #785 — Unified live-readiness PURE decision core.
//
// This module is intentionally DB-free so the readiness semantics can be tested
// deterministically in the offline `ci` lane. It does NOT read the database, the
// feed, or any gate — it only composes already-resolved primitives (sourced from
// the existing SSOTs: buildApprovedTraderLiveState + getUserAllocationView +
// resolveBrokerConfirmedFeed) into ONE honest readiness verdict.
//
// SAFETY (inviolable):
//   * This is a DESCRIBE-only aggregator. It NEVER grants execution. Every live
//     order still routes instant-trade router → live pipeline → the 23 Phase B
//     dispatch gates + LIVE_EXECUTION_ACTIVATION_GATE + kill switch + allocation
//     + risk + symbol checks. `liveEntryEligible: true` here is a readiness hint;
//     dispatch fully re-gates.
//   * It collects ALL applicable blockers (so the UI can show every reason at
//     once), and is a strict SUPERSET of the single-blocker logic in
//     approvedTraderLiveState — it never drops or weakens a blocker.
//   * Fail-closed by construction: any false input simply yields a blocker.

import type { ProductRole } from "../auth/productRole.js";

export type LiveReadinessBlockerCode =
  | "INVESTOR_NOT_ALLOWED"
  | "BOT_AGENT_NOT_ALLOWED"
  | "NOT_APPROVED_FOR_LIVE"
  | "LIVE_BRIDGE_ASSIGNMENT_PENDING"
  | "LIVE_CONFIRMATION_REQUIRED"
  | "LIVE_ARMING_PENDING"
  | "SERVER_LIVE_EXECUTION_OFF"
  | "KILL_SWITCH_ENGAGED"
  | "EMERGENCY_STOP_ACTIVE"
  | "RISK_PROFILE_INCOMPLETE"
  | "NO_LIVE_ALLOCATION"
  | "BRIDGE_HEARTBEAT_STALE"
  | "SYMBOL_NOT_LIVE_ELIGIBLE"
  | "BROKER_FEED_NOT_CONFIRMED";

export interface LiveReadinessBlocker {
  code: LiveReadinessBlockerCode;
  message: string;
  /** "ACCOUNT" = approval/activation/risk; "BRIDGE" = allocation/heartbeat;
   *  "FEED" = symbol/freshness. Lets the UI group source-proof vs freshness-proof. */
  category: "ACCOUNT" | "BRIDGE" | "FEED";
}

const BLOCKER_COPY: Record<LiveReadinessBlockerCode, { message: string; category: LiveReadinessBlocker["category"] }> = {
  INVESTOR_NOT_ALLOWED: { message: "Investor accounts are view-only and cannot place or manage trades.", category: "ACCOUNT" },
  BOT_AGENT_NOT_ALLOWED: { message: "Automated, agent, and system accounts are not eligible for live execution.", category: "ACCOUNT" },
  NOT_APPROVED_FOR_LIVE: { message: "Admin approval is required before you can trade live.", category: "ACCOUNT" },
  LIVE_BRIDGE_ASSIGNMENT_PENDING: { message: "Your live shared-bridge allocation is still being set up.", category: "BRIDGE" },
  LIVE_CONFIRMATION_REQUIRED: { message: "Complete live confirmation (Full Live Activation) to place live orders.", category: "ACCOUNT" },
  LIVE_ARMING_PENDING: { message: "Arm live trading to execute. Every dispatch still re-checks all Phase B gates.", category: "ACCOUNT" },
  SERVER_LIVE_EXECUTION_OFF: { message: "Live execution is currently paused. It will resume once re-enabled.", category: "ACCOUNT" },
  KILL_SWITCH_ENGAGED: { message: "Live trading is halted by the kill switch. Reset it before arming again.", category: "ACCOUNT" },
  EMERGENCY_STOP_ACTIVE: { message: "Live trading is paused platform-wide by the emergency stop.", category: "ACCOUNT" },
  RISK_PROFILE_INCOMPLETE: { message: "Complete your risk settings (max lot, daily loss limit, symbols) to continue.", category: "ACCOUNT" },
  NO_LIVE_ALLOCATION: { message: "No live allocation is available to trade. Contact your operator.", category: "BRIDGE" },
  BRIDGE_HEARTBEAT_STALE: { message: "The live bridge heartbeat is stale — the broker terminal is not reporting.", category: "BRIDGE" },
  SYMBOL_NOT_LIVE_ELIGIBLE: { message: "This symbol is not in your approved live trading list.", category: "FEED" },
  BROKER_FEED_NOT_CONFIRMED: { message: "The broker live feed for this symbol is not confirmed — analysis only, not valid for a live entry.", category: "FEED" },
};

export interface UnifiedLiveReadinessInput {
  // ---- Identity ----
  userId: number;
  email: string | null;
  role: ProductRole;
  isInvestor: boolean;
  isBotAgentSystem: boolean;
  isHumanTrader: boolean;
  accountMode: "LIVE" | "DEMO" | "PAPER";

  // ---- Approval / activation (account-level) ----
  liveApproved: boolean;
  sharedBridgeApproved: boolean;
  fullLiveActivation: boolean;
  armed: boolean;
  serverLiveExecutionOn: boolean;
  killSwitchEngaged: boolean;
  emergencyKillSwitch: boolean;
  riskProfileReady: boolean;

  // ---- Bridge ----
  bridgeMode: string;
  bridgeHeartbeatFresh: boolean;
  brokerAccountId: number | null;

  // ---- Allocation ----
  allocationSource: string;
  allocatedAmount: number;
  availableLiveAllocation: number;
  hasAllocation: boolean;

  // ---- Symbol + feed (null/false when no symbol is in context) ----
  symbol: string | null;
  brokerSymbol: string | null;
  normalizedSymbol: string | null;
  selectedTimeframe: string | null;
  lastTickAt: string | null;
  lastCandleAt: string | null;
  feedSource: string | null;
  feedConfirmed: boolean;
  missingIntervals: number | null;
  symbolLiveEligible: boolean;
}

export interface UnifiedLiveReadiness extends UnifiedLiveReadinessInput {
  /** Account-level live execution is active (activated + server-on + armed + kill clear). */
  liveExecutionActive: boolean;
  /** Risk profile complete AND live allocation available. */
  riskEligible: boolean;
  /** Neither the user kill switch nor the platform emergency stop is engaged. */
  killSwitchClear: boolean;
  /** Every applicable blocker, in precedence order (account → bridge → feed). */
  blockers: LiveReadinessBlocker[];
  /** TRUE only when there are zero blockers (account + bridge + risk + symbol + feed). */
  liveEntryEligible: boolean;
}

function blocker(code: LiveReadinessBlockerCode): LiveReadinessBlocker {
  const c = BLOCKER_COPY[code];
  return { code, message: c.message, category: c.category };
}

/**
 * Compose the unified readiness verdict from already-resolved primitives. Pure,
 * deterministic, DB-free. Collects ALL blockers (multi-blocker honesty). A
 * symbol-scoped feed/symbol blocker is only added when a symbol is in context
 * (`input.symbol != null`) — the account/bridge readiness is always evaluated.
 */
export function decideUnifiedLiveReadiness(
  input: UnifiedLiveReadinessInput,
): UnifiedLiveReadiness {
  const killSwitchClear = !input.killSwitchEngaged && !input.emergencyKillSwitch;
  const liveExecutionActive =
    input.fullLiveActivation && input.serverLiveExecutionOn && input.armed && killSwitchClear;
  const riskEligible = input.riskProfileReady && input.availableLiveAllocation > 0;

  const blockers: LiveReadinessBlocker[] = [];

  // ---- ACCOUNT classification + approval/activation ----
  if (input.isInvestor) blockers.push(blocker("INVESTOR_NOT_ALLOWED"));
  if (input.isBotAgentSystem) blockers.push(blocker("BOT_AGENT_NOT_ALLOWED"));
  if (!input.isInvestor && !input.isBotAgentSystem) {
    if (!input.liveApproved) blockers.push(blocker("NOT_APPROVED_FOR_LIVE"));
    if (!input.sharedBridgeApproved) blockers.push(blocker("LIVE_BRIDGE_ASSIGNMENT_PENDING"));
    if (!input.fullLiveActivation) blockers.push(blocker("LIVE_CONFIRMATION_REQUIRED"));
    if (!input.armed) blockers.push(blocker("LIVE_ARMING_PENDING"));
    if (!input.serverLiveExecutionOn) blockers.push(blocker("SERVER_LIVE_EXECUTION_OFF"));
    if (input.killSwitchEngaged) blockers.push(blocker("KILL_SWITCH_ENGAGED"));
    if (input.emergencyKillSwitch) blockers.push(blocker("EMERGENCY_STOP_ACTIVE"));
    if (!input.riskProfileReady) blockers.push(blocker("RISK_PROFILE_INCOMPLETE"));

    // ---- BRIDGE / allocation / heartbeat ----
    if (!input.hasAllocation || input.availableLiveAllocation <= 0) {
      blockers.push(blocker("NO_LIVE_ALLOCATION"));
    }
    if (!input.bridgeHeartbeatFresh) blockers.push(blocker("BRIDGE_HEARTBEAT_STALE"));

    // ---- FEED / symbol (only when a symbol is in context) ----
    if (input.symbol != null) {
      if (!input.symbolLiveEligible) blockers.push(blocker("SYMBOL_NOT_LIVE_ELIGIBLE"));
      if (!input.feedConfirmed) blockers.push(blocker("BROKER_FEED_NOT_CONFIRMED"));
    }
  }

  const liveEntryEligible = blockers.length === 0;

  return {
    ...input,
    liveExecutionActive,
    riskEligible,
    killSwitchClear,
    blockers,
    liveEntryEligible,
  };
}

/**
 * Honest one-line readiness label for any live-capable surface. NEVER says
 * "Trading enabled" unless this exact context can submit a live order:
 *   * "Live ready"                 — liveEntryEligible (symbol+feed in context)
 *   * "Entry blocked: <reason>"    — account/bridge/feed blocker present
 * For advisory engines that cannot place orders, callers should pass
 * `surface: "ALERT_ONLY" | "ANALYSIS_ONLY"` and use the matching label instead.
 */
export function unifiedReadinessLabel(state: UnifiedLiveReadiness): string {
  if (state.liveEntryEligible) return "Live ready";
  const first = state.blockers[0];
  return first ? `Entry blocked: ${first.message}` : "Entry blocked";
}
