// Task #785 — Unified live-readiness DB-backed builder.
//
// ONE resolver that powers every live-capable surface (chart/manual ticket,
// scanner, Eleanor/Ruby, AI Trading, Profit Mission, Scalp, Flare, trade order
// page, and the live dispatch preflight). It does NOT invent its own readiness
// logic — it COMPOSES the existing single sources of truth:
//   * buildApprovedTraderLiveState  — identity, approval, full live activation,
//     arming, kill switch, platform posture, risk profile, bridge heartbeat (15s)
//   * getUserAllocationView         — allocation source / assigned / available
//   * resolveBrokerConfirmedFeed    — the shared feed-truth verdict for a symbol
// and folds them through the PURE decideUnifiedLiveReadiness core.
//
// SAFETY: pure READ; per-user scoped; never returns broker credentials, bridge
// tokens, raw account numbers, or IPs. DESCRIBE-only — dispatch still re-runs the
// full instant-trade router → live pipeline → 18-gate dispatch on top of this.
// Fail-closed: on any error every consumer sees a not-ready, fully-blocked state.

import { eq } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import { buildApprovedTraderLiveState } from "./approvedTraderLiveState.js";
import { getUserAllocationView } from "./masterBridgePool.js";
import { resolveBrokerConfirmedFeed } from "../data/brokerConfirmedFeed.js";
import { resolveBrokerSymbol } from "../mt5/symbolDirectory.js";
import {
  decideUnifiedLiveReadiness,
  type UnifiedLiveReadiness,
  type UnifiedLiveReadinessInput,
} from "./unifiedLiveReadinessDecision.js";
import { logger } from "../logger.js";

export interface BuildUnifiedLiveReadinessOptions {
  /** When provided, the symbol-scoped feed + symbol-eligibility checks run. */
  symbol?: string | null;
  /** Chart timeframe for the feed-confirmation check (default M1, normalized). */
  timeframe?: string | null;
}

function failClosedInput(userId: number): UnifiedLiveReadinessInput {
  return {
    userId,
    email: null,
    role: "USER",
    isInvestor: false,
    isBotAgentSystem: false,
    isHumanTrader: false,
    accountMode: "DEMO",
    liveApproved: false,
    sharedBridgeApproved: false,
    fullLiveActivation: false,
    armed: false,
    serverLiveExecutionOn: false,
    killSwitchEngaged: false,
    emergencyKillSwitch: true,
    riskProfileReady: false,
    bridgeMode: "NONE",
    bridgeHeartbeatFresh: false,
    brokerAccountId: null,
    allocationSource: "NONE",
    allocatedAmount: 0,
    availableLiveAllocation: 0,
    hasAllocation: false,
    symbol: null,
    brokerSymbol: null,
    normalizedSymbol: null,
    selectedTimeframe: null,
    lastTickAt: null,
    lastCandleAt: null,
    feedSource: null,
    feedConfirmed: false,
    missingIntervals: null,
    symbolLiveEligible: false,
  };
}

/**
 * Resolve the full unified live-readiness state for `userId`. Never throws — on
 * any internal failure it returns a fail-closed (fully-blocked, not-ready)
 * verdict so a degraded resolver can never falsely show or permit live.
 */
export async function buildUnifiedLiveReadiness(
  userId: number,
  opts: BuildUnifiedLiveReadinessOptions = {},
): Promise<UnifiedLiveReadiness> {
  const symbol = opts.symbol?.trim() || null;
  const timeframe = opts.timeframe?.trim() || "M1";

  try {
    const [state, allocation, userRow] = await Promise.all([
      buildApprovedTraderLiveState(userId),
      getUserAllocationView(userId),
      db
        .select({ email: usersTable.email })
        .from(usersTable)
        .where(eq(usersTable.id, userId))
        .limit(1)
        .then((r) => r[0] ?? null),
    ]);

    const normalizedSymbol = symbol ? symbol.toUpperCase() : null;
    const symbolLiveEligible =
      normalizedSymbol != null &&
      state.approvedSymbols.some((s) => s.toUpperCase() === normalizedSymbol);

    let feedSource: string | null = null;
    let feedConfirmed = false;
    let lastCandleAt: string | null = null;
    let lastTickAt: string | null = null;
    let missingIntervals: number | null = null;
    let brokerSymbol: string | null = null;
    // The timeframe actually evaluated by resolveBrokerConfirmedFeed is the
    // normalized one (e.g. lowercase "15m" → "M15"); surface THAT, never the raw
    // query value, so the panel/readiness reflects the feed that was checked.
    let evaluatedTimeframe: string | null = symbol ? timeframe : null;
    if (symbol) {
      const feed = await resolveBrokerConfirmedFeed(symbol, timeframe);
      feedSource = feed.feedSource;
      feedConfirmed = feed.feedConfirmed;
      lastCandleAt = feed.lastCandleAt;
      lastTickAt = feed.lastTickAt;
      missingIntervals = feed.trailingIntervals;
      evaluatedTimeframe = feed.normalizedTimeframe ?? timeframe;
      // Best-effort exact broker-symbol mapping for the readiness/panel display
      // (read-only; the per-user enumerated directory). Fail-honest to null —
      // this never gates anything; the exec path re-resolves at the live-poll
      // boundary.
      try {
        const r = await resolveBrokerSymbol(userId, symbol);
        brokerSymbol = r.ok ? r.brokerSymbol : null;
      } catch {
        brokerSymbol = null;
      }
    }

    const input: UnifiedLiveReadinessInput = {
      userId,
      email: userRow?.email ?? null,
      role: state.productRole,
      isInvestor: state.isInvestor,
      isBotAgentSystem: state.isBotAgentSystem,
      isHumanTrader: state.isHumanTrader,
      accountMode: state.intendedLiveDisplay ? "LIVE" : "DEMO",
      liveApproved: state.approvedForLive,
      sharedBridgeApproved: state.liveBridgeAssigned,
      fullLiveActivation: state.executionActivated,
      armed: state.armed,
      serverLiveExecutionOn: state.serverLiveExecutionOn,
      killSwitchEngaged: state.killSwitchEngaged,
      emergencyKillSwitch: state.emergencyKillSwitch,
      riskProfileReady: state.riskProfileReady,
      bridgeMode: state.liveBridgeAssigned ? "MASTER_LIVE_SHARED" : "NONE",
      bridgeHeartbeatFresh: state.bridgeHeartbeatFresh,
      brokerAccountId: state.bridgeConnectionId,
      allocationSource: allocation.hasAllocation ? "SHARED_MASTER_POOL" : "NONE",
      allocatedAmount: allocation.assignedAllocation,
      availableLiveAllocation: allocation.availableAllocation,
      hasAllocation: allocation.hasAllocation,
      symbol,
      brokerSymbol,
      normalizedSymbol,
      selectedTimeframe: evaluatedTimeframe,
      lastTickAt,
      lastCandleAt,
      feedSource,
      feedConfirmed,
      missingIntervals,
      symbolLiveEligible,
    };

    return decideUnifiedLiveReadiness(input);
  } catch (err) {
    logger.error(
      { err, userId },
      "buildUnifiedLiveReadiness failed — returning fail-closed state",
    );
    return decideUnifiedLiveReadiness(failClosedInput(userId));
  }
}
