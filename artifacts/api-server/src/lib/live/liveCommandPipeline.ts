// Phase A — Live command pipeline (per-user).
//
// PIPELINE: LIVE_DRAFT → LIVE_CONFIRMATION_REQUIRED → LIVE_APPROVED → dispatch
//
// DISPATCH: evaluateLiveDispatchGate() ALWAYS returns canDispatchLive=false
// in Phase A, so every dispatched command transitions to LIVE_BLOCKED with
// reason BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED (the CI-pinned literal).
//
// IMPORTANT: this pipeline is intentionally separate from the demo pipeline
// (`mt5DemoCommandsTable`). A demo command can never accidentally route as
// live and vice versa.

import { randomUUID } from "node:crypto";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import {
  db,
  arxLiveCommandsTable,
  arxLivePositionsTable,
  arxLiveUserSettingsTable,
  liveTradingAuditTable,
  mt5ConnectionTable,
  userMasterLiveAccessTable,
  type ArxLiveCommand,
  type ArxLiveCommandStatus,
  type ArxLiveCommandType,
  ARX_LIVE_COMMAND_TYPES,
} from "@workspace/db";
import { evaluateLiveDispatchGate } from "@workspace/domain/safety-contracts/liveDispatchGate";
import {
  evaluateLivePhaseBDispatchGate,
  type LivePhaseBGateResult,
} from "@workspace/domain/safety-contracts/livePhaseBDispatchGate";
import {
  evaluatePreTradeBrokerGuard,
  explainPreTradeGuard,
  DEFAULT_PRE_TRADE_GUARD_LIMITS,
  type PreTradeGuardKey,
} from "@workspace/domain/safety-contracts/preTradeBrokerGuard";
import { evaluateSyntheticLiveFloor, type SymbolFeedVerdict } from "@workspace/domain/safety-contracts/syntheticLiveFloor";
import { isApprovedArxMarket, ARX_FOCUS_BLOCKED_REASON } from "@workspace/domain/market";
import { getBrokerSymbolSpec } from "../mt5/brokerSymbolSpec.js";
import { resolveSymbolFeedVerdictForSymbol } from "../data/symbolFeedVerdictForSymbol.js";
import { evaluateEntryDataSufficiency } from "./entryDataSufficiency.js";
import { explainMt5Retcode } from "../mt5/mt5Retcodes.js";
import { getMyArming } from "./liveArming.js";
import {
  killSwitchCloseBypassApplies,
  effectiveKillSwitchEngaged,
  type KillSwitchCloseBypass,
} from "./killSwitchBypass.js";
import { evaluateLiveExecutionActivationGate } from "./approvedTraderLiveState.js";
import { buildUnifiedLiveReadiness } from "./unifiedLiveReadiness.js";
import { buildLivePreflightReadinessObservation } from "./livePreflightReadinessObservation.js";
import {
  ARX_LIVE_DEFAULT_MAX_LOT_PER_MARKET,
  ARX_LIVE_DEFAULT_ALLOWED_SYMBOLS,
  ARX_LIVE_HARD_WEEKLY_DRAWDOWN_PCT,
} from "./liveArming.js";
import { liveBrokerExecutionEnabled, resolveLiveBrokerExecutionEnabledAsync, buildLiveIdempotencyKey, PHASE_B_LIVE_LOG_PREFIX } from "./phaseBConfig.js";
import { getEnvelope } from "../adminTrading/safetyEnvelope.js";
import { logger } from "../logger.js";
import { globalTradingSettingsTable, liveRiskDisclosureAcceptancesTable } from "@workspace/db";
import {
  buildCommandIntegrityFields,
  verifyCommandIntegrityForDispatch,
  recordLiveCommandReplayAttempt,
  recordLiveCommandDuplicateBlocked,
  DUPLICATE_LIVE_COMMAND_USER_MESSAGE,
  type CommandIntegrityFields,
} from "../security/commandIntegrity.js";
import { mirrorCriticalEvent } from "../security/events.js";
import { upsertAlertOnce } from "../../routes/meAlerts.js";
import { type CommandActorType } from "@workspace/domain/security";

// Gap A — Phase B disclosure gate input loader. Returns true iff the user
// has ANY append-only row in live_risk_disclosure_acceptances. Default-deny.
async function hasUserAcceptedDisclosure(userId: number): Promise<boolean> {
  const r = await db.select({ id: liveRiskDisclosureAcceptancesTable.id })
    .from(liveRiskDisclosureAcceptancesTable)
    .where(eq(liveRiskDisclosureAcceptancesTable.userId, userId))
    .limit(1);
  return r.length > 0;
}
import { loadAndEvaluateMasterLiveBridgeGate } from "../mt5/masterLiveBridgeGate.js";
import { loadAndEvaluateUserMasterLiveAccessGate } from "../mt5/userMasterLiveAccessGate.js";
import { evaluateOperatorFundedPilotGate } from "./operatorFundedPilotGate.js";
import { getUserRiskProfile } from "./userRiskProfile.js";
import { persistLiveBypassTrace } from "../agentEcosystem/governance.js";
import { getEffectiveTradingGovernance } from "../governance/effectiveGovernance.js";
import { getSymbolTradability } from "../data/symbolTradability.js";
import { recomputeMasterPool, loadMasterPool, getUserAllocationView, resolveActiveMasterConnectionId } from "./masterBridgePool.js";
import { resolveAllocationGate } from "./allocationGate.js";
import {
  claimLiveCommandForConfirm,
  claimLiveCommandForDispatch,
  LIVE_CONFIRM_RACE_LOST,
  LIVE_DISPATCH_RACE_LOST,
} from "./liveCommandCas.js";

// Re-exported so the route layer and the CI guard have one import site for the
// typed race refusals. See liveCommandCas.ts for why the CAS exists.
export { LIVE_CONFIRM_RACE_LOST, LIVE_DISPATCH_RACE_LOST };

const ALLOWED_TRANSITIONS: Record<ArxLiveCommandStatus, ArxLiveCommandStatus[]> = {
  LIVE_DRAFT: ["LIVE_CONFIRMATION_REQUIRED", "LIVE_CANCELLED", "LIVE_BLOCKED"],
  LIVE_CONFIRMATION_REQUIRED: ["LIVE_APPROVED", "LIVE_CANCELLED", "LIVE_BLOCKED"],
  LIVE_APPROVED: ["SENT_TO_MT5_LIVE", "LIVE_BLOCKED", "LIVE_CANCELLED"],
  // Task #28 — a SENT command may also expire (TTL sweep or EA stale-reject).
  SENT_TO_MT5_LIVE: ["LIVE_FILLED", "LIVE_REJECTED", "LIVE_FAILED", "LIVE_BLOCKED", "LIVE_EXPIRED"],
  LIVE_FILLED: ["LIVE_CLOSED"],
  LIVE_REJECTED: [], LIVE_FAILED: [], LIVE_BLOCKED: [], LIVE_CANCELLED: [], LIVE_CLOSED: [],
  LIVE_EXPIRED: [],
};

// Task #28 — default time-to-live for a dispatched live command. If the EA
// has not executed the command within this window the server sweeps it to
// LIVE_EXPIRED and the EA itself refuses to execute it (STALE_COMMAND_REJECTED).
// 60s comfortably covers a healthy EA poll cadence (heartbeat ≤15s) while
// guaranteeing a stalled command can never fire minutes late.
export const LIVE_COMMAND_TTL_SECONDS = 60;

// Terminal states a live command can rest in. A result POST that arrives for
// a command already in one of these states is a duplicate and is acknowledged
// (DUPLICATE_IGNORED) without re-applying the outcome.
const LIVE_TERMINAL_STATUSES: ArxLiveCommandStatus[] = [
  "LIVE_FILLED", "LIVE_REJECTED", "LIVE_FAILED",
  "LIVE_BLOCKED", "LIVE_CANCELLED", "LIVE_CLOSED", "LIVE_EXPIRED",
];

// Task #28 — pure freshness/lifecycle helpers. Extracted so the exactly-once
// and TTL contracts can be unit-tested without touching the persistent
// arx_live_commands audit table.

/** A command resting in any of these states has already been fully resolved. */
export function isTerminalLiveStatus(status: ArxLiveCommandStatus): boolean {
  return LIVE_TERMINAL_STATUSES.includes(status);
}

/** Authoritative expiry instant for a command dispatched at `serverTimestamp`. */
export function computeLiveExpiry(
  serverTimestamp: Date,
  ttlSeconds: number = LIVE_COMMAND_TTL_SECONDS,
): Date {
  return new Date(serverTimestamp.getTime() + ttlSeconds * 1000);
}

/**
 * A SENT command is stale once `now` is at/after its `expiresAt`. A null
 * `expiresAt` (legacy un-stamped row) is treated as NOT stale here — the DB
 * sweep only ever targets rows with a non-null expiresAt.
 */
export function isLiveCommandStale(expiresAt: Date | null, now: Date = new Date()): boolean {
  if (expiresAt == null) return false;
  return now.getTime() >= expiresAt.getTime();
}

/**
 * Task #28 (T003) — pure ghost-close matcher. Given the user's still-open
 * live positions and their LIVE_FILLED CLOSE commands, return the ids of
 * positions the broker has already closed (a CLOSE command's brokerTicket
 * matches an open position's ticket). These are the rows whose `closedAt`
 * must be stamped from broker truth. Never initiates a close — only mirrors
 * one the broker already executed.
 */
export function findGhostClosedPositionIds(
  openPositions: { id: number; brokerTicket: string }[],
  filledCloseCommands: { brokerTicket?: string | null; payload?: Record<string, unknown> | null }[],
): number[] {
  const closedTickets = new Set<string>();
  for (const c of filledCloseCommands) {
    const pt = (c.payload ?? null)?.["brokerTicket"];
    if (typeof pt === "string" && pt) closedTickets.add(pt);
    if (typeof c.brokerTicket === "string" && c.brokerTicket) closedTickets.add(c.brokerTicket);
  }
  return openPositions
    .filter((r) => typeof r.brokerTicket === "string" && closedTickets.has(r.brokerTicket))
    .map((r) => r.id);
}

async function audit(args: {
  eventType: string; userId: number; message: string;
  symbol?: string; severity?: string; metadata?: Record<string, unknown>;
}) {
  await db.insert(liveTradingAuditTable).values({
    eventId: randomUUID(),
    eventType: args.eventType,
    severity: args.severity ?? "INFO",
    mode: "READ_ONLY",
    symbol: args.symbol ?? null,
    message: args.message,
    actorRole: "user",
    metadata: { userId: args.userId, ...(args.metadata ?? {}) },
  });
}

// Task #28 — resolve the ownership-linking fields for a new live command.
// allocationId ties the command to the user's funding slot; cycleId ties an
// auto-managed Live Test Cycle command back to its cycle; source records the
// originating flow. All best-effort + nullable — never blocks a draft.
async function resolveOwnershipFields(args: {
  userId: number;
  cycleId?: string | null;
  source?: string | null;
}): Promise<{ allocationId: number | null; cycleId: string | null; source: string | null }> {
  let allocationId: number | null = null;
  try {
    const { userSlotAllocationTable } = await import("@workspace/db");
    const rows = await db.select({ id: userSlotAllocationTable.id })
      .from(userSlotAllocationTable)
      .where(eq(userSlotAllocationTable.userId, args.userId)).limit(1);
    allocationId = rows[0]?.id ?? null;
  } catch {
    allocationId = null;
  }
  return {
    allocationId,
    cycleId: args.cycleId ?? null,
    source: args.source ?? null,
  };
}

export interface LiveDraftInput {
  userId: number;
  commandType: ArxLiveCommandType;
  symbol: string;
  side: "BUY" | "SELL";
  orderType: string;
  requestedVolume: number;
  stopLoss?: number | null;
  takeProfit?: number | null;
  sourcePage?: string;
  rubyExplanationSummary?: string | null;
  payload?: Record<string, unknown>;
  /**
   * Task #30 — optional price the order was drafted against. Persisted on
   * `payload.referencePrice` and surfaced to the EA so its pre-trade guard can
   * refuse on slippage (DEVIATION_TOO_LARGE) if the live price has drifted past
   * the deviation cap by execution time. Null/absent => EA skips the deviation
   * leg (fail-open) and relies on its broker-side SetDeviationInPoints cap.
   */
  referencePrice?: number | null;
  ip?: string;
  /**
   * One-click fast-path SL override. Set ONLY by `/me/one-click/submit-live`
   * after verifying the user has `userOneClickSettings.allowOrdersWithoutStopLoss = true`
   * AND `liveOneClickEnabled = true` AND `approvedForMasterLive = true`.
   * When true the SL pre-flight is skipped AND the dispatch-time
   * `MISSING_STOP_LOSS` gate is treated as `adminAllowNoStopLoss = true`
   * for THIS draft only. Persisted on `payload.allowNoStopLossThisDraft`
   * so the dispatch-time eval can read it back.
   */
  allowNoStopLossThisDraft?: boolean;
  /**
   * Task #213 — Self-Trade AI autonomous-execution ownership tags (additive,
   * optional). When set, the command row is attributed to the originating agent
   * + supervisor-approved decision via the new `selfTradeAgentId` /
   * `selfTradeDecisionId` columns AND a `payload.agentOwnership` blob for audit.
   * Never weakens a gate; absent for every non-agent caller.
   */
  selfTradeAgentId?: number | null;
  selfTradeDecisionId?: number | null;
  selfTradeAgentKey?: string | null;
}

export interface LiveDraftRefusal {
  ok: false;
  reason:
    | "USER_NOT_ARMED_FOR_LIVE" | "KILL_SWITCH_ENGAGED"
    | "INVALID_COMMAND_TYPE" | "INVALID_SIDE"
    | "VOLUME_EXCEEDS_USER_MAX_LOT" | "VOLUME_EXCEEDS_MARKET_MAX_LOT"
    | "SYMBOL_NOT_ALLOWED" | "SYMBOL_NOT_LIVE_TRADABLE"
    | "SYMBOL_NOT_IN_ARX_FOCUS"
    | "SYNTHETIC_FEED_NOT_LIVE_CONFIRMED"
    | "INSUFFICIENT_DATA_FOR_ENTRY"
    | "MISSING_STOP_LOSS" | "MISSING_TAKE_PROFIT" | "MISSING_RISK_TEMPLATE"
    | "STOP_LOSS_WRONG_SIDE" | "STOP_LOSS_UNREASONABLE"
    | "NO_ACTIVE_BRIDGE"
    // Task #1 — Shared bridge master-pool pre-gate refusals. Always
    // wrapped with `LIVE_BLOCKED:` prefix in `friendlyReason` so the UI
    // can render the gate name uniformly. No row is inserted into
    // arx_live_commands when one of these fires.
    | "LIVE_BLOCKED:MASTER_BRIDGE_NOT_PINNED"
    | "LIVE_BLOCKED:MASTER_SNAPSHOT_MISSING"
    | "LIVE_BLOCKED:MASTER_SNAPSHOT_STALE"
    | "LIVE_BLOCKED:SHARED_LIVE_PAUSED"
    | "LIVE_BLOCKED:POOL_OVER_ALLOCATED"
    // No allocation row / assigned 0 — distinct from EXHAUSTED (assigned > 0 but
    // fully consumed by reserved risk + open floating loss). BOTH still block;
    // the split only gives the user honest copy ("none assigned" vs "consumed").
    | "LIVE_BLOCKED:USER_ALLOCATION_NOT_ASSIGNED"
    | "LIVE_BLOCKED:USER_ALLOCATION_EXHAUSTED"
    | "LIVE_BLOCKED:ALLOCATION_EXCEEDS_MASTER_AVAILABLE"
    | "LIVE_BLOCKED:ALLOCATION_FROZEN"
    // Task #737 — live-execution activation pre-condition. Additive gate: it
    // never weakens/skips/ORs the 18-gate dispatch. Fires when the trader has
    // not completed live confirmation / Full Live Activation, or when the
    // account is not an eligible human trader.
    | "LIVE_BLOCKED:LIVE_EXECUTION_ACTIVATION_GATE"
    | "LIVE_BLOCKED:BOT_AGENT_NOT_ALLOWED"
    | "LIVE_BLOCKED:INVESTOR_NOT_ALLOWED"
    // Task #30 — broker's OWN reported symbol rules (only enforced when the EA
    // has reported real broker truth for the symbol). Additive refusals.
    | "BROKER_RULE_MARKET_CLOSED" | "BROKER_RULE_SYMBOL_NOT_TRADABLE"
    | "BROKER_RULE_VOLUME_BELOW_MIN" | "BROKER_RULE_VOLUME_ABOVE_MAX"
    | "BROKER_RULE_VOLUME_OFF_STEP"
    | "BROKER_RULE_STOP_LOSS_TOO_CLOSE" | "BROKER_RULE_TAKE_PROFIT_TOO_CLOSE"
    | "BROKER_RULE_STOP_INSIDE_FREEZE";
  detail?: string;
  // Task #737 follow-up — the SPECIFIC execution-readiness blocker from the
  // shared resolver (`blockingReasonCode`, e.g. LIVE_CONFIRMATION_REQUIRED,
  // NOT_APPROVED_FOR_LIVE, LIVE_BRIDGE_ASSIGNMENT_PENDING). The canonical
  // `reason` stays the generic `LIVE_BLOCKED:LIVE_EXECUTION_ACTIVATION_GATE`
  // (CI guards + dispatch tests assert it); this carries the precise cause
  // forward so the UI can show exactly what to fix without weakening any gate.
  blockingReasonCode?: string;
}

/**
 * Pre-flight check: refuses the draft if the user is not armed, the kill
 * switch is engaged, the volume exceeds the per-user or per-market max,
 * the symbol is not allowed, or SL is missing (when required).
 */
async function preflight(input: LiveDraftInput): Promise<LiveDraftRefusal | { ok: true }> {
  if (!(ARX_LIVE_COMMAND_TYPES as readonly string[]).includes(input.commandType)) {
    return { ok: false, reason: "INVALID_COMMAND_TYPE", detail: input.commandType };
  }
  if (input.side !== "BUY" && input.side !== "SELL") {
    return { ok: false, reason: "INVALID_SIDE", detail: input.side };
  }

  const arming = await getMyArming(input.userId);
  if (!arming || !arming.isArmed) return { ok: false, reason: "USER_NOT_ARMED_FOR_LIVE" };
  if (arming.killSwitchEngaged) return { ok: false, reason: "KILL_SWITCH_ENGAGED" };

  // ── Task #737 — live-execution activation pre-condition (lockstep with the
  // dispatch-time re-check below). Additive: this never weakens/skips/ORs any
  // of the 18 Phase B dispatch gates — those still run on top of a PASS here.
  // Fail-closed via the shared resolver: a non-activated trader, or a
  // bot/agent/system/investor account, is refused before a draft is created.
  const activation = await evaluateLiveExecutionActivationGate(input.userId);
  if (!activation.passed) {
    // Keep `reason` canonical (CI guards + dispatch tests assert the generic
    // gate name) but thread the resolver's SPECIFIC blocker forward so the UI
    // can tell "approved but Full Live Activation missing" apart from
    // "feed not confirmed" etc. `detail` carries the user-safe sentence.
    return {
      ok: false,
      reason: `LIVE_BLOCKED:${activation.reason}` as LiveDraftRefusal["reason"],
      detail: activation.state.blockingReason ?? activation.detail ?? undefined,
      blockingReasonCode: activation.state.blockingReasonCode ?? undefined,
    };
  }

  // ── OWNER UNRESTRICTED LIVE PROFILE ─────────────────────────────────────
  // Resolved up-front (before the master-pool allocation pre-gate) so the
  // owner/admin unrestricted profile can be honoured by both the per-trade
  // margin proxy below and the Deriv-synthetic hard floor further down.
  // When the user has the "Owner Unrestricted Live" risk template, the
  // app-level caps (margin proxy, symbol allowlist, per-symbol lot,
  // daily-loss USD, SL/TP requirement) are not enforced at the preflight or
  // 16-gate input layer. EVERY other safety gate still runs: arming, kill
  // switch, master switch, bridge heartbeat, EA flags, account type, manual
  // confirmation, idempotency, audit, AND the real broker-side margin/symbol
  // validation at OrderSend. Assignment of this profile is OWNER-role-only at
  // /api/admin/users/:id/risk-profile.
  const ownerProfile = await getUserRiskProfile(input.userId);
  const isOwnerUnrestricted = ownerProfile.isOwnerUnrestricted;

  // ── T019 — EFFECTIVE GOVERNANCE (single source of truth) ────────────────
  // For owner/admin the app-added restrictions default OFF, but if the owner
  // turns one back ON in Admin Risk/Governance, this preflight must enforce it
  // again. `gov` carries the *effective* requirement. Normal-user behaviour is
  // untouched: every check below keeps its original protective branch and only
  // the owner branch consults governance.
  const gov = await getEffectiveTradingGovernance(input.userId, "LIVE_SHARED_BRIDGE");
  // T019 — unified governance decision (single source of truth). Owner AND
  // admin are privileged; when Owner Live Control Mode is ON the app-added
  // POLICY caps (order shape, symbol, lot, exposure, daily loss) follow
  // governance for BOTH roles. The shared-pool margin proxy and the Deriv
  // synthetic-floor relaxation stay OWNER-only below (they touch the shared
  // master pool / broker routing truth), so a plain admin still respects them.
  const useGovernance = gov.isPrivileged && gov.ownerLiveControlMode;

  // ── TASK #1 — SHARED BRIDGE MASTER-POOL PRE-GATE ───────────────────────
  // Runs BEFORE the operator-funded pilot gate and the 16-gate evaluator.
  // Applies only to entry commands (PLACE_LIVE_*); CLOSE/MODIFY are
  // intentionally allowed through so reconciliation can close exposure
  // even while the pool is over-allocated.
  //
  // The pre-gate is intentionally fail-CLOSED:
  //   1. Master bridge must be pinned.
  //   2. Heartbeat snapshot must be FRESH (≤60s) — never STALE/MISSING.
  //   3. sharedLivePaused must be false.
  //   4. Pool must not be over-allocated (Strict Real-Balance Mode).
  //   5. User's available allocation (allocated − reservedRisk − openFloatingLoss)
  //      must be > 0.
  //
  // On any failure: no arx_live_commands row is inserted; the refusal
  // bubbles up to createLiveDraft() which writes the LIVE_DRAFT_REFUSED
  // audit row.
  if (
    input.commandType === "PLACE_LIVE_MARKET_ORDER"
    || input.commandType === "PLACE_LIVE_PENDING_ORDER"
  ) {
    // Force-recompute so the gate decision is based on the freshest
    // possible aggregate. If the pinned master row is missing/stale this
    // returns ok:false with a typed reason.
    const recompute = await recomputeMasterPool();
    if (!recompute.ok || !recompute.pool) {
      const reason = recompute.reason === "MASTER_BRIDGE_NOT_PINNED"
        ? "LIVE_BLOCKED:MASTER_BRIDGE_NOT_PINNED" as const
        : "LIVE_BLOCKED:MASTER_SNAPSHOT_MISSING" as const;
      return { ok: false, reason,
        detail: "Live shared bridge is not available. Please try again shortly." };
    }
    const pool = recompute.pool;
    // Task #1 pre-gate parity with the later (line ~546) frozen check.
    // Surfacing the frozen state HERE — alongside paused/stale/missing/
    // over-allocated — keeps the typed LIVE_BLOCKED:<reason> contract
    // consistent for entry commands and avoids racing the rest of the
    // pool check on a frozen allocation. CLOSE_LIVE / MODIFY_LIVE_SLTP
    // still flow through the existing later check so partial freezes
    // (`tradingFrozen` only) can still let users close cleanly.
    {
      const { userSlotAllocationTable: _slotAllocTableEarly } = await import("@workspace/db");
      const allocRowEarly = await db.select({
        allocationStatus: _slotAllocTableEarly.allocationStatus,
        tradingFrozen: _slotAllocTableEarly.tradingFrozen,
        freezeReason: _slotAllocTableEarly.freezeReason,
      }).from(_slotAllocTableEarly)
        .where(eq(_slotAllocTableEarly.userId, input.userId)).limit(1);
      const rowEarly = allocRowEarly[0];
      if (rowEarly?.allocationStatus === "frozen" || rowEarly?.tradingFrozen) {
        return { ok: false, reason: "LIVE_BLOCKED:ALLOCATION_FROZEN",
          detail: rowEarly.freezeReason ?? "Your allocation is frozen by the operator. Contact your operator." };
      }
    }
    if (pool.sharedLivePaused) {
      return { ok: false, reason: "LIVE_BLOCKED:SHARED_LIVE_PAUSED",
        detail: pool.pausedReason ?? "Live shared trading is temporarily paused for reconciliation." };
    }
    if (pool.snapshotStatus === "MISSING") {
      return { ok: false, reason: "LIVE_BLOCKED:MASTER_SNAPSHOT_MISSING",
        detail: "Live bridge snapshot is missing." };
    }
    if (pool.snapshotStatus === "STALE") {
      return { ok: false, reason: "LIVE_BLOCKED:MASTER_SNAPSHOT_STALE",
        detail: "Live bridge snapshot is stale; please retry shortly." };
    }
    if (pool.isOverAllocated) {
      return { ok: false, reason: "LIVE_BLOCKED:POOL_OVER_ALLOCATED",
        detail: "Live bridge allocation is temporarily unavailable while the master balance is being reconciled." };
    }
    // Per-user allocation check — uses the canonical pool view so that
    // OPEN FLOATING LOSSES on this user's existing live positions are
    // subtracted from headroom alongside reservedRisk. A drawdown shrinks
    // the user's tradable headroom in real time.
    const view = await getUserAllocationView(input.userId);
    const userAllocated = view.assignedAllocation;
    const userAvailable = view.availableAllocation;
    // Honest split of the "available <= 0" block, decided by the pure
    // resolveAllocationGate helper (offline-tested). Both branches still refuse —
    // no gate is weakened — but a user with NO allocation assigned must not be
    // told their allocation is "exhausted by floating loss" (it never existed).
    const allocationGate = resolveAllocationGate(view);
    if (!allocationGate.ok) {
      return { ok: false, reason: allocationGate.reason, detail: allocationGate.detail };
    }
    // Per-trade required-margin estimate. We do not have a per-symbol
    // contract-size + leverage model in scope, so we use a deliberately
    // conservative notional-style proxy: lot * 1000 USD-equivalent. This
    // matches a typical 100:1 leveraged forex mini-lot margin envelope
    // and refuses obviously over-sized tickets (e.g. 5.0 lots on a $200
    // headroom). MT5 will still enforce true margin server-side.
    //
    // OWNER/ADMIN UNRESTRICTED: this internal proxy is skipped. The real
    // broker-side margin check at OrderSend remains the authority for the
    // unrestricted profile, so a tiny owner ticket (e.g. 0.01 lot of a
    // synthetic) is not refused by the $1000/lot heuristic. Every other
    // pool gate above (userAvailable > 0, isOverAllocated, master cap) STILL
    // applies to the owner.
    const REQUIRED_MARGIN_PROXY_PER_LOT_USD = 1000;
    const estRequiredMarginUsd = Math.max(0, input.requestedVolume) * REQUIRED_MARGIN_PROXY_PER_LOT_USD;
    // T019 — owner/admin skip this app-added shared-pool margin proxy unless
    // they re-enable the `enforceAllocationLimit` governance toggle. Keyed on
    // the unified governance decision so a plain admin's toggle is honoured too
    // (consistent with the read payloads). Normal users always enforce. The
    // hard master-cap reconciliation guard below AND the real broker-side margin
    // validation at OrderSend still run regardless.
    const enforceMarginProxy = !useGovernance || gov.enforceAllocationLimit;
    if (enforceMarginProxy && estRequiredMarginUsd > userAvailable) {
      return { ok: false, reason: "LIVE_BLOCKED:USER_ALLOCATION_EXHAUSTED",
        detail: `Trade estimated margin ${estRequiredMarginUsd.toFixed(2)} exceeds your available allocation ${userAvailable.toFixed(2)}.` };
    }
    // Reconciliation guard against master cap. We DO NOT re-use the
    // pool's remaining headroom (`min(balance,equity) - totalAllocated`)
    // as a per-trade limiter — that would double-count this user's own
    // assigned slice against their own trade. We only refuse when the
    // user's *assigned* allocation has somehow drifted above the
    // conservative master cap (drift = admin add raced with a balance
    // drop). The `isOverAllocated` check above covers the pool-wide
    // case; this leg covers the rare per-user drift case.
    const poolCap = Math.min(pool.mt5Balance, pool.mt5Equity);
    if (userAllocated > poolCap) {
      return { ok: false, reason: "LIVE_BLOCKED:ALLOCATION_EXCEEDS_MASTER_AVAILABLE",
        detail: "Your assigned allocation exceeds the master balance — contact your operator." };
    }
  }

  // Per-user max lot from arming. Owner/admin with Live Control Mode use the
  // governance lot policy (`gov.maxLotPerTrade`, default null = ∞) as the single
  // source of truth — checked at line ~479 and again by the dispatch evaluator —
  // instead of the arming-time confirmed cap. This mirrors every other lot/symbol
  // check in this preflight (474/488) and the dispatch path (1256), which all gate
  // on `useGovernance`. Normal (non-privileged) users keep the arming cap unchanged.
  // The broker's real margin/volume check at OrderSend remains the final authority.
  if (!useGovernance && arming.maxLotConfirmed != null && input.requestedVolume > arming.maxLotConfirmed) {
    return { ok: false, reason: "VOLUME_EXCEEDS_USER_MAX_LOT",
      detail: `requested ${input.requestedVolume} > user max ${arming.maxLotConfirmed}` };
  }

  // Per-market max lot from user settings (or defaults).
  const settings = await getOrCreateUserSettings(input.userId);

  // HARD FLOOR — Deriv-synthetic live tradability.
  // A symbol whose data source is a Deriv synthetic / data-only feed is, in
  // general, NOT routable on a standard MT5 broker, so dispatching one would
  // silently fail or route to the wrong instrument. We therefore keep the
  // hard refusal for everyone EXCEPT the owner/admin unrestricted profile when
  // BOTH of the following hold:
  //   1. the connected master broker is Deriv (Deriv MT5 genuinely offers
  //      these synthetics, e.g. "Volatility 25 (1s) Index"), AND
  //   2. the symbol is confirmed tradable — either the EA has reported real
  //      broker truth saying it is tradable, or (until the EA reports specs)
  //      no broker truth exists yet and the broker is Deriv with a known
  //      Deriv synthetic instrument.
  // The real broker-side symbol/margin validation at OrderSend remains the
  // final authority and rejects honestly if the broker disagrees. Normal
  // users and non-Deriv brokers still hit the original hard refusal.
  // Task #558 — ARX Focus market backstop (PREFLIGHT chokepoint, additive).
  // NEW-ENTRY ONLY: an unapproved symbol is refused BEFORE any tradability /
  // candle / quote work and before any broker send. This is purely additive —
  // it composes above (never replaces or relaxes) the synthetic floor, the
  // 16-gate evaluator, the SL policy, caps, the kill switch, and the
  // owner/admin relaxations. Position management (close / modify / cancel) is
  // EXEMPT by construction: it is gated on the new-entry command types only, so
  // an existing position on any symbol can always be managed. The dispatch
  // chokepoint mirrors this EXACTLY via the same `isApprovedArxMarket` helper so
  // preflight and dispatch can never drift.
  if (
    (input.commandType === "PLACE_LIVE_MARKET_ORDER" ||
      input.commandType === "PLACE_LIVE_PENDING_ORDER") &&
    !isApprovedArxMarket(input.symbol)
  ) {
    return { ok: false, reason: "SYMBOL_NOT_IN_ARX_FOCUS", detail: ARX_FOCUS_BLOCKED_REASON };
  }

  // ── DATA-SUFFICIENCY TRUTH (Phase 2) — entry data-sufficiency gate ─────────
  // Block-only, NEW-ENTRY only, additive. Runs right after the ARX Focus
  // backstop and BEFORE the synthetic floor / SL policy / 18-gate evaluator —
  // all of which still run afterwards and keep final say. Uses the shared
  // `evaluateEntryDataSufficiency` helper so preflight + dispatch can never
  // drift (lockstep). Fail-closed: an unverifiable feed refuses the entry. It
  // can only BLOCK — it never grants an entry or relaxes any downstream gate.
  if (
    input.commandType === "PLACE_LIVE_MARKET_ORDER" ||
    input.commandType === "PLACE_LIVE_PENDING_ORDER"
  ) {
    const sufficiency = await evaluateEntryDataSufficiency(input.symbol);
    if (sufficiency.shouldBlock) {
      return { ok: false, reason: "INSUFFICIENT_DATA_FOR_ENTRY", detail: sufficiency.humanReason };
    }
  }

  if (input.commandType === "PLACE_LIVE_MARKET_ORDER" || input.commandType === "PLACE_LIVE_PENDING_ORDER") {
    const tradability = await getSymbolTradability(input.symbol, input.userId);
    const isSyntheticOrDataOnly = tradability.assetClass === "synthetic" || tradability.dataProvider === "deriv";
    if (isSyntheticOrDataOnly) {
      let brokerIsDeriv = false;
      let brokerTruthBlocks = false;
      // Phase 2 (Task #542) — per-symbol LIVE confirmation. Even for the
      // owner/admin unrestricted profile, a Deriv synthetic may go live ONLY
      // when THIS symbol is genuinely ticking now (a confirmed per-symbol live
      // tick within the freshness window). This is a TIGHTENING that never
      // relaxes the floor: it ADDS an honest refusal so a stale / historical
      // synthetic read can never become a live entry. The verdict is the SAME
      // one the chart/scanner badge shows for the symbol. These inputs are
      // resolved only for the owner-unrestricted profile (the only profile the
      // relaxation can apply to); the shared `evaluateSyntheticLiveFloor`
      // contract makes the actual decision so preflight + dispatch never drift.
      let feedVerdict: SymbolFeedVerdict = "AWAITING";
      if (isOwnerUnrestricted) {
        const masterConnId = await resolveActiveMasterConnectionId();
        if (masterConnId != null) {
          const mc = await db.select({ brokerName: mt5ConnectionTable.brokerName })
            .from(mt5ConnectionTable).where(eq(mt5ConnectionTable.id, masterConnId)).limit(1);
          brokerIsDeriv = /deriv/i.test(mc[0]?.brokerName ?? "");
        }
        const spec = await getBrokerSymbolSpec(input.userId, input.symbol);
        brokerTruthBlocks = spec.hasBrokerTruth && (
          spec.spec.tradeAllowed === false
          || spec.spec.visible === false
          || spec.spec.tradeMode === "DISABLED"
          || spec.spec.tradeMode === "CLOSEONLY"
        );
        feedVerdict = await resolveSymbolFeedVerdictForSymbol(input.symbol);
      }
      const verdict = evaluateSyntheticLiveFloor({
        isSyntheticOrDataOnly,
        isOwnerUnrestricted,
        brokerIsDeriv,
        brokerTruthBlocks,
        feedVerdict,
      });
      if (verdict === "SYNTHETIC_FEED_NOT_LIVE_CONFIRMED") {
        const why = feedVerdict === "LIVE_DELAYED"
          ? "the live tick is active but the newest bar is delayed"
          : "no recent live tick";
        return { ok: false, reason: "SYNTHETIC_FEED_NOT_LIVE_CONFIRMED",
          detail: `${input.symbol} synthetic feed is not live-confirmed (${why}); live entry requires a clean, current live feed.` };
      }
      if (verdict === "SYMBOL_NOT_LIVE_TRADABLE") {
        return { ok: false, reason: "SYMBOL_NOT_LIVE_TRADABLE",
          detail: `${input.symbol} is a data-only market (${tradability.dataProvider}); MT5 live execution is not available regardless of risk profile.` };
      }
    }
  }
  const perMarketMap = (settings.maxLotPerMarket as Record<string, number>) ?? {};
  const marketMax = perMarketMap[input.symbol] ?? ARX_LIVE_DEFAULT_MAX_LOT_PER_MARKET[input.symbol];
  if (!useGovernance && marketMax != null && input.requestedVolume > marketMax) {
    return { ok: false, reason: "VOLUME_EXCEEDS_MARKET_MAX_LOT",
      detail: `requested ${input.requestedVolume} > ${input.symbol} max ${marketMax}` };
  }
  // T019 — owner/admin-governance per-trade lot cap (only when one is set).
  if (useGovernance && gov.maxLotPerTrade != null && input.requestedVolume > gov.maxLotPerTrade) {
    return { ok: false, reason: "VOLUME_EXCEEDS_MARKET_MAX_LOT",
      detail: `requested ${input.requestedVolume} > governance max ${gov.maxLotPerTrade}` };
  }

  // Allowed symbols list.
  const allowed = ((settings.allowedSymbols as string[]) ?? []).length > 0
    ? (settings.allowedSymbols as string[])
    : ARX_LIVE_DEFAULT_ALLOWED_SYMBOLS;
  if (!useGovernance && !allowed.includes(input.symbol)) {
    return { ok: false, reason: "SYMBOL_NOT_ALLOWED", detail: input.symbol };
  }
  // T019 — owner/admin-governance symbol allowlist/blocklist (only when enabled).
  if (useGovernance) {
    if (gov.blockedSymbols.includes(input.symbol)) {
      return { ok: false, reason: "SYMBOL_NOT_ALLOWED", detail: input.symbol };
    }
    if (gov.enforceSymbolAllowlist && gov.allowedSymbols != null && !gov.allowedSymbols.includes(input.symbol)) {
      return { ok: false, reason: "SYMBOL_NOT_ALLOWED", detail: input.symbol };
    }
  }

  // Stop-loss required unless admin override OR this is an explicit
  // one-click fast-path draft whose per-user setting permits no-SL.
  // T019 — owner uses governance.requireStopLoss (default OFF; ON re-enforces).
  // Normal users keep the protective settings-based requirement unchanged.
  const stopLossRequired = useGovernance
    ? gov.requireStopLoss
    : (settings.requireStopLoss && !settings.adminAllowNoStopLoss);
  if (
    stopLossRequired &&
    !input.allowNoStopLossThisDraft &&
    (input.stopLoss == null || input.stopLoss <= 0) &&
    (input.commandType === "PLACE_LIVE_MARKET_ORDER" || input.commandType === "PLACE_LIVE_PENDING_ORDER")
  ) {
    return { ok: false, reason: "MISSING_STOP_LOSS" };
  }

  // Phase 22V Part 3 — take-profit required for approved-shared-bridge
  // users. Read from user_master_live_access.require_take_profit (mirrored
  // safe default true on first approval). Applies to entry orders only;
  // CLOSE/MODIFY ops are gated separately in `createLiveOpsDraft`.
  if (
    input.commandType === "PLACE_LIVE_MARKET_ORDER"
    || input.commandType === "PLACE_LIVE_PENDING_ORDER"
  ) {
    const accessRows = await db.select({
      requireTakeProfit: userMasterLiveAccessTable.requireTakeProfit,
      assignedRiskTemplateId: userMasterLiveAccessTable.assignedRiskTemplateId,
      approvedForMasterLive: userMasterLiveAccessTable.approvedForMasterLive,
    }).from(userMasterLiveAccessTable)
      .where(eq(userMasterLiveAccessTable.userId, input.userId)).limit(1);
    // T019 — owner uses governance.requireTakeProfit (default OFF). Normal
    // users keep the access-table requirement unchanged.
    const takeProfitRequired = useGovernance
      ? gov.requireTakeProfit
      : (accessRows[0]?.requireTakeProfit ?? true);
    if (
      takeProfitRequired
      && (input.takeProfit == null || input.takeProfit <= 0)
    ) {
      return { ok: false, reason: "MISSING_TAKE_PROFIT" };
    }
    // Phase 22V Part 3 — defense in depth: an approved-for-master-live
    // user must always carry an assigned risk template. The approval
    // handler seeds the "Approved Shared Bridge Default" template
    // automatically; if data drift ever leaves an approved user with a
    // NULL template, block entry orders until ops reassigns one.
    if (
      accessRows[0]?.approvedForMasterLive
      && accessRows[0].assignedRiskTemplateId == null
    ) {
      return { ok: false, reason: "MISSING_RISK_TEMPLATE" };
    }
  }

  // ── Stop-loss SANITY check (physics, not policy) ───────────────────────
  // Applies to every profile including OWNER unrestricted — a long with
  // SL above entry, or a short with SL below entry, is malformed
  // regardless of risk template. Catches operator typos like
  // "SL=1.80 on EURUSD" (≈55% above 1.16 spot) before they reach the
  // 16-gate or MT5's broker-side INVALID_STOPS rejection.
  //
  // Best-effort: only enforces when we can fetch a usable quote. If the
  // quote source is unavailable, skip silently — MT5's own
  // INVALID_STOPS retcode will still catch a malformed stop downstream.
  if (
    (input.commandType === "PLACE_LIVE_MARKET_ORDER" || input.commandType === "PLACE_LIVE_PENDING_ORDER")
    && input.stopLoss != null && input.stopLoss > 0
  ) {
    try {
      const { getMarketProvider } = await import("../assistant/marketProvider.js");
      const q = await getMarketProvider().getLiveQuote(input.symbol);
      const ref = input.side === "BUY"
        ? (q.ask ?? q.price)
        : (q.bid ?? q.price);
      if (ref != null && ref > 0) {
        if (input.side === "BUY" && input.stopLoss >= ref) {
          return { ok: false, reason: "STOP_LOSS_WRONG_SIDE",
            detail: `BUY ${input.symbol}: stop ${input.stopLoss} must be below current price ${ref.toFixed(5)}.` };
        }
        if (input.side === "SELL" && input.stopLoss <= ref) {
          return { ok: false, reason: "STOP_LOSS_WRONG_SIDE",
            detail: `SELL ${input.symbol}: stop ${input.stopLoss} must be above current price ${ref.toFixed(5)}.` };
        }
        const distPct = Math.abs(input.stopLoss - ref) / ref;
        if (distPct > 0.5) {
          return { ok: false, reason: "STOP_LOSS_UNREASONABLE",
            detail: `Stop ${input.stopLoss} is ${Math.round(distPct * 100)}% away from current price ${ref.toFixed(5)} on ${input.symbol} — looks like a pip/price typo.` };
        }
      }
    } catch {
      // Quote unavailable; defer to the 16-gate + MT5 broker rejection.
    }
  }

  // ── Task #30 — BROKER-RULE pre-trade guard (additive refusal) ──────────────
  // Validate against the broker's OWN reported symbol rules (lot min/max/step,
  // stops/freeze level, tradability, session). This only runs when the EA has
  // reported real broker truth for the symbol; otherwise we defer to the EA's
  // own pre-submit guard + MT5's broker-side rejection (no false blocks).
  //
  // Real-time quote checks (stale tick, spread, slippage) are intentionally
  // NOT enforced here — the server has no reliable per-symbol tick age; those
  // belong to the EA which holds the live tick. We only act on the deterministic
  // broker-rule reasons. A PASS NEVER bypasses any later gate.
  if (input.commandType === "PLACE_LIVE_MARKET_ORDER" || input.commandType === "PLACE_LIVE_PENDING_ORDER") {
    try {
      const resolved = await getBrokerSymbolSpec(input.userId, input.symbol);
      if (resolved.hasBrokerTruth) {
        // Best-effort quote just for the stops/freeze reference price; freshness
        // is treated as fresh (age 0) so the server never raises QUOTE_STALE.
        let bid: number | null = null;
        let ask: number | null = null;
        try {
          const { getMarketProvider } = await import("../assistant/marketProvider.js");
          const q = await getMarketProvider().getLiveQuote(input.symbol);
          bid = q.bid ?? q.price ?? null;
          ask = q.ask ?? q.price ?? null;
        } catch { /* no quote — stops/freeze legs skip, spec legs still enforce */ }
        const guard = evaluatePreTradeBrokerGuard({
          side: input.side,
          volume: input.requestedVolume,
          stopLoss: input.stopLoss ?? null,
          takeProfit: input.takeProfit ?? null,
          requestedPrice: null, // server does not enforce slippage
          quote: { bid, ask, quoteAgeMs: 0 },
          spec: resolved.spec,
          limits: DEFAULT_PRE_TRADE_GUARD_LIMITS,
        });
        // Only the deterministic broker-rule reasons are server-enforced.
        const SERVER_ENFORCED: ReadonlySet<PreTradeGuardKey> = new Set<PreTradeGuardKey>([
          "MARKET_CLOSED", "SYMBOL_NOT_TRADABLE",
          "VOLUME_BELOW_MIN", "VOLUME_ABOVE_MAX", "VOLUME_OFF_STEP",
          "STOP_LOSS_TOO_CLOSE", "TAKE_PROFIT_TOO_CLOSE", "STOP_INSIDE_FREEZE",
        ]);
        const firstEnforced = guard.checks.find((c) => !c.passed && SERVER_ENFORCED.has(c.key));
        if (firstEnforced) {
          return {
            ok: false,
            reason: `BROKER_RULE_${firstEnforced.key}` as LiveDraftRefusal["reason"],
            detail: `${explainPreTradeGuard(firstEnforced.key)}${firstEnforced.detail ? ` (${firstEnforced.detail})` : ""}`,
          };
        }
      }
    } catch {
      // Resolver failure must never block a trade that would otherwise pass;
      // defer to the EA guard + MT5 broker rejection.
    }
  }

  // ── Task #785 (option 2) — UNIFIED READINESS OBSERVATION (additive only) ────
  // Every canonical preflight gate above has now PASSED. Consume the ONE shared
  // unified live-readiness resolver here purely to OBSERVE: it logs a single
  // honest readiness record so the dispatch preflight and the UI/debug panel
  // read the same resolver, and so an operator can see any drift (e.g. a feed
  // or allocation blocker the resolver sees that this preflight let pass).
  //
  // This is strictly observational — it NEVER changes the return value. The
  // canonical preflight gates above and the 18-gate dispatch below remain the
  // sole authority. It cannot create a bypass (it runs only on the pass path and
  // its result is logged, never branched on) and it cannot create a new block
  // (the function returns `{ ok: true }` unconditionally regardless of what the
  // resolver reports). Fail-soft: a resolver error is swallowed so observability
  // can never break a trade that already passed every real gate.
  try {
    const unified = await buildUnifiedLiveReadiness(input.userId, {
      symbol: input.symbol,
    });
    const observation = buildLivePreflightReadinessObservation({
      preflightBlocked: false,
      preflightReason: null,
      unified,
    });
    if (observation.unifiedReportsAdditionalBlock) {
      logger.warn(
        {
          userId: input.userId,
          symbol: input.symbol,
          commandType: input.commandType,
          unifiedLiveEntryEligible: observation.unifiedLiveEntryEligible,
          unifiedBlockerCodes: observation.unifiedBlockerCodes,
        },
        "live-preflight: unified readiness reports additional blocker(s) while preflight passed (observational — dispatch authority unchanged)",
      );
    } else {
      logger.info(
        {
          userId: input.userId,
          symbol: input.symbol,
          commandType: input.commandType,
          unifiedLiveEntryEligible: observation.unifiedLiveEntryEligible,
          unifiedBlockerCodes: observation.unifiedBlockerCodes,
        },
        "live-preflight: unified readiness observation",
      );
    }
  } catch (err) {
    logger.warn(
      { err, userId: input.userId, symbol: input.symbol },
      "live-preflight: unified readiness observation failed (ignored — non-gating)",
    );
  }

  return { ok: true };
}

/**
 * Phase B — Create a draft for CLOSE_LIVE_POSITION or MODIFY_LIVE_SLTP.
 * These ops are bound to an existing live position (ticket) and skip the
 * place-only preflight (SL requirement, market-allowlist for new entries).
 * Still requires user-armed + kill-switch off; volume + symbol come from
 * the position row.
 */
export async function createLiveOpsDraft(input: {
  userId: number;
  commandType: "CLOSE_LIVE_POSITION" | "MODIFY_LIVE_SLTP";
  brokerTicket: string;
  symbol: string;
  side: "BUY" | "SELL";
  volume: number;
  newStopLoss?: number | null;
  newTakeProfit?: number | null;
  sourcePage?: string;
  // Task #28 — ownership linking for auto-managed ops (e.g. Live Test Cycle
  // auto-close). Optional + nullable.
  cycleId?: string | null;
  // Task #743 Cluster D — narrow, admin-emergency-close-only kill-switch bypass.
  // When present AND commandType is CLOSE_LIVE_POSITION, the per-user kill switch
  // does NOT block this reduce-risk close. It is funnelled through the SAME
  // pipeline + 18-gate dispatch; ONLY gate #5 (kill switch) is relaxed and ONLY
  // for the CLOSE. The admin emergency-close route is the sole caller that sets
  // this, after verifying OWNER/ADMIN role, the confirmation phrase, and
  // read-only ownership. NEVER honored for OPEN / MODIFY / increase-exposure.
  killSwitchCloseBypass?: KillSwitchCloseBypass | null;
}): Promise<{ ok: true; command: ArxLiveCommand } | { ok: false; reason: string; detail?: string }> {
  const arming = await getMyArming(input.userId);
  if (!arming || !arming.isArmed) return { ok: false, reason: "USER_NOT_ARMED_FOR_LIVE" };
  // Narrow kill-switch bypass — honored ONLY for an admin emergency CLOSE.
  const bypassApplies = killSwitchCloseBypassApplies({
    commandType: input.commandType,
    hasBypassMarker: !!input.killSwitchCloseBypass,
  });
  if (arming.killSwitchEngaged && !bypassApplies) {
    return { ok: false, reason: "KILL_SWITCH_ENGAGED" };
  }

  const bridge = (await db.select().from(mt5ConnectionTable)
    .where(eq(mt5ConnectionTable.userId, input.userId))).find((b) => !b.tokenRevokedAt) ?? null;

  const ownership = await resolveOwnershipFields({
    userId: input.userId,
    cycleId: input.cycleId ?? null,
    source: input.sourcePage ?? "LIVE_POSITION_OPS",
  });

  const commandId = `lvcmd_${randomUUID()}`;
  const opsOrderType = input.commandType === "CLOSE_LIVE_POSITION" ? "CLOSE" : "MODIFY";
  const opsPayload: Record<string, unknown> = {
    brokerTicket: input.brokerTicket,
    newStopLoss: input.newStopLoss ?? null,
    newTakeProfit: input.newTakeProfit ?? null,
  };
  // Task #743 Cluster D — stamp the bypass marker into the payload BEFORE the
  // integrity hash is computed, so the marker is covered by the integrity
  // envelope and cannot be forged after draft creation. Only stamped when the
  // bypass actually applies (CLOSE + marker present).
  if (bypassApplies && input.killSwitchCloseBypass) {
    opsPayload["killSwitchCloseBypass"] = {
      reason: input.killSwitchCloseBypass.reason,
      source: input.killSwitchCloseBypass.source,
      initiatorAdminId: input.killSwitchCloseBypass.initiatorAdminId,
      initiatorRole: input.killSwitchCloseBypass.initiatorRole,
      killSwitchEngagedAtDraft: !!arming.killSwitchEngaged,
      stampedAt: new Date().toISOString(),
    };
  }
  // AACI Security Phase 3 — stamp the integrity envelope on the ops command too
  // (close/modify are sensitive live commands). Actor = the per-user owner.
  const opsIntegrity: CommandIntegrityFields = buildCommandIntegrityFields({
    commandId,
    userId: input.userId,
    commandType: input.commandType,
    symbol: input.symbol,
    side: input.side,
    orderType: opsOrderType,
    requestedVolume: input.volume,
    stopLoss: input.newStopLoss ?? null,
    takeProfit: input.newTakeProfit ?? null,
    payload: opsPayload,
    actorId: input.userId,
    actorType: "USER",
  });
  const [row] = await db.insert(arxLiveCommandsTable).values({
    commandId,
    userId: input.userId,
    bridgeConnectionId: bridge?.id ?? null,
    accountLogin: bridge?.accountNumber ?? null,
    brokerServer: bridge?.brokerName ?? null,
    accountNumber: arming.accountNumberConfirmed,
    commandType: input.commandType,
    status: "LIVE_CONFIRMATION_REQUIRED",
    symbol: input.symbol,
    side: input.side,
    orderType: opsOrderType,
    requestedVolume: input.volume,
    stopLoss: input.newStopLoss ?? null,
    takeProfit: input.newTakeProfit ?? null,
    sourcePage: input.sourcePage ?? "LIVE_POSITION_OPS",
    allocationId: ownership.allocationId,
    cycleId: ownership.cycleId,
    source: ownership.source,
    payload: opsPayload,
    payloadHash: opsIntegrity.payloadHash,
    integrityHash: opsIntegrity.integrityHash,
    integrityKeyVersion: opsIntegrity.integrityKeyVersion,
    integrityStatus: opsIntegrity.integrityStatus,
    actorId: opsIntegrity.actorId,
    actorType: opsIntegrity.actorType,
    actionType: opsIntegrity.actionType,
  }).returning();

  await audit({
    eventType: "LIVE_DRAFT_CREATED", userId: input.userId, symbol: input.symbol,
    message: `Live ops draft created: ${input.commandType} ticket=${input.brokerTicket}`,
    metadata: { commandId, commandType: input.commandType, brokerTicket: input.brokerTicket },
  });

  // Task #743 Cluster D (C-audit) — distinct audit row when the kill-switch
  // bypass is actually applied to a CLOSE while the kill switch is engaged.
  if (bypassApplies && arming.killSwitchEngaged && input.killSwitchCloseBypass) {
    await audit({
      eventType: "LIVE_EMERGENCY_CLOSE_KILL_SWITCH_BYPASS",
      severity: "HIGH",
      userId: input.userId,
      symbol: input.symbol,
      message: `Kill-switch bypass applied for admin emergency CLOSE ticket=${input.brokerTicket}`,
      metadata: {
        commandId,
        action: "CLOSE",
        brokerTicket: input.brokerTicket,
        killSwitchEngaged: true,
        bypassReason: input.killSwitchCloseBypass.reason,
        source: input.killSwitchCloseBypass.source,
        initiatorAdminId: input.killSwitchCloseBypass.initiatorAdminId,
        initiatorRole: input.killSwitchCloseBypass.initiatorRole,
      },
    });
  }

  return { ok: true, command: row };
}

// T015 — owner/admin manual live-testing phase tag. Stamped on every
// owner/admin MANUAL live OPEN draft (both the refusal-audit row and the
// created-command row) so each manual live attempt — pass or block — is
// attributable to the T015 phase in the existing live audit trail, and the
// count of placed T015 manual trades is queryable directly from
// arx_live_commands (payload ->> 'phaseTag'). This is a label ONLY: it
// changes no gate, no limit, and no dispatch path. It is intentionally NOT
// applied to:
//   - T014 Live Test Cycle drafts (they carry their own cycleId attribution),
//   - reduce-only ops drafts (close/modify go through createLiveOpsDraft),
//   - non-owner users (isOwnerUnrestricted=false).
export const T015_MANUAL_LIVE_PHASE = "T015_MANUAL_LIVE" as const;
export const T015_MANUAL_LIVE_PHASE_LABEL =
  "Phase T015 — owner/admin manual live testing (ongoing, no per-trade limit)" as const;

async function resolveManualLivePhase(input: LiveDraftInput): Promise<string | null> {
  // Never tag the T014 single-shot Live Test Cycle path — it owns its own
  // cycleId attribution and must stay distinct from ongoing manual testing.
  const sourcePage = input.sourcePage ?? "";
  if (sourcePage.startsWith("LIVE_TEST_CYCLE")) return null;
  const payloadCycleId = (input.payload as Record<string, unknown> | undefined)?.["liveTestCycleId"];
  if (typeof payloadCycleId === "string" && payloadCycleId.length > 0) return null;
  // Owner/admin tester only — the same unrestricted-profile proxy the
  // shared-execute route uses to recognise the operator's own account.
  const profile = await getUserRiskProfile(input.userId);
  return profile.isOwnerUnrestricted ? T015_MANUAL_LIVE_PHASE : null;
}

export async function createLiveDraft(
  input: LiveDraftInput,
): Promise<{ ok: true; command: ArxLiveCommand } | LiveDraftRefusal> {
  // Resolve the phase tag BEFORE preflight so a refused draft is still
  // attributable to T015 in the audit log.
  const phaseTag = await resolveManualLivePhase(input);
  const pre = await preflight(input);
  if (!pre.ok) {
    await audit({
      eventType: "LIVE_DRAFT_REFUSED",
      severity: "WARNING",
      userId: input.userId,
      symbol: input.symbol,
      message: `Live draft refused: ${pre.reason}${pre.detail ? ` (${pre.detail})` : ""}`,
      metadata: { reason: pre.reason, detail: pre.detail, commandType: input.commandType, requestedVolume: input.requestedVolume, phase: phaseTag },
    });
    return pre;
  }

  const arming = (await getMyArming(input.userId))!;
  const bridge = arming
    ? (await db.select().from(mt5ConnectionTable)
        .where(eq(mt5ConnectionTable.userId, input.userId))).find((b) => !b.tokenRevokedAt) ?? null
    : null;

  // Task #28 — derive the cycle link from the payload the caller passed
  // (Live Test Cycle stamps `liveTestCycleId`), then resolve allocation +
  // source for ownership traceability.
  const draftCycleId = typeof (input.payload as Record<string, unknown> | undefined)?.["liveTestCycleId"] === "string"
    ? String((input.payload as Record<string, unknown>)["liveTestCycleId"])
    : null;
  const ownership = await resolveOwnershipFields({
    userId: input.userId,
    cycleId: draftCycleId,
    source: input.sourcePage ?? "LIVE_TRADE_TICKET",
  });

  const commandId = `lvcmd_${randomUUID()}`;
  // SAFETY: scrub the override key from any client-supplied payload —
  // only this server-side path may set it, and only from the dedicated
  // `input.allowNoStopLossThisDraft` argument (which itself is gated
  // by `/me/one-click/submit-live` verifying liveOneClickEnabled +
  // allowOrdersWithoutStopLoss + master-live access). A client cannot
  // smuggle the bit through `payload`.
  const draftPayload: Record<string, unknown> = (() => {
    const raw = (input.payload ?? {}) as Record<string, unknown>;
    const { allowNoStopLossThisDraft: _stripped, referencePrice: _rpStripped, ...safe } = raw;
    // referencePrice is set ONLY from the typed server-side argument, never
    // smuggled through client payload (stripped above).
    const withRef = typeof input.referencePrice === "number" && input.referencePrice > 0
      ? { ...safe, referencePrice: input.referencePrice }
      : safe;
    // T015 — label this owner/admin manual live OPEN draft so the placed
    // count is queryable from arx_live_commands (payload ->> 'phaseTag').
    const withPhase = phaseTag != null ? { ...withRef, phaseTag } : withRef;
    // Task #213 — stamp self-trade agent ownership into the payload for audit
    // traceability (mirrors the typed columns; absent for non-agent drafts).
    const withAgent = input.selfTradeAgentId != null
      ? {
          ...withPhase,
          agentOwnership: {
            selfTradeAgentId: input.selfTradeAgentId,
            selfTradeDecisionId: input.selfTradeDecisionId ?? null,
            selfTradeAgentKey: input.selfTradeAgentKey ?? null,
          },
        }
      : withPhase;
    return input.allowNoStopLossThisDraft === true
      ? { ...withAgent, allowNoStopLossThisDraft: true as const }
      : withAgent;
  })();

  // AACI Security Phase 3 — stamp the command-integrity envelope (payload hash +
  // HMAC signature) in the SAME insert. Advisory-additive: re-verified before
  // the 16-gate at dispatch. Actor = the per-user owner; SELF_TRADE_AGENT when
  // an agent originated the draft.
  const draftActorType: CommandActorType = input.selfTradeAgentId != null ? "SELF_TRADE_AGENT" : "USER";
  const integrity: CommandIntegrityFields = buildCommandIntegrityFields({
    commandId,
    userId: input.userId,
    commandType: input.commandType,
    symbol: input.symbol,
    side: input.side,
    orderType: input.orderType,
    requestedVolume: input.requestedVolume,
    stopLoss: input.stopLoss ?? null,
    takeProfit: input.takeProfit ?? null,
    payload: draftPayload,
    actorId: input.userId,
    actorType: draftActorType,
  });

  const [row] = await db.insert(arxLiveCommandsTable).values({
    commandId,
    userId: input.userId,
    bridgeConnectionId: bridge?.id ?? null,
    accountLogin: bridge?.accountNumber ?? null,
    brokerServer: bridge?.brokerName ?? null,
    accountNumber: arming.accountNumberConfirmed,
    commandType: input.commandType,
    status: "LIVE_CONFIRMATION_REQUIRED",
    symbol: input.symbol,
    side: input.side,
    orderType: input.orderType,
    requestedVolume: input.requestedVolume,
    stopLoss: input.stopLoss ?? null,
    takeProfit: input.takeProfit ?? null,
    sourcePage: input.sourcePage ?? "LIVE_TRADE_TICKET",
    allocationId: ownership.allocationId,
    cycleId: ownership.cycleId,
    source: ownership.source,
    // Task #213 — self-trade agent/decision attribution (additive, nullable).
    selfTradeAgentId: input.selfTradeAgentId ?? null,
    selfTradeDecisionId: input.selfTradeDecisionId ?? null,
    rubyExplanationSummary: input.rubyExplanationSummary ?? null,
    payload: draftPayload,
    payloadHash: integrity.payloadHash,
    integrityHash: integrity.integrityHash,
    integrityKeyVersion: integrity.integrityKeyVersion,
    integrityStatus: integrity.integrityStatus,
    actorId: integrity.actorId,
    actorType: integrity.actorType,
    actionType: integrity.actionType,
  }).returning();

  await audit({
    eventType: "LIVE_DRAFT_CREATED", userId: input.userId, symbol: input.symbol,
    message: `Live draft created (awaiting confirmation): ${commandId}`,
    metadata: { commandId, requestedVolume: input.requestedVolume, side: input.side, phase: phaseTag },
  });

  return { ok: true, command: row };
}

function assertCanTransition(from: ArxLiveCommandStatus, to: ArxLiveCommandStatus) {
  if (!ALLOWED_TRANSITIONS[from].includes(to)) {
    throw new Error(`Illegal live command transition: ${from} -> ${to}`);
  }
}

export async function confirmLiveCommand(args: { userId: number; commandId: string }) {
  const row = await loadOwned(args.userId, args.commandId);
  if (!row) return { ok: false as const, reason: "COMMAND_NOT_FOUND" as const };
  if (row.status !== "LIVE_CONFIRMATION_REQUIRED") {
    return { ok: false as const, reason: "BAD_STATE" as const, currentStatus: row.status };
  }
  assertCanTransition(row.status as ArxLiveCommandStatus, "LIVE_APPROVED");
  // P0-1 — compare-and-set, not a bare id match. The status check above is a
  // READ; without a status predicate on the WRITE, two concurrent confirms of
  // the same draft both pass that read and both "succeed", producing two
  // LIVE_APPROVED transitions (and two audit rows) for one command. A null
  // return means a concurrent confirmer already claimed it.
  const updated = await claimLiveCommandForConfirm(args.commandId, {
    status: "LIVE_APPROVED",
    confirmedAt: new Date(),
  });
  if (!updated) {
    const [current] = await db.select({ status: arxLiveCommandsTable.status })
      .from(arxLiveCommandsTable)
      .where(eq(arxLiveCommandsTable.commandId, args.commandId)).limit(1);
    return {
      ok: false as const,
      reason: LIVE_CONFIRM_RACE_LOST,
      currentStatus: (current?.status ?? row.status) as ArxLiveCommandStatus,
    };
  }
  await audit({
    eventType: "LIVE_CONFIRMED", userId: args.userId, symbol: row.symbol,
    message: `Live command confirmed: ${args.commandId}`,
  });
  return { ok: true as const, command: updated };
}

/**
 * Phase B dispatch — runs the 15-gate live dispatch evaluator. On PASS, the
 * row transitions to `SENT_TO_MT5_LIVE`, sets `sentToMt5At` + `idempotencyKey`,
 * and waits for EA pickup at `POST /api/mt5/live-commands-poll`. On BLOCKED,
 * the row transitions to `LIVE_BLOCKED` with the exact primary failing reason.
 *
 * SAFETY:
 * - The Phase A `evaluateLiveDispatchGate` literal is still computed and
 *   attached to the audit snapshot (for grep/CI continuity).
 * - All 15 gates are re-checked at dispatch (TOCTOU guard): user-armed,
 *   kill-switch, bridge facts, settings, idempotency, master switch.
 * - When the server master switch is off, the legacy chokepoint sentinel
 *   `BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED` is appended to `blockReasons`.
 */
export async function dispatchLiveCommand(args: { userId: number; commandId: string }) {
  const row = await loadOwned(args.userId, args.commandId);
  if (!row) return { ok: false as const, reason: "COMMAND_NOT_FOUND" as const };
  if (row.status !== "LIVE_APPROVED") {
    // AACI Security Phase 3 — replay / double-dispatch protection. A dispatch on
    // a command that already left the APPROVED state (already SENT, terminal, or
    // blocked) is a replay attempt. Record a redacted security event + admin
    // alert (best-effort) and refuse with the unchanged BAD_STATE contract.
    void recordLiveCommandReplayAttempt({
      userId: args.userId,
      commandId: args.commandId,
      currentStatus: row.status,
    });
    return { ok: false as const, reason: "BAD_STATE" as const, currentStatus: row.status };
  }

  // ── COMMAND INTEGRITY PRE-GATE (AACI Security Phase 3) — OUTERMOST WALL ─
  // Verify the command's tamper/replay/expiry/source integrity BEFORE the
  // 16-gate Phase B evaluator. ADVISORY-ADDITIVE: a FAIL only ADDS a block; it
  // never weakens a downstream gate. Default-deny — a legacy/unstamped or
  // unverifiable command refuses here. On tamper, the verifier records a HIGH
  // security event + admin alert internally.
  {
    const verify = await verifyCommandIntegrityForDispatch(row);
    if (!verify.ok) {
      const reason = verify.verdict.reason;
      const [blocked] = await db.update(arxLiveCommandsTable).set({
        status: "LIVE_BLOCKED",
        rejectionReason: reason,
        rejectedAt: new Date(),
        integrityStatus: verify.verdict.tamper ? "TAMPERED" : (row.integrityStatus ?? "CREATED"),
        dispatchGateSnapshot: {
          decision: "BLOCKED",
          primaryReason: reason,
          blockReasons: [reason],
          phase: "COMMAND_INTEGRITY",
          tamper: verify.verdict.tamper,
          at: new Date().toISOString(),
        } as unknown as Record<string, unknown>,
      }).where(eq(arxLiveCommandsTable.commandId, args.commandId)).returning();
      await audit({
        eventType: "LIVE_DISPATCH_BLOCKED", severity: "HIGH",
        userId: args.userId, symbol: row.symbol,
        message: `Live dispatch BLOCKED by command integrity: ${reason}`,
        metadata: { commandId: args.commandId, reason, tamper: verify.verdict.tamper },
      });
      logger.warn({
        [PHASE_B_LIVE_LOG_PREFIX]: true,
        event: "LIVE_DISPATCH_BLOCKED_INTEGRITY",
        commandId: args.commandId, userId: args.userId,
        primaryReason: reason, tamper: verify.verdict.tamper,
      }, "Command integrity pre-gate blocked dispatch");
      return {
        ok: false as const,
        reason,
        command: blocked,
        userMessage: verify.verdict.userMessage,
      };
    }
  }

  // ── ALLOCATION FREEZE PRE-GATE (Phase ALLOC) — OUTERMOST WALL ──────────
  // Operator-controlled per-user trading freeze. Runs BEFORE the pilot
  // gate and the 16-gate evaluator: a frozen user must never even be
  // considered for pilot eligibility or live evaluation. Reads
  // user_slot_allocation and refuses dispatch when the user (or the
  // user's whole allocation) is frozen. Additive only — never replaces
  // or weakens any downstream gate. CLOSE_LIVE_POSITION and
  // MODIFY_LIVE_SLTP remain permitted when only `tradingFrozen` is set
  // so the operator can freeze new entries while still letting exposure
  // be closed cleanly. A full freeze (`allocationStatus='frozen'`)
  // blocks every command type including close/modify.
  {
    const { userSlotAllocationTable: _slotAllocTable } = await import("@workspace/db");
    const allocRows = await db.select({
      allocationStatus: _slotAllocTable.allocationStatus,
      tradingFrozen: _slotAllocTable.tradingFrozen,
    }).from(_slotAllocTable).where(eq(_slotAllocTable.userId, args.userId)).limit(1);
    const allocRow = allocRows[0];
    const isEntry = row.commandType === "PLACE_LIVE_MARKET_ORDER"
      || row.commandType === "PLACE_LIVE_PENDING_ORDER";
    const fullFrozen = allocRow?.allocationStatus === "frozen";
    const tradingFrozen = !!allocRow?.tradingFrozen;
    if (fullFrozen || (tradingFrozen && isEntry)) {
      const reason = fullFrozen ? "USER_ALLOCATION_FROZEN" : "USER_TRADING_FROZEN";
      const [blocked] = await db.update(arxLiveCommandsTable).set({
        status: "LIVE_BLOCKED",
        rejectionReason: reason,
        rejectedAt: new Date(),
        dispatchGateSnapshot: {
          decision: "BLOCKED",
          primaryReason: reason,
          blockReasons: [reason, "BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED"],
          allocationFreezeGate: true,
          at: new Date().toISOString(),
        } as unknown as Record<string, unknown>,
      }).where(eq(arxLiveCommandsTable.commandId, args.commandId)).returning();
      await audit({
        eventType: "ALLOCATION_FREEZE_BLOCKED", severity: "HIGH",
        userId: args.userId, symbol: row.symbol,
        message: `Live dispatch BLOCKED by allocation freeze: ${reason}`,
        metadata: { commandId: args.commandId, commandType: row.commandType },
      });
      logger.warn({
        [PHASE_B_LIVE_LOG_PREFIX]: true,
        event: "ALLOCATION_FREEZE_BLOCKED",
        commandId: args.commandId, userId: args.userId, primaryReason: reason,
      }, "Allocation freeze blocked live dispatch");
      return { ok: false as const, reason: "LIVE_BLOCKED" as const,
        primaryReason: reason, blockReasons: [reason], command: blocked };
    }
  }

  // ── OPERATOR-FUNDED PILOT GATE ─────────────────────────────────────────
  // Enforces: master pilot switch on + user in ARX_PRIVATE_BETA_10 +
  // beta invite accepted + compliance flag on + allocation > 0 +
  // operator-funded disclosure (versioned) accepted. PASS here only
  // ADDS to existing requirements; Phase B 16-gate still runs after.
  //
  // OWNER unrestricted bypass: this gate restricts *participants* in a
  // closed 10-user beta cohort. The OWNER on the Owner Unrestricted Live
  // template is the operator funding the pilot, not a participant in it,
  // and is intentionally not enrolled in the cohort / beta invites /
  // operator-funded disclosure version. Skipping the gate for that
  // identity mirrors the existing OWNER bypasses already applied to the
  // Phase B 16-gate (symbol allowlist, max-lot, daily-loss, SL, TP).
  // The Phase B 16-gate still runs after this and remains authoritative.
  const pilotBypassProfile = await getUserRiskProfile(args.userId);
  const pilotGate = pilotBypassProfile.isOwnerUnrestricted
    ? { decision: "PASS" as const, primaryReason: null, blockReasons: [] as never[], evaluatedAt: new Date().toISOString() }
    : await evaluateOperatorFundedPilotGate({ userId: args.userId });
  if (pilotGate.decision === "BLOCKED") {
    const reason = pilotGate.primaryReason ?? "OPERATOR_FUNDED_PILOT_DISABLED";
    const [blocked] = await db.update(arxLiveCommandsTable).set({
      status: "LIVE_BLOCKED",
      rejectionReason: reason,
      rejectedAt: new Date(),
      dispatchGateSnapshot: {
        decision: "BLOCKED",
        primaryReason: reason,
        blockReasons: [...pilotGate.blockReasons, "BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED"],
        operatorFundedPilotGate: true,
        at: pilotGate.evaluatedAt,
      } as unknown as Record<string, unknown>,
    }).where(eq(arxLiveCommandsTable.commandId, args.commandId)).returning();
    await audit({
      eventType: "OPERATOR_FUNDED_PILOT_BLOCKED", severity: "HIGH",
      userId: args.userId, symbol: row.symbol,
      message: `Operator-funded pilot dispatch BLOCKED: ${reason}`,
      metadata: { commandId: args.commandId, blockReasons: pilotGate.blockReasons },
    });
    logger.warn({
      [PHASE_B_LIVE_LOG_PREFIX]: true,
      event: "OPERATOR_FUNDED_PILOT_BLOCKED",
      commandId: args.commandId, userId: args.userId,
      primaryReason: reason, blockReasons: pilotGate.blockReasons,
    }, "Operator-funded pilot blocked");
    return { ok: false as const, reason: "LIVE_BLOCKED" as const, primaryReason: reason, blockReasons: pilotGate.blockReasons, command: blocked };
  }

  const arming = await getMyArming(args.userId);

  // Phase A gate still computed for the audit snapshot (CI literal continuity).
  const phaseAGate = evaluateLiveDispatchGate({
    userId: args.userId,
    userArmed: !!arming?.isArmed,
    killSwitchEngaged: !!arming?.killSwitchEngaged,
  });

  // Assemble Phase B inputs from live sources at this exact moment.
  const settings = await getOrCreateUserSettings(args.userId);
  const env = await getEnvelope(args.userId);

  // Phase 22V Part 3 — per-user TP requirement is sourced from
  // user_master_live_access (default true on approved-shared-bridge users).
  // Loaded here so the evaluator + audit snapshot stay consistent.
  const accessRowForTp = await db.select({
    requireTakeProfit: userMasterLiveAccessTable.requireTakeProfit,
    disclosureWaivedAt: userMasterLiveAccessTable.disclosureWaivedAt,
  }).from(userMasterLiveAccessTable)
    .where(eq(userMasterLiveAccessTable.userId, args.userId)).limit(1);
  const accessRequireTakeProfit = accessRowForTp[0]?.requireTakeProfit ?? true;
  // Honest operator disclosure waiver — owner/admin override recorded on the
  // access row. Fed as a DISTINCT gate input; we never claim the user accepted.
  const disclosureWaivedByOperator = accessRowForTp[0]?.disclosureWaivedAt != null;

  // ── OWNER UNRESTRICTED LIVE PROFILE (dispatch-time guard) ──────────────
  // Re-resolve here (TOCTOU guard: the profile may have been revoked
  // between draft and dispatch). When true: skip the per-user exposure
  // gate AND feed the 16-gate evaluator inputs that make the four
  // cap-driven gates (SYMBOL_NOT_ALLOWED, VOLUME_EXCEEDS_MAX_LIVE_LOT,
  // DAILY_LOSS_LIMIT_REACHED, MISSING_STOP_LOSS/MISSING_TAKE_PROFIT)
  // trivially pass. The remaining 12 gates run as-is. The evaluator
  // itself is unchanged (its 18/18 truth table still holds).
  const dispatchProfile = await getUserRiskProfile(args.userId);
  const isOwnerUnrestrictedDispatch = dispatchProfile.isOwnerUnrestricted;

  // T019 — effective governance at the dispatch layer (defense in depth). When
  // the owner re-enables a restriction in Admin Risk/Governance, the evaluator
  // inputs and exposure gate below honour it even though the owner is otherwise
  // unrestricted. Normal-user inputs are unchanged.
  const govDispatch = await getEffectiveTradingGovernance(args.userId, "LIVE_SHARED_BRIDGE");
  // T019 — unified governance decision: owner AND admin are privileged. When
  // Owner Live Control Mode is ON the app-added POLICY caps (allowed symbols,
  // per-trade lot, max-open exposure, daily loss, SL/TP) follow governance for
  // BOTH roles, so a plain admin's governance toggles are actually enforced
  // here (matching the read payloads/UI). The Deriv synthetic-floor relaxation
  // above stays OWNER-only. Normal-user inputs are unchanged.
  const useGovernanceDispatch = govDispatch.isPrivileged && govDispatch.ownerLiveControlMode;

  // Defense-in-depth: re-check the synthetic/data-only floor at dispatch
  // for entry orders. A symbol cannot become live-tradable between draft
  // and dispatch, but if the row was injected by any future path that
  // skipped preflight, this still refuses cleanly.
  const isEntryRow = row.commandType === "PLACE_LIVE_MARKET_ORDER"
    || row.commandType === "PLACE_LIVE_PENDING_ORDER";

  // Task #558 — ARX Focus market backstop (DISPATCH chokepoint, additive).
  // Mirrors the preflight refusal EXACTLY via the same `isApprovedArxMarket`
  // helper (lockstep — they can never drift). NEW-ENTRY ONLY: a close / modify /
  // cancel row is exempt because `isEntryRow` is false for it, so an existing
  // position on any symbol can always be managed even if a symbol later leaves
  // the approved universe. No broker send happens for an unapproved entry.
  if (isEntryRow && !isApprovedArxMarket(row.symbol)) {
    const reason = `SYMBOL_NOT_IN_ARX_FOCUS:${row.symbol}_not_approved`;
    const [blocked] = await db.update(arxLiveCommandsTable).set({
      status: "LIVE_BLOCKED",
      rejectionReason: reason,
      rejectedAt: new Date(),
      dispatchGateSnapshot: {
        decision: "BLOCKED",
        primaryReason: reason,
        blockReasons: [reason, "BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED"],
        arxFocusMarketLock: true,
        at: new Date().toISOString(),
      } as unknown as Record<string, unknown>,
    }).where(eq(arxLiveCommandsTable.commandId, args.commandId)).returning();
    return { ok: false as const, reason: "LIVE_BLOCKED" as const,
      primaryReason: reason, blockReasons: [reason], command: blocked };
  }

  // ── DATA-SUFFICIENCY TRUTH (Phase 2) — entry data-sufficiency gate (dispatch)
  // Mirrors the preflight gate EXACTLY via the SAME shared helper (lockstep,
  // defense-in-depth / TOCTOU re-check at dispatch). NEW-ENTRY only (isEntryRow,
  // so close / modify / cancel are exempt). Additive — runs before the synthetic
  // floor and the 18-gate evaluator, all of which still run and keep final say.
  // Fail-closed. Block construction mirrors the synthetic-floor block shape; the
  // audit metadata carries only status / timeframe / closed-count / freshness /
  // humanReason (no provider or admin detail).
  if (isEntryRow) {
    const sufficiency = await evaluateEntryDataSufficiency(row.symbol);
    if (sufficiency.shouldBlock) {
      const reason = `INSUFFICIENT_DATA_FOR_ENTRY:${row.symbol}_${sufficiency.status}`;
      const [blocked] = await db.update(arxLiveCommandsTable).set({
        status: "LIVE_BLOCKED",
        rejectionReason: reason,
        rejectedAt: new Date(),
        dispatchGateSnapshot: {
          decision: "BLOCKED",
          primaryReason: reason,
          blockReasons: [reason, "BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED"],
          dataSufficiency: {
            status: sufficiency.status,
            timeframe: sufficiency.timeframe,
            availableClosedCandles: sufficiency.availableClosedCandles,
            freshnessVerdict: sufficiency.freshnessVerdict,
            humanReason: sufficiency.humanReason,
          },
          at: new Date().toISOString(),
        } as unknown as Record<string, unknown>,
      }).where(eq(arxLiveCommandsTable.commandId, args.commandId)).returning();
      return { ok: false as const, reason: "LIVE_BLOCKED" as const,
        primaryReason: reason, blockReasons: [reason], command: blocked };
    }
  }

  if (isEntryRow) {
    const dispatchTradability = await getSymbolTradability(row.symbol, args.userId);
    const isSyntheticOrDataOnly = dispatchTradability.assetClass === "synthetic"
      || dispatchTradability.dataProvider === "deriv";
    if (isSyntheticOrDataOnly) {
      // Mirror the preflight relaxation EXACTLY: allow the owner/admin
      // unrestricted profile to dispatch a Deriv synthetic ONLY when the
      // connected master broker is Deriv AND broker truth does not block it.
      // Everyone else (and any non-Deriv broker) still hits the hard floor.
      // Real broker-side OrderSend validation remains the final authority.
      let brokerIsDeriv = false;
      let brokerTruthBlocks = false;
      // Phase 2 (Task #542) — mirror the preflight per-symbol live confirmation
      // EXACTLY at dispatch (defense-in-depth, lockstep) via the SAME shared
      // `evaluateSyntheticLiveFloor` contract. A stale/awaiting synthetic is
      // refused with the honest reason even here.
      let feedVerdict: SymbolFeedVerdict = "AWAITING";
      if (isOwnerUnrestrictedDispatch) {
        const masterConnId = await resolveActiveMasterConnectionId();
        if (masterConnId != null) {
          const mc = await db.select({ brokerName: mt5ConnectionTable.brokerName })
            .from(mt5ConnectionTable).where(eq(mt5ConnectionTable.id, masterConnId)).limit(1);
          brokerIsDeriv = /deriv/i.test(mc[0]?.brokerName ?? "");
        }
        const spec = await getBrokerSymbolSpec(args.userId, row.symbol);
        brokerTruthBlocks = spec.hasBrokerTruth && (
          spec.spec.tradeAllowed === false
          || spec.spec.visible === false
          || spec.spec.tradeMode === "DISABLED"
          || spec.spec.tradeMode === "CLOSEONLY"
        );
        feedVerdict = await resolveSymbolFeedVerdictForSymbol(row.symbol);
      }
      const verdict = evaluateSyntheticLiveFloor({
        isSyntheticOrDataOnly,
        isOwnerUnrestricted: isOwnerUnrestrictedDispatch,
        brokerIsDeriv,
        brokerTruthBlocks,
        feedVerdict,
      });
      if (verdict !== "ALLOWED" && verdict !== "NOT_ENGAGED") {
      const reason = verdict === "SYNTHETIC_FEED_NOT_LIVE_CONFIRMED"
        ? `SYNTHETIC_FEED_NOT_LIVE_CONFIRMED:${row.symbol}_${feedVerdict === "LIVE_DELAYED" ? "delayed_bar" : "no_live_tick"}`
        : `SYMBOL_NOT_LIVE_TRADABLE:${row.symbol}_is_${dispatchTradability.dataProvider}_data_only`;
      const [blocked] = await db.update(arxLiveCommandsTable).set({
        status: "LIVE_BLOCKED",
        rejectionReason: reason,
        rejectedAt: new Date(),
        dispatchGateSnapshot: {
          decision: "BLOCKED",
          primaryReason: reason,
          blockReasons: [reason, "BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED"],
          syntheticFloor: true,
          at: new Date().toISOString(),
        } as unknown as Record<string, unknown>,
      }).where(eq(arxLiveCommandsTable.commandId, args.commandId)).returning();
      return { ok: false as const, reason: "LIVE_BLOCKED" as const,
        primaryReason: reason, blockReasons: [reason], command: blocked };
      }
    }
  }

  // ── MASTER BRIDGE LIVE — routing-mode-aware bridge selection ───────────
  // When account_routing_mode=SHARED_MASTER_MT5, every live command MUST
  // bind to the platform_master_bridge_connection_id (the detector's
  // current connected real bridge). The master-live gate runs BEFORE the
  // existing Phase B 16-gate and short-circuits with a specific reason
  // (MASTER_LIVE_REQUIRES_REAL_BRIDGE / MASTER_BRIDGE_HEARTBEAT_STALE /
  // BRIDGE_BINDING_MISMATCH / etc.) so the operator sees the exact failing
  // bridge-binding rule. When PASS, we override the bridge selection
  // below with the bound bridge so pickupNextLiveCommand and
  // recordLiveCommandResult both validate against the same row.
  const gtsRows = await db.select().from(globalTradingSettingsTable).limit(1);
  const gts = gtsRows[0] ?? null;
  const routingMode = (gts?.accountRoutingMode as "USER_OWNED_MT5" | "SHARED_MASTER_MT5") ?? "USER_OWNED_MT5";
  let masterBoundBridgeId: number | null = null;
  if (routingMode === "SHARED_MASTER_MT5") {
    // ── PER-USER ACCESS GATE — admin must explicitly approve + toggle
    // ── this user before any master live command can be created. Runs
    // ── BEFORE the bridge gate so we never reveal bridge state to an
    // ── unapproved user.
    const userAccess = await loadAndEvaluateUserMasterLiveAccessGate(args.userId);
    if (userAccess.decision === "BLOCKED") {
      const reason = userAccess.primaryReason;
      const [blocked] = await db.update(arxLiveCommandsTable).set({
        status: "LIVE_BLOCKED",
        rejectionReason: reason,
        rejectedAt: new Date(),
        dispatchGateSnapshot: {
          decision: "BLOCKED",
          primaryReason: reason,
          blockReasons: userAccess.blockReasons,
          userMasterLiveAccessGate: true,
          userMasterLiveStatus: userAccess.status,
          routingMode,
          at: new Date().toISOString(),
        } as unknown as Record<string, unknown>,
      }).where(eq(arxLiveCommandsTable.commandId, args.commandId)).returning();
      await audit({
        eventType: "MASTER_LIVE_USER_ACCESS_BLOCKED", severity: "HIGH",
        userId: args.userId, symbol: row.symbol,
        message: `Master live user-access BLOCKED: ${reason}`,
        metadata: { commandId: args.commandId, blockReasons: userAccess.blockReasons, status: userAccess.status },
      });
      logger.warn({
        [PHASE_B_LIVE_LOG_PREFIX]: true,
        event: "MASTER_LIVE_USER_ACCESS_BLOCKED",
        commandId: args.commandId, userId: args.userId,
        primaryReason: reason, blockReasons: userAccess.blockReasons,
      }, "Master live user-access blocked");
      return { ok: false as const, reason: "LIVE_BLOCKED" as const, primaryReason: reason, blockReasons: userAccess.blockReasons, command: blocked };
    }
    const mlg = await loadAndEvaluateMasterLiveBridgeGate();
    if (mlg.decision === "BLOCKED") {
      const reason = mlg.primaryReason;
      const [blocked] = await db.update(arxLiveCommandsTable).set({
        status: "LIVE_BLOCKED",
        rejectionReason: reason,
        rejectedAt: new Date(),
        dispatchGateSnapshot: {
          decision: "BLOCKED",
          primaryReason: reason,
          blockReasons: mlg.blockReasons,
          masterLiveGate: true,
          routingMode,
          at: new Date().toISOString(),
        } as unknown as Record<string, unknown>,
      }).where(eq(arxLiveCommandsTable.commandId, args.commandId)).returning();
      await audit({
        eventType: "MASTER_LIVE_DISPATCH_BLOCKED", severity: "HIGH",
        userId: args.userId, symbol: row.symbol,
        message: `Master live dispatch BLOCKED: ${reason}`,
        metadata: { commandId: args.commandId, blockReasons: mlg.blockReasons },
      });
      logger.warn({
        [PHASE_B_LIVE_LOG_PREFIX]: true,
        event: "MASTER_LIVE_DISPATCH_BLOCKED",
        commandId: args.commandId, userId: args.userId,
        primaryReason: reason, blockReasons: mlg.blockReasons,
      }, "Master live dispatch blocked");
      return { ok: false as const, reason: "LIVE_BLOCKED" as const, primaryReason: reason, blockReasons: mlg.blockReasons, command: blocked };
    }
    masterBoundBridgeId = mlg.boundBridgeId;
  }

  // Active bridge — in SHARED_MASTER_MT5 mode this is the master-live
  // gate's bound bridge (the current connected real bridge). In
  // USER_OWNED_MT5 mode it is the freshest non-revoked LIVE-mode bridge
  // for THIS user. Fall back to whatever exists ONLY so downstream gates
  // can surface their specific failure reason instead of "no bridge".
  // The explicit MOCK short-circuit below refuses dispatch before the
  // evaluator runs, so a MOCK row cannot ever satisfy live readiness.
  const bridgePool = masterBoundBridgeId != null
    ? await db.select().from(mt5ConnectionTable).where(eq(mt5ConnectionTable.id, masterBoundBridgeId))
    : await db.select().from(mt5ConnectionTable).where(eq(mt5ConnectionTable.userId, args.userId));
  const nonRevoked = bridgePool.filter((b) => !b.tokenRevokedAt);
  const byFreshness = (a: typeof nonRevoked[number], b: typeof nonRevoked[number]) => {
    const ah = a.lastHeartbeat ? new Date(a.lastHeartbeat).getTime() : 0;
    const bh = b.lastHeartbeat ? new Date(b.lastHeartbeat).getTime() : 0;
    return bh - ah;
  };
  const liveModeBridges = nonRevoked.filter((b) => b.mode === "LIVE").sort(byFreshness);
  const bridge = liveModeBridges[0] ?? nonRevoked.sort(byFreshness)[0] ?? null;

  // Phase B MOCK short-circuit (TOCTOU guard layer). The Phase B evaluator
  // does NOT inspect bridge.mode (it is a pure function over the heartbeat
  // facts) — we enforce the "MOCK is never live-capable" rule here so a
  // MOCK placeholder row with accountType='live' cannot slip a real
  // broker dispatch through. Distinct reason for operator clarity.
  if (bridge && bridge.mode === "MOCK") {
    const mockBlockReasons = ["MOCK_BRIDGE_NOT_LIVE_CAPABLE", "BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED"] as const;
    const blocked = await db.update(arxLiveCommandsTable)
      .set({
        status: "LIVE_BLOCKED",
        rejectionReason: "MOCK_BRIDGE_NOT_LIVE_CAPABLE",
        dispatchGateSnapshot: {
          decision: "BLOCKED",
          primaryReason: "MOCK_BRIDGE_NOT_LIVE_CAPABLE",
          blockReasons: [...mockBlockReasons],
          bridgeId: bridge.id,
          bridgeMode: bridge.mode,
          shortCircuit: "pipeline_pre_evaluator_mock_refusal",
          at: new Date().toISOString(),
        },
        rejectedAt: new Date(),
        brokerMessage: `Bridge ${bridge.id} is a MOCK placeholder, not a real MT5 EA heartbeat. Attach EA v1.27 from your live MT5 terminal so a real heartbeat replaces the MOCK row.`,
      })
      .where(eq(arxLiveCommandsTable.commandId, args.commandId))
      .returning();
    await audit({
      eventType: "LIVE_BLOCKED", userId: args.userId, symbol: row.symbol,
      message: `Live dispatch refused: MOCK_BRIDGE_NOT_LIVE_CAPABLE (bridge id=${bridge.id})`,
    });
    return {
      ok: false as const,
      reason: "LIVE_BLOCKED" as const,
      primaryReason: "MOCK_BRIDGE_NOT_LIVE_CAPABLE" as const,
      blockReasons: mockBlockReasons,
      command: blocked[0],
    };
  }

  const hbAge = bridge?.lastHeartbeat
    ? Math.max(0, Math.floor((Date.now() - new Date(bridge.lastHeartbeat).getTime()) / 1000))
    : null;
  const caps = (bridge?.capabilities ?? {}) as { eaInputs?: Record<string, unknown> };
  const ea = (caps.eaInputs ?? {}) as Record<string, unknown>;

  // CLOSE_LIVE_POSITION and MODIFY_LIVE_SLTP must bypass entry-only gates
  // (symbol allowlist, per-symbol lot cap, stop-loss requirement). Blocking
  // an emergency close because the position's symbol left the allowlist —
  // or because its size exceeds the current per-symbol cap — would trap
  // real money in a losing trade. Authz, kill switch, master switch, EA
  // readiness, account-type, daily-loss gates still apply.
  const isOpsCommand = row.commandType === "CLOSE_LIVE_POSITION"
    || row.commandType === "MODIFY_LIVE_SLTP";

  const perMarketMap = (settings.maxLotPerMarket as Record<string, number>) ?? {};
  // T019 — owner allowed-symbol set is governance-driven. When the owner
  // enables a governance allowlist, the evaluator sees only those symbols;
  // otherwise the owner stays unrestricted ([row.symbol] = always-allowed).
  const ownerAllowed = useGovernanceDispatch
    && govDispatch.enforceSymbolAllowlist
    && govDispatch.allowedSymbols != null
      ? govDispatch.allowedSymbols
      : [row.symbol];
  const allowed = isOpsCommand || useGovernanceDispatch
    ? ownerAllowed
    : (((settings.allowedSymbols as string[]) ?? []).length > 0
        ? (settings.allowedSymbols as string[])
        : ARX_LIVE_DEFAULT_ALLOWED_SYMBOLS);
  // T019 — owner/admin per-trade lot cap is governance-driven (default ∞).
  const ownerMaxLot = useGovernanceDispatch && govDispatch.maxLotPerTrade != null
    ? govDispatch.maxLotPerTrade
    : Number.POSITIVE_INFINITY;
  const maxLotForSymbol = isOpsCommand || useGovernanceDispatch
    ? ownerMaxLot
    : (perMarketMap[row.symbol]
        ?? ARX_LIVE_DEFAULT_MAX_LOT_PER_MARKET[row.symbol]
        ?? 0.01);

  // Daily loss snapshot = unrealised negative floating P/L on currently
  // open positions  +  realised negative P/L on positions CLOSED since
  // start-of-day (UTC). Including the closed-today bucket prevents the
  // "close losers and re-trade past the cap" bypass: once a losing
  // position closes its floatingPl no longer counts as open, but its
  // realised loss still counts against today's limit.
  const startOfDayUtc = new Date(); startOfDayUtc.setUTCHours(0, 0, 0, 0);
  const openLossRows = await db.select({
    totalNegFloat: sql<number>`COALESCE(SUM(CASE WHEN ${arxLivePositionsTable.floatingPl} < 0 THEN ${arxLivePositionsTable.floatingPl} ELSE 0 END), 0)`,
  }).from(arxLivePositionsTable).where(and(
    eq(arxLivePositionsTable.userId, args.userId),
    isNull(arxLivePositionsTable.closedAt),
  ));
  const closedTodayLossRows = await db.select({
    totalNegRealised: sql<number>`COALESCE(SUM(CASE WHEN ${arxLivePositionsTable.floatingPl} < 0 THEN ${arxLivePositionsTable.floatingPl} ELSE 0 END), 0)`,
  }).from(arxLivePositionsTable).where(and(
    eq(arxLivePositionsTable.userId, args.userId),
    sql`${arxLivePositionsTable.closedAt} IS NOT NULL`,
    sql`${arxLivePositionsTable.closedAt} >= ${startOfDayUtc.toISOString()}`,
  ));
  const realisedDailyLossUsd =
    Math.abs(Number(openLossRows[0]?.totalNegFloat ?? 0)) +
    Math.abs(Number(closedTodayLossRows[0]?.totalNegRealised ?? 0));

  // ── PER-USER EXPOSURE GATES (run BEFORE the 16-gate Phase B evaluator) ─
  // Standardized audit codes emitted on block:
  //   MAX_OPEN_POSITIONS_REACHED        — concurrency cap exceeded
  //   MAX_EXPOSURE_PER_SYMBOL_REACHED   — per-symbol post-trade lots > cap
  // Both gates only apply to entry orders; CLOSE/MODIFY ops bypass to
  // avoid trapping money in a losing trade when an admin tightens caps.
  // T019 — owner runs this gate only when a governance max-open cap is set.
  const ownerMaxOpenGov = useGovernanceDispatch ? govDispatch.maxOpenPositions : null;
  if (!isOpsCommand && (!useGovernanceDispatch || ownerMaxOpenGov != null)) {
    const accessRows = await db.select({
      maxOpenPositions: userMasterLiveAccessTable.maxOpenPositions,
      maxExposurePerSymbolLots: userMasterLiveAccessTable.maxExposurePerSymbolLots,
    }).from(userMasterLiveAccessTable)
      .where(eq(userMasterLiveAccessTable.userId, args.userId)).limit(1);
    const userCaps = accessRows[0] ?? null;
    const userMaxOpen = useGovernanceDispatch ? ownerMaxOpenGov : (userCaps?.maxOpenPositions ?? null);
    const userMaxExposurePerSymbol = useGovernanceDispatch ? null : (userCaps?.maxExposurePerSymbolLots ?? null);

    if (userMaxOpen != null || userMaxExposurePerSymbol != null) {
      // Count both EA-reported open positions AND in-flight live commands
      // (SENT_TO_MT5_LIVE that haven't filled/rejected yet) so two parallel
      // dispatches cannot both pass the cap before either reaches the EA.
      // This closes the TOCTOU window between this check and the
      // SENT_TO_MT5_LIVE write below; the minute-bucket idempotency key on
      // arx_live_commands already prevents identical duplicates.
      const openPositions = await db.select({
        symbol: arxLivePositionsTable.symbol,
        volume: arxLivePositionsTable.volume,
      }).from(arxLivePositionsTable).where(and(
        eq(arxLivePositionsTable.userId, args.userId),
        isNull(arxLivePositionsTable.closedAt),
      ));
      const inFlight = await db.select({
        symbol: arxLiveCommandsTable.symbol,
        volume: arxLiveCommandsTable.requestedVolume,
      }).from(arxLiveCommandsTable).where(and(
        eq(arxLiveCommandsTable.userId, args.userId),
        eq(arxLiveCommandsTable.status, "SENT_TO_MT5_LIVE"),
        isNull(arxLiveCommandsTable.filledAt),
        isNull(arxLiveCommandsTable.rejectedAt),
      ));
      const openCount = openPositions.length + inFlight.length;
      const perSymbolLots =
        openPositions.filter((p) => p.symbol === row.symbol)
          .reduce((s, p) => s + Number(p.volume ?? 0), 0) +
        inFlight.filter((c) => c.symbol === row.symbol)
          .reduce((s, c) => s + Number(c.volume ?? 0), 0);

      const exposureFail = (reason: "MAX_OPEN_POSITIONS_REACHED" | "MAX_EXPOSURE_PER_SYMBOL_REACHED", detail: string) =>
        ({ reason, detail, openCount, perSymbolLots });

      let block: { reason: "MAX_OPEN_POSITIONS_REACHED" | "MAX_EXPOSURE_PER_SYMBOL_REACHED"; detail: string; openCount: number; perSymbolLots: number } | null = null;
      if (userMaxOpen != null && openCount >= userMaxOpen) {
        block = exposureFail("MAX_OPEN_POSITIONS_REACHED",
          `Open positions ${openCount} >= cap ${userMaxOpen}`);
      } else if (userMaxExposurePerSymbol != null
        && (perSymbolLots + Number(row.requestedVolume)) > userMaxExposurePerSymbol) {
        block = exposureFail("MAX_EXPOSURE_PER_SYMBOL_REACHED",
          `${row.symbol} post-trade exposure ${(perSymbolLots + Number(row.requestedVolume)).toFixed(2)} lots > cap ${userMaxExposurePerSymbol}`);
      }

      if (block) {
        const [blocked] = await db.update(arxLiveCommandsTable).set({
          status: "LIVE_BLOCKED",
          rejectionReason: block.reason,
          rejectedAt: new Date(),
          dispatchGateSnapshot: {
            decision: "BLOCKED",
            primaryReason: block.reason,
            blockReasons: [block.reason, "BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED"],
            perUserExposureGate: true,
            detail: block.detail,
            openCount: block.openCount,
            perSymbolLots: block.perSymbolLots,
            userMaxOpenPositions: userMaxOpen,
            userMaxExposurePerSymbolLots: userMaxExposurePerSymbol,
            at: new Date().toISOString(),
          } as unknown as Record<string, unknown>,
        }).where(eq(arxLiveCommandsTable.commandId, args.commandId)).returning();
        await audit({
          eventType: "LIVE_TRADE_BLOCKED_EXPOSURE_LIMIT", severity: "HIGH",
          userId: args.userId, symbol: row.symbol,
          message: `Live dispatch BLOCKED: ${block.reason} (${block.detail})`,
          metadata: {
            commandId: args.commandId,
            primaryReason: block.reason,
            blockReasons: [block.reason, "BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED"],
            openCount: block.openCount,
            perSymbolLots: block.perSymbolLots,
            userMaxOpenPositions: userMaxOpen,
            userMaxExposurePerSymbolLots: userMaxExposurePerSymbol,
          },
        });
        logger.warn({
          [PHASE_B_LIVE_LOG_PREFIX]: true,
          event: "LIVE_TRADE_BLOCKED_EXPOSURE_LIMIT",
          commandId: args.commandId, userId: args.userId,
          primaryReason: block.reason, detail: block.detail,
        }, "Per-user exposure gate blocked");
        return {
          ok: false as const,
          reason: "LIVE_BLOCKED" as const,
          primaryReason: block.reason,
          blockReasons: [block.reason, "BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED"],
          command: blocked,
        };
      }
    }
  }

  // ── Task #737 — live-execution activation gate, RE-checked at dispatch
  // (TOCTOU guard, lockstep with the preflight check above). Additive: this
  // runs BEFORE — and never in place of — the 18-gate evaluator below. A
  // trader whose Full Live Activation / personal confirmation was revoked
  // between draft and dispatch, or whose account was reclassified to a
  // bot/agent/system/investor, is blocked here with a true LIVE_BLOCKED row.
  const dispatchActivation = await evaluateLiveExecutionActivationGate(args.userId);
  if (!dispatchActivation.passed) {
    const reason = dispatchActivation.reason ?? "LIVE_EXECUTION_ACTIVATION_GATE";
    const [blocked] = await db.update(arxLiveCommandsTable).set({
      status: "LIVE_BLOCKED",
      rejectionReason: reason,
      rejectedAt: new Date(),
      dispatchGateSnapshot: {
        activationGate: {
          passed: false,
          reason,
          detail: dispatchActivation.detail,
          blockingReasonCode: dispatchActivation.state.blockingReasonCode,
        },
        bridgeConnectionId: bridge?.id ?? null,
        evaluatedAt: new Date().toISOString(),
      } as unknown as Record<string, unknown>,
    }).where(eq(arxLiveCommandsTable.commandId, args.commandId)).returning();
    await audit({
      eventType: "LIVE_DISPATCH_BLOCKED", severity: "HIGH",
      userId: args.userId, symbol: row.symbol,
      message: `Live dispatch BLOCKED: ${reason}`,
      metadata: { commandId: args.commandId, blockReasons: [reason], stage: "ACTIVATION_GATE" },
    });
    logger.warn({
      [PHASE_B_LIVE_LOG_PREFIX]: true,
      event: "LIVE_DISPATCH_BLOCKED",
      commandId: args.commandId, userId: args.userId,
      primaryReason: reason, blockReasons: [reason], stage: "ACTIVATION_GATE",
    }, "Phase B dispatch blocked at activation gate");
    return { ok: false as const, reason, command: blocked };
  }

  // Task #743 Cluster D — narrow kill-switch bypass for admin emergency CLOSE.
  // Honored ONLY when the draft was stamped with a killSwitchCloseBypass marker
  // (set exclusively by createLiveOpsDraft for an admin emergency close) AND the
  // command is a CLOSE (reduce-risk). It relaxes ONLY gate #5 (kill switch); the
  // full 18-gate evaluator otherwise runs unchanged, so any other failing gate
  // still BLOCKS. The marker is integrity-hashed at draft creation (verified by
  // the command-integrity pre-gate), so it cannot be forged post-hoc.
  const killSwitchBypassMarker =
    row.payload != null
    && typeof row.payload === "object"
    && (row.payload as { killSwitchCloseBypass?: unknown }).killSwitchCloseBypass != null
      ? (row.payload as { killSwitchCloseBypass: Record<string, unknown> }).killSwitchCloseBypass
      : null;
  const killSwitchBypassActive =
    killSwitchCloseBypassApplies({
      commandType: row.commandType,
      hasBypassMarker: killSwitchBypassMarker != null,
    })
    && !!arming?.killSwitchEngaged;
  if (killSwitchBypassActive) {
    // C-audit — distinct dispatch-time row recording that gate #5 was relaxed.
    await audit({
      eventType: "LIVE_EMERGENCY_CLOSE_KILL_SWITCH_BYPASS_DISPATCH",
      severity: "HIGH",
      userId: args.userId,
      symbol: row.symbol,
      message: `Kill-switch gate (#5) relaxed for admin emergency CLOSE at dispatch: ${args.commandId}`,
      metadata: {
        commandId: args.commandId,
        action: "CLOSE",
        brokerTicket: (row.payload as { brokerTicket?: string } | null)?.brokerTicket ?? null,
        killSwitchEngaged: true,
        bypass: killSwitchBypassMarker,
      },
    });
  }

  const phaseBGate: LivePhaseBGateResult = evaluateLivePhaseBDispatchGate({
    liveBrokerExecutionEnabled: await resolveLiveBrokerExecutionEnabledAsync(),
    globalLiveEnabled: !!env.globalLiveEnabled,
    userLiveApproved: !!env.userLiveApproved,
    userArmed: !!arming?.isArmed,
    // Effective kill-switch value: the real engaged state is suppressed ONLY
    // when the narrow CLOSE bypass is active; every other gate input is unchanged.
    killSwitchEngaged: effectiveKillSwitchEngaged(!!arming?.killSwitchEngaged, killSwitchBypassActive),
    bridgeAccountType: bridge?.accountType ?? null,
    bridgeHeartbeatAgeSec: hbAge,
    bridgeEaVersion: bridge?.eaVersion ?? null,
    bridgeEnableLiveExecution: typeof ea["enableLiveExecution"] === "boolean" ? (ea["enableLiveExecution"] as boolean) : null,
    bridgeReadOnlyMode: typeof ea["readOnlyMode"] === "boolean" ? (ea["readOnlyMode"] as boolean) : null,
    bridgeTerminalConnected: typeof ea["terminalConnected"] === "boolean" ? (ea["terminalConnected"] as boolean) : null,
    bridgeAlgoTradingAllowed: typeof ea["algoTradingAllowed"] === "boolean" ? (ea["algoTradingAllowed"] as boolean) : null,
    commandSymbol: row.symbol,
    commandVolume: Number(row.requestedVolume),
    commandHasStopLoss: row.stopLoss != null && Number(row.stopLoss) > 0,
    commandHasTakeProfit: row.takeProfit != null && Number(row.takeProfit) > 0,
    allowedSymbols: allowed,
    maxLotForSymbol,
    // T019 — owner/admin daily-loss cap is governance-driven (default 0 = no cap).
    dailyLossLimitUsd: useGovernanceDispatch
      ? Number(govDispatch.maxDailyLossUsd ?? 0)
      : Number(settings.dailyLossLimitUsd ?? 0),
    realisedDailyLossUsd,
    // T019 — owner/admin SL/TP requirements are governance-driven (default OFF).
    requireStopLoss: useGovernanceDispatch
      ? (govDispatch.requireStopLoss && !isOpsCommand)
      : (!!settings.requireStopLoss && !isOpsCommand),
    adminAllowNoStopLoss:
      (useGovernanceDispatch
        ? !govDispatch.requireStopLoss
        : !!settings.adminAllowNoStopLoss)
      || isOpsCommand
      || (row.payload != null
          && typeof row.payload === "object"
          && (row.payload as { allowNoStopLossThisDraft?: boolean }).allowNoStopLossThisDraft === true),
    // Phase 22V Part 3 — read per-user requireTakeProfit from the master-
    // live access row. CLOSE/MODIFY ops bypass via adminAllowNoTakeProfit.
    requireTakeProfit: useGovernanceDispatch
      ? (govDispatch.requireTakeProfit && !isOpsCommand)
      : (!!accessRequireTakeProfit && !isOpsCommand),
    adminAllowNoTakeProfit: isOpsCommand
      || (useGovernanceDispatch ? !govDispatch.requireTakeProfit : false),
    // Gap A — risk disclosure check (default-deny if no accepted row).
    disclosureAccepted: await hasUserAcceptedDisclosure(args.userId),
    // Honest owner/admin waiver of the disclosure requirement (distinct from
    // acceptance — recorded on user_master_live_access as an operator override).
    disclosureWaivedByOperator,
  });

  const snapshot = {
    phaseA: phaseAGate,
    phaseB: phaseBGate,
    bridgeConnectionId: bridge?.id ?? null,
    evaluatedAt: new Date().toISOString(),
  };

  if (phaseBGate.decision === "BLOCKED") {
    const reason = phaseBGate.primaryReason ?? "BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED";
    const [blocked] = await db.update(arxLiveCommandsTable).set({
      status: "LIVE_BLOCKED",
      rejectionReason: reason,
      rejectedAt: new Date(),
      dispatchGateSnapshot: snapshot as unknown as Record<string, unknown>,
    }).where(eq(arxLiveCommandsTable.commandId, args.commandId)).returning();
    await audit({
      eventType: "LIVE_DISPATCH_BLOCKED", severity: "HIGH",
      userId: args.userId, symbol: row.symbol,
      message: `Live dispatch BLOCKED: ${reason}`,
      metadata: { commandId: args.commandId, blockReasons: phaseBGate.blockReasons },
    });
    logger.warn({
      [PHASE_B_LIVE_LOG_PREFIX]: true,
      event: "LIVE_DISPATCH_BLOCKED",
      commandId: args.commandId, userId: args.userId,
      primaryReason: reason, blockReasons: phaseBGate.blockReasons,
      bridgeConnectionId: bridge?.id ?? null,
    }, "Phase B dispatch blocked");
    return { ok: false as const, reason, command: blocked, gate: phaseBGate };
  }

  // ── ATOMIC MASTER EXPOSURE RESERVATION (SHARED_MASTER_MT5 only) ────────
  // After all gates PASS but before the SENT_TO_MT5_LIVE transition, take
  // an advisory-locked reservation of `requestedVolume` lots against the
  // bound shared master account. Two parallel submissions cannot both
  // pass the cap-check; the loser surfaces
  // `MASTER_ACCOUNT_EXPOSURE_LIMIT_REACHED`. Released on any failure path.
  let reservationId: number | null = null;
  if (routingMode === "SHARED_MASTER_MT5" && bridge?.id) {
    const { sharedMasterAccountsTable } = await import("@workspace/db");
    const [sma] = await db.select({ id: sharedMasterAccountsTable.id })
      .from(sharedMasterAccountsTable)
      .where(eq(sharedMasterAccountsTable.connectionId, bridge.id))
      .limit(1);
    if (!sma?.id) {
      // FAIL CLOSED — SHARED_MASTER_MT5 routing requires a mapped
      // shared_master_accounts row; without it we cannot atomically
      // reserve exposure, so refusing is the only safe outcome.
      const reason = "MASTER_ACCOUNT_NOT_MAPPED" as const;
      const [blocked] = await db.update(arxLiveCommandsTable).set({
        status: "LIVE_BLOCKED",
        rejectionReason: reason,
        rejectedAt: new Date(),
        dispatchGateSnapshot: {
          decision: "BLOCKED",
          primaryReason: reason,
          blockReasons: [reason],
          routingMode,
          at: new Date().toISOString(),
        } as unknown as Record<string, unknown>,
      }).where(eq(arxLiveCommandsTable.commandId, args.commandId)).returning();
      await audit({
        eventType: "LIVE_DISPATCH_BLOCKED", severity: "HIGH",
        userId: args.userId, symbol: row.symbol,
        message: `SHARED_MASTER_MT5 dispatch refused: ${reason}`,
        metadata: { commandId: args.commandId, bridgeConnectionId: bridge.id },
      });
      return { ok: false as const, reason, command: blocked, gate: phaseBGate };
    }
    {
      const { reserveExposureAtomic } = await import("../concurrency/exposureReservation.js");
      const r = await reserveExposureAtomic({
        sharedMasterAccountId: sma.id,
        addingLot: Number(row.requestedVolume),
        userId: args.userId,
        commandId: args.commandId,
        symbol: row.symbol,
      });
      if (!r.ok) {
        const [blocked] = await db.update(arxLiveCommandsTable).set({
          status: "LIVE_BLOCKED",
          rejectionReason: r.reason,
          rejectedAt: new Date(),
          dispatchGateSnapshot: {
            decision: "BLOCKED",
            primaryReason: r.reason,
            blockReasons: [r.reason],
            currentOpenLots: r.currentOpenLots,
            reservedLots: r.reservedLots,
            cap: r.cap,
            routingMode,
            at: new Date().toISOString(),
          } as unknown as Record<string, unknown>,
        }).where(eq(arxLiveCommandsTable.commandId, args.commandId)).returning();
        await audit({
          eventType: "LIVE_DISPATCH_BLOCKED", severity: "HIGH",
          userId: args.userId, symbol: row.symbol,
          message: `Master exposure reservation refused: ${r.reason}`,
          metadata: { commandId: args.commandId, currentOpenLots: r.currentOpenLots, reservedLots: r.reservedLots, cap: r.cap },
        });
        return { ok: false as const, reason: r.reason, command: blocked, gate: phaseBGate };
      }
      reservationId = r.reservationId;
    }
  }

  // PASS path — transition to SENT_TO_MT5_LIVE atomically. Idempotency key
  // is enforced by the DB partial unique index `arx_live_commands_idem_active_uq`.
  const idemKey = buildLiveIdempotencyKey({
    userId: args.userId,
    symbol: row.symbol,
    side: row.side as "BUY" | "SELL",
    volume: Number(row.requestedVolume),
    stopLoss: row.stopLoss != null ? Number(row.stopLoss) : null,
    takeProfit: row.takeProfit != null ? Number(row.takeProfit) : null,
  });
  // Task #28 — stamp TTL + authoritative server clock at the moment of
  // dispatch. A command not executed by the EA before `expiresAt` is swept
  // to LIVE_EXPIRED and the EA itself refuses it as stale. This is the
  // single source of "freshness" for the live command.
  const dispatchNow = new Date();
  const expiresAt = computeLiveExpiry(dispatchNow, LIVE_COMMAND_TTL_SECONDS);
  try {
    // ── P0-1 — DOUBLE-SEND CAS (money) ──────────────────────────────────────
    // Everything above is a READ-then-evaluate: `loadOwned` read the row,
    // saw LIVE_APPROVED, and all 18 gates then passed. Every one of those
    // gates is a property of the user / bridge / symbol — NONE of them asks
    // "has this command already been sent". So two concurrent dispatches of
    // the same approved command both reach this line.
    //
    // Matching on commandId ALONE here made both succeed, and each caller
    // then mirrored an order into the mt5_commands mailbox the EA polls —
    // the broker executed the same trade TWICE, with no error surfaced.
    // The arx_live_commands_idem_active_uq index cannot catch it: that
    // constrains INSERTs of distinct rows, and this UPDATEs one row twice.
    //
    // The status predicate is the fix. Of N concurrent statements exactly
    // one matches a LIVE_APPROVED row; the rest match zero and get null.
    const sent = await claimLiveCommandForDispatch(args.commandId, {
      status: "SENT_TO_MT5_LIVE",
      sentToMt5At: dispatchNow,
      serverTimestamp: dispatchNow,
      ttlSeconds: LIVE_COMMAND_TTL_SECONDS,
      expiresAt,
      idempotencyKey: idemKey,
      bridgeConnectionId: bridge!.id,
      accountLogin: bridge!.accountNumber,
      brokerServer: bridge!.brokerName,
      dispatchGateSnapshot: snapshot as unknown as Record<string, unknown>,
    });
    if (!sent) {
      // LOST THE RACE. A concurrent dispatcher already claimed this command.
      // Refuse fail-CLOSED: return BEFORE the EA mailbox mirror below so this
      // caller cannot put a second order in front of the broker. Release the
      // exposure reservation we took, or the master account stays attributed
      // lots for an order this caller never sent.
      if (reservationId != null) {
        try {
          const { releaseReservation } = await import("../concurrency/exposureReservation.js");
          await releaseReservation(reservationId);
        } catch { /* audit-only failure */ }
      }
      const [current] = await db.select({ status: arxLiveCommandsTable.status })
        .from(arxLiveCommandsTable)
        .where(eq(arxLiveCommandsTable.commandId, args.commandId)).limit(1);
      await audit({
        eventType: "LIVE_DISPATCH_BLOCKED", severity: "HIGH",
        userId: args.userId, symbol: row.symbol,
        message: `Live dispatch refused — concurrent dispatch already claimed the command: ${args.commandId}`,
        metadata: { commandId: args.commandId, currentStatus: current?.status ?? null, reason: LIVE_DISPATCH_RACE_LOST },
      });
      logger.warn({
        [PHASE_B_LIVE_LOG_PREFIX]: true,
        event: "LIVE_DISPATCH_RACE_LOST",
        commandId: args.commandId, userId: args.userId,
        currentStatus: current?.status ?? null,
      }, "Phase B dispatch lost the CAS race — no EA order mirrored (double-send prevented)");
      return {
        ok: false as const,
        reason: LIVE_DISPATCH_RACE_LOST,
        currentStatus: (current?.status ?? null) as ArxLiveCommandStatus | null,
        command: null,
        gate: phaseBGate,
      };
    }
    await audit({
      eventType: "LIVE_DISPATCH_SENT", severity: "CRITICAL",
      userId: args.userId, symbol: row.symbol,
      message: `Live dispatch SENT_TO_MT5_LIVE: ${args.commandId} (bridge ${bridge!.id})`,
      metadata: { commandId: args.commandId, bridgeConnectionId: bridge!.id, idempotencyKey: idemKey, requestedVolume: Number(row.requestedVolume) },
    });
    // Tamper-evident mirror — best-effort, never throws (cannot affect dispatch).
    await mirrorCriticalEvent({
      eventType: "LIVE_TRADE_COMMAND", severity: "CRITICAL", status: "ATTEMPTED",
      actorUserId: args.userId, actorType: "USER",
      affectedObject: `arx_live_commands:${args.commandId}`,
      message: `Live trade command dispatched: ${row.commandType} ${row.symbol} ${row.side}`,
      metadata: { commandId: args.commandId, symbol: row.symbol, side: row.side, commandType: row.commandType, idempotencyKey: idemKey },
    });
    logger.warn({
      [PHASE_B_LIVE_LOG_PREFIX]: true,
      event: "LIVE_DISPATCH_SENT",
      commandId: args.commandId, userId: args.userId,
      bridgeConnectionId: bridge!.id,
      symbol: row.symbol, side: row.side, volume: Number(row.requestedVolume),
      idempotencyKey: idemKey,
    }, "Phase B dispatch SENT_TO_MT5_LIVE — awaiting EA pickup");

    // ── ARX live transport bridge ───────────────────────────────────────────
    // Mirror the live command into the legacy mt5_commands mailbox that the
    // v1.50 EA actually polls. If this mirror fails the command would sit
    // unclaimed until its TTL elapsed (silent dead order), so fail it CLOSED
    // instead and release any exposure reservation.
    try {
      const { mt5CommandId, action: eaAction } = await enqueueBridgedMt5Command({
        liveRow: sent,
        bridgeUserId: bridge!.userId!,
        bridgeConnectionId: bridge!.id,
      });
      logger.warn({
        [PHASE_B_LIVE_LOG_PREFIX]: true,
        event: "LIVE_BRIDGE_ENQUEUED",
        commandId: args.commandId, mt5CommandId, eaAction,
        bridgeConnectionId: bridge!.id,
      }, "Phase B live command mirrored into mt5_commands for v1.50 EA pickup");
    } catch (bridgeErr: unknown) {
      const msg = bridgeErr instanceof Error ? bridgeErr.message : String(bridgeErr);
      const reason = msg.startsWith("UNMAPPED_LIVE_COMMAND_TYPE")
        ? "BRIDGE_UNMAPPED_COMMAND_TYPE"
        : "BRIDGE_ENQUEUE_FAILED";
      const [failed] = await db.update(arxLiveCommandsTable).set({
        status: "LIVE_FAILED",
        rejectionReason: reason,
        brokerMessage: msg.slice(0, 400),
        rejectedAt: new Date(),
      }).where(eq(arxLiveCommandsTable.commandId, args.commandId)).returning();
      if (reservationId != null) {
        try {
          const { releaseReservation } = await import("../concurrency/exposureReservation.js");
          await releaseReservation(reservationId);
        } catch { /* audit-only failure */ }
      }
      await audit({
        eventType: "LIVE_DISPATCH_BLOCKED", severity: "HIGH",
        userId: args.userId, symbol: row.symbol,
        message: `Live bridge enqueue failed: ${reason}`,
        metadata: { commandId: args.commandId, bridgeConnectionId: bridge!.id, error: msg },
      });
      logger.error({
        [PHASE_B_LIVE_LOG_PREFIX]: true,
        event: "LIVE_BRIDGE_ENQUEUE_FAILED",
        commandId: args.commandId, reason, error: msg,
      }, "Phase B live bridge enqueue failed — command failed closed");
      // Task #403 — a CLOSE/MODIFY that fails because its broker position
      // ticket was missing/zero means the position the user expected to close
      // is STILL OPEN and exposed. The audit + LIVE_FAILED row alone are
      // invisible to the trader, so surface a deduped, actionable alert to the
      // owning user through the existing alert/notification path. Dedupe by the
      // still-open position ticket (falling back to the commandId) so repeated
      // close attempts on the same position collapse into one notification
      // instead of spamming. Best-effort: never let alerting affect dispatch.
      if (msg.startsWith("LIVE_BRIDGE_CLOSE_TICKET_MISSING")) {
        try {
          const ticketForDedupe =
            (typeof row.brokerTicket === "string" && row.brokerTicket.trim() !== ""
              ? row.brokerTicket.trim()
              : null)
            ?? (typeof (row.payload as Record<string, unknown> | null)?.["brokerTicket"] === "string"
              ? String((row.payload as Record<string, unknown>)["brokerTicket"])
              : null)
            ?? args.commandId;
          await upsertAlertOnce(args.userId, {
            alertType: `live_close_failed_ticket_missing:${ticketForDedupe}`,
            severity: "critical",
            title: "Close did not execute — position still open",
            message:
              `Your ${row.commandType === "MODIFY_LIVE_SLTP" ? "stop-loss/take-profit change" : "close"} ` +
              `for ${row.symbol} could not be sent to the broker because its position ticket was missing. ` +
              `The position is still OPEN and exposed — review it and close it manually if needed.`,
            source: "system",
            actionLabel: "Review open positions",
            actionTarget: "/mt5-setup",
          });
        } catch (alertErr) {
          logger.warn({
            [PHASE_B_LIVE_LOG_PREFIX]: true,
            event: "LIVE_CLOSE_FAILED_ALERT_FAILED",
            commandId: args.commandId, err: alertErr,
          }, "Phase B close-failed alert could not be raised (non-fatal)");
        }
      }
      return { ok: false as const, reason, command: failed, gate: phaseBGate };
    }

    // ── GOVERNANCE BYPASS PROOF (advisory-only, fail-soft) ────────────────
    // The agent governance layer is NEVER consulted on the live dispatch path;
    // the Phase B 16-gate evaluator above is the sole authority. Write a durable
    // proof row (empty agent sets, liveExecutionBlockedByAi=false) showing
    // governance did not — and cannot — block this live submit/close. Never
    // awaited: it must not add latency to, or fail, the live path.
    {
      const isClose = row.commandType === "CLOSE_LIVE_POSITION";
      void persistLiveBypassTrace({
        actionType: isClose ? "LIVE_CLOSE_DISPATCH" : "LIVE_SUBMIT_DISPATCH",
        userId: args.userId,
        symbol: row.symbol,
        tradeId: args.commandId,
      });
    }

    return { ok: true as const, command: sent, gate: phaseBGate, idempotencyKey: idemKey };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    const isDup = /arx_live_commands_idem_active_uq|duplicate key/.test(msg);
    const reason = isDup ? "DUPLICATE_LIVE_IDEMPOTENCY_KEY" : "DB_INSERT_FAILED";
    // AACI Security Phase 3 — a duplicate-idempotency collision is a replayed /
    // double-submitted command. Record a redacted security event + admin alert
    // (best-effort) so duplicate live dispatch is observable.
    if (isDup) {
      void recordLiveCommandDuplicateBlocked({ userId: args.userId, commandId: args.commandId });
    }
    // Release the reservation we just took — the live command did not
    // make it to SENT_TO_MT5_LIVE so the master account should not be
    // attributed those lots.
    if (reservationId != null) {
      try {
        const { releaseReservation } = await import("../concurrency/exposureReservation.js");
        await releaseReservation(reservationId);
      } catch { /* audit-only failure */ }
    }
    const [blocked] = await db.update(arxLiveCommandsTable).set({
      status: "LIVE_BLOCKED",
      rejectionReason: reason,
      rejectedAt: new Date(),
      dispatchGateSnapshot: { ...snapshot, dbError: msg } as unknown as Record<string, unknown>,
    }).where(eq(arxLiveCommandsTable.commandId, args.commandId)).returning();
    await audit({
      eventType: "LIVE_DISPATCH_BLOCKED", severity: "HIGH",
      userId: args.userId, symbol: row.symbol,
      message: `Live dispatch BLOCKED at DB writeback: ${reason}`,
      metadata: { commandId: args.commandId, dbError: msg },
    });
    return {
      ok: false as const,
      reason,
      command: blocked,
      gate: phaseBGate,
      ...(isDup ? { userMessage: DUPLICATE_LIVE_COMMAND_USER_MESSAGE } : {}),
    };
  }
}

/**
 * Task #28 — sweep expired live commands to LIVE_EXPIRED.
 *
 * A SENT_TO_MT5_LIVE command whose `expiresAt` is in the past is considered
 * stale: the EA either never polled it or stalled. We move it to the terminal
 * LIVE_EXPIRED state (never re-served, never retried) and release any master
 * exposure reservation it held. Scoped to a single user when `userId` is
 * given (the natural choke point is the EA poll); call with no userId for a
 * global sweep. Returns the number of commands expired.
 */
export async function sweepExpiredLiveCommands(args?: { userId?: number }): Promise<{ expired: number; commandIds: string[] }> {
  const now = new Date();
  const where = args?.userId != null
    ? and(
        eq(arxLiveCommandsTable.userId, args.userId),
        eq(arxLiveCommandsTable.status, "SENT_TO_MT5_LIVE"),
        sql`${arxLiveCommandsTable.expiresAt} is not null and ${arxLiveCommandsTable.expiresAt} < ${now}`,
      )
    : and(
        eq(arxLiveCommandsTable.status, "SENT_TO_MT5_LIVE"),
        sql`${arxLiveCommandsTable.expiresAt} is not null and ${arxLiveCommandsTable.expiresAt} < ${now}`,
      );
  // CAS update guarded by status so a concurrent EA result/pickup cannot
  // race the sweep — only rows still SENT_TO_MT5_LIVE are expired.
  const expired = await db.update(arxLiveCommandsTable).set({
    status: "LIVE_EXPIRED",
    expiredAt: now,
    rejectedAt: now,
    rejectionReason: "LIVE_COMMAND_TTL_EXPIRED",
  }).where(where).returning();

  for (const cmd of expired) {
    // Release any reservation tied to this command (no-op if absent).
    try {
      const { releaseReservationByCommandId } =
        await import("../concurrency/exposureReservation.js");
      await releaseReservationByCommandId(cmd.commandId);
    } catch { /* audit-only failure */ }
    await audit({
      eventType: "LIVE_COMMAND_TTL_EXPIRED", severity: "HIGH",
      userId: cmd.userId, symbol: cmd.symbol,
      message: `Live command expired before EA execution: ${cmd.commandId} (ttl=${cmd.ttlSeconds ?? "?"}s)`,
      metadata: { commandId: cmd.commandId, sentToMt5At: cmd.sentToMt5At, expiresAt: cmd.expiresAt },
    });
    logger.warn({
      [PHASE_B_LIVE_LOG_PREFIX]: true,
      event: "LIVE_COMMAND_TTL_EXPIRED",
      commandId: cmd.commandId, userId: cmd.userId,
    }, "Phase B live command swept to LIVE_EXPIRED (TTL)");
  }
  return { expired: expired.length, commandIds: expired.map((c) => c.commandId) };
}

/** Phase B — EA picks up the next SENT_TO_MT5_LIVE command for this bridge. */
export async function pickupNextLiveCommand(args: {
  userId: number;
  bridgeConnectionId: number;
  bridgeAccountType: string | null;
}): Promise<{ command: ArxLiveCommand | null; refusalReason: string | null }> {
  // Re-validate accountType=LIVE at pickup.
  const acct = (args.bridgeAccountType ?? "").toLowerCase();
  if (acct !== "live" && acct !== "real") {
    return { command: null, refusalReason: "BRIDGE_NOT_LIVE_ACCOUNT" };
  }

  // Task #28 — expire stale commands for this user BEFORE serving the next
  // one. Guarantees the EA can never be handed a command whose TTL already
  // elapsed during a network stall.
  await sweepExpiredLiveCommands({ userId: args.userId });

  // Atomic single-consumer claim. We RETURNING the row that was
  // transitioned in a single SQL update so two concurrent polls (or a
  // replayed poll) cannot both receive the same command. The claim
  // requires `pickedByEaAt IS NULL` so a previously-served command is
  // never re-served.
  //
  // We select the candidate commandId first (oldest unpicked
  // SENT_TO_MT5_LIVE for this user), then CAS-update it with both the
  // status and the NULL pickedByEaAt guard. The update returns 0 rows
  // if another poll won the race — we then return "no command" so the
  // EA simply tries again next poll.
  // Bridge-binding invariant: a command dispatched and stamped with
  // bridgeConnectionId=B may ONLY be picked up by bridge B. Any other
  // live bridge for the same user polling /live-commands-poll receives
  // "no command" — never another bridge's payload. This closes the
  // cross-bridge account-mix-up risk where user U has two live MT5
  // bridges (e.g. two terminals on the same login) and the wrong one
  // races to claim the command.
  const candidates = await db.select({ commandId: arxLiveCommandsTable.commandId })
    .from(arxLiveCommandsTable)
    .where(and(
      eq(arxLiveCommandsTable.userId, args.userId),
      eq(arxLiveCommandsTable.status, "SENT_TO_MT5_LIVE"),
      isNull(arxLiveCommandsTable.pickedByEaAt),
      eq(arxLiveCommandsTable.bridgeConnectionId, args.bridgeConnectionId),
    ))
    .orderBy(arxLiveCommandsTable.id)
    .limit(1);
  const cand = candidates[0];
  if (!cand) return { command: null, refusalReason: null };

  // Atomic CAS claim — re-asserts the same bridge binding so a concurrent
  // poll from a different bridge cannot win the race. We do NOT rewrite
  // bridgeConnectionId on claim (would defeat the binding); we only stamp
  // pickedByEaAt to mark the row as served exactly once.
  const claimed = await db.update(arxLiveCommandsTable).set({
    pickedByEaAt: new Date(),
  }).where(and(
    eq(arxLiveCommandsTable.commandId, cand.commandId),
    eq(arxLiveCommandsTable.status, "SENT_TO_MT5_LIVE"),
    isNull(arxLiveCommandsTable.pickedByEaAt),
    eq(arxLiveCommandsTable.bridgeConnectionId, args.bridgeConnectionId),
  )).returning();
  const updated = claimed[0];
  if (!updated) return { command: null, refusalReason: null };
  const row = updated;

  logger.warn({
    [PHASE_B_LIVE_LOG_PREFIX]: true,
    event: "LIVE_COMMAND_PICKED_BY_EA",
    commandId: row.commandId, userId: args.userId,
    bridgeConnectionId: args.bridgeConnectionId,
  }, "Phase B live command picked up by EA");

  return { command: updated, refusalReason: null };
}

/** Phase B — EA posts result for a SENT_TO_MT5_LIVE command. */
// ──────────────────────────────────────────────────────────────────────────
// ARX live transport bridge.
//
// The v1.50 "Universal Agent" EA polls ONLY the legacy command mailbox
// (GET /api/mt5/commands → mt5_commands). It does NOT poll Phase B's own
// /api/mt5/live-commands-poll consumer (the sole reader of arx_live_commands).
// Without a bridge, a fully-approved live command sits in SENT_TO_MT5_LIVE
// unclaimed until its TTL elapses. This mirror writes the SAME command into
// mt5_commands so the EA picks it up. The authoritative lifecycle record stays
// arx_live_commands; the mt5_commands row is pure transport. The EA result is
// forwarded back into arx_live_commands by the bridge branch in
// POST /api/mt5/command-result (which calls recordLiveCommandResult).
//
// No safety surface is weakened: all 16 gates + per-user typed-phrase
// confirmation already ran in dispatchLiveCommand BEFORE this mirror is
// written, the EA still enforces its own ARM (ReadOnlyMode / AllowOrderExecution)
// and broker preflight, and recordLiveCommandResult still applies the
// bridge-binding + exactly-once CAS guards.
const LIVE_COMMAND_TYPE_TO_EA_ACTION: Record<string, string> = {
  PLACE_LIVE_MARKET_ORDER: "OPEN_MARKET",
  PLACE_LIVE_PENDING_ORDER: "PLACE_PENDING",
  CLOSE_LIVE_POSITION: "CLOSE_POSITION",
  MODIFY_LIVE_SLTP: "MODIFY_POSITION",
};

// Live command types that act on an EXISTING broker position and therefore MUST
// carry a real, non-zero broker position ticket when mirrored into mt5_commands.
// A CLOSE/MODIFY sent with positionTicket 0 (or missing) is the silent-close
// bug: the broker reports retcode 10009 ("executed") but closes NOTHING, so the
// user believes the position is closed while it stays open and exposed.
const POSITION_TARGETED_LIVE_COMMAND_TYPES = new Set<string>([
  "CLOSE_LIVE_POSITION",
  "MODIFY_LIVE_SLTP",
]);

/**
 * Resolve the broker position ticket for a bridged live command from BOTH
 * sources, exactly as the EA needs it:
 *   - a PLACE order gets `brokerTicket` stamped on the COLUMN only after it
 *     fills, but createLiveOpsDraft (CLOSE/MODIFY) carries the target ticket in
 *     `payload.brokerTicket` and leaves the column null. Reading only the column
 *     sent the EA `positionTicket=0` → POSITION_NOT_FOUND and the position
 *     stayed open. This dual-source read mirrors the close-fill detection.
 *
 * GUARD: for a position-targeted command (CLOSE/MODIFY) a missing / empty /
 * zero ticket is FATAL — it throws rather than letting a no-op close be mirrored
 * to the bridge. Entry orders (OPEN/PENDING) legitimately have no position
 * ticket yet and return null.
 */
export function resolveBridgedPositionTicket(input: {
  commandType: string;
  brokerTicketColumn: string | null | undefined;
  payload: Record<string, unknown> | null | undefined;
}): string | null {
  const fromPayload =
    typeof input.payload?.["brokerTicket"] === "string"
      ? String(input.payload["brokerTicket"])
      : null;
  const resolved = input.brokerTicketColumn ?? fromPayload;
  if (POSITION_TARGETED_LIVE_COMMAND_TYPES.has(input.commandType)) {
    const trimmed = resolved == null ? "" : String(resolved).trim();
    if (trimmed === "" || Number(trimmed) === 0) {
      throw new Error(`LIVE_BRIDGE_CLOSE_TICKET_MISSING:${input.commandType}`);
    }
    return trimmed;
  }
  return resolved == null ? null : String(resolved);
}

/**
 * Build the `payload` extras object written into the mt5_commands mirror row.
 * Extracted as a pure function so the silent-close-failure guard around
 * `positionTicket` is regression-tested without a DB. The v1.50 EA reads these
 * at the TOP LEVEL of the command JSON (the GET /api/mt5/commands serializer
 * lifts them from `payload` onto the wire object):
 *   • confirmedByUser — the EA refuses ANY entry action whose slice lacks
 *     `confirmedByUser=="true"`. The server already required the typed-phrase
 *     confirmation + all 16 gates, so emitting true here faithfully represents
 *     that confirmation; it does not create one.
 *   • positionTicket — the broker position ticket for CLOSE/MODIFY. Kept in
 *     payload because real broker tickets overflow the 32-bit `ticket` column.
 */
export function buildBridgedMt5CommandPayload(liveRow: {
  commandId: string;
  userId: number;
  commandType: string;
  brokerTicket: string | null;
  payload: Record<string, unknown> | null;
}): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    bridged: "LIVE_PHASE_B",
    liveCommandId: liveRow.commandId,
    liveCommandOwnerUserId: liveRow.userId,
    liveCommandType: liveRow.commandType,
    confirmedByUser: true,
  };
  const positionTicket = resolveBridgedPositionTicket({
    commandType: liveRow.commandType,
    brokerTicketColumn: liveRow.brokerTicket,
    payload: liveRow.payload,
  });
  if (positionTicket) payload.positionTicket = positionTicket;
  return payload;
}

async function enqueueBridgedMt5Command(opts: {
  liveRow: ArxLiveCommand;
  bridgeUserId: number;
  bridgeConnectionId: number;
}): Promise<{ mt5CommandId: number; action: string }> {
  const action = LIVE_COMMAND_TYPE_TO_EA_ACTION[opts.liveRow.commandType];
  if (!action) throw new Error(`UNMAPPED_LIVE_COMMAND_TYPE:${opts.liveRow.commandType}`);

  const { mt5CommandsTable } = await import("@workspace/db");
  const { resolveBrokerSymbolName } = await import("../mt5/brokerSymbolName.js");
  // Resolve to the broker's exact (case-sensitive) Market Watch symbol, same
  // as the live-poll path does, so the EA preflight resolves it cleanly.
  const brokerSymbol = await resolveBrokerSymbolName(opts.liveRow.symbol);

  // Build the mirror payload (incl. the silent-close-failure guard around
  // `positionTicket`) via the pure, regression-tested helper.
  const payload = buildBridgedMt5CommandPayload({
    commandId: opts.liveRow.commandId,
    userId: opts.liveRow.userId,
    commandType: opts.liveRow.commandType,
    brokerTicket: opts.liveRow.brokerTicket,
    payload: opts.liveRow.payload as Record<string, unknown> | null,
  });

  const [ins] = await db.insert(mt5CommandsTable).values({
    userId: opts.bridgeUserId,                 // EA authenticates as the bridge owner
    mt5ConnectionId: opts.bridgeConnectionId,  // GET /commands scopes on (userId, connectionId)
    requestedByUserId: opts.liveRow.userId,    // the trader who owns the live command
    action,
    symbol: brokerSymbol,
    side: opts.liveRow.side,
    lot: Number(opts.liveRow.requestedVolume),
    sl: opts.liveRow.stopLoss != null ? Number(opts.liveRow.stopLoss) : null,
    tp: opts.liveRow.takeProfit != null ? Number(opts.liveRow.takeProfit) : null,
    payload,
    status: "PENDING",
    detail: `ARX live bridge ${opts.liveRow.commandType}->${action} (live cmd ${opts.liveRow.commandId})`,
  }).returning({ id: mt5CommandsTable.id });

  return { mt5CommandId: ins!.id, action };
}

export type BridgedLiveOutcome =
  | "LIVE_FILLED"
  | "LIVE_REJECTED"
  | "LIVE_FAILED"
  | "STALE_COMMAND_REJECTED";

const LIVE_FAILED_STATUS_RE = /fail|error|reject/i;

/**
 * Pure, honest mapping of an EA/broker terminal result into a Phase B outcome.
 *
 * HONESTY RULE (see memory dispatch-vs-execution-honesty): a `LIVE_FILLED`
 * outcome is only ever returned when a confirmed broker ticket is present. A
 * "success"-looking status with NO broker ticket is NOT proof of a fill, so it
 * collapses to `LIVE_FAILED` — this prevents fabricating a fill and, critically,
 * prevents wrongly FULFILLING an exposure reservation (recordLiveCommandResult
 * fulfils on LIVE_FILLED, releases on every other outcome). Stale wins first so
 * a TTL-elapsed refusal lands on LIVE_EXPIRED. The failed/reject classification
 * mirrors the legacy `/fail|error|reject/i` status test used at the EA boundary.
 */
export function mapBridgedLiveOutcome(input: {
  status: string;
  reason?: string | null;
  hasBrokerTicket: boolean;
}): BridgedLiveOutcome {
  const status = input.status ?? "";
  const statusLc = status.toLowerCase();
  const reasonLc = (input.reason ?? "").toLowerCase();
  if (statusLc.includes("stale") || reasonLc.includes("stale")) {
    return "STALE_COMMAND_REJECTED";
  }
  if (LIVE_FAILED_STATUS_RE.test(status)) {
    return statusLc.includes("reject") ? "LIVE_REJECTED" : "LIVE_FAILED";
  }
  return input.hasBrokerTicket ? "LIVE_FILLED" : "LIVE_FAILED";
}

export async function recordLiveCommandResult(args: {
  userId: number;
  commandId: string;
  // Task #28 — STALE_COMMAND_REJECTED lets the EA report that it refused a
  // command whose TTL had already elapsed when it polled it. The server maps
  // it to the terminal LIVE_EXPIRED state.
  outcome: "LIVE_FILLED" | "LIVE_REJECTED" | "LIVE_FAILED" | "STALE_COMMAND_REJECTED";
  reportingBridgeConnectionId: number;
  brokerTicket?: string | null;
  fillPrice?: number | null;
  executedVolume?: number | null;
  mt5Retcode?: number | null;
  brokerMessage?: string | null;
  // The EA's own precise refusal code, sent in the `reason` JSON field on every
  // EA-side preflight rejection (PreTradeBrokerGuard, maintenance, lot ceiling,
  // command-type, etc.). The EA emits these BEFORE OrderSend, so there is no
  // mt5Retcode/brokerMessage — those legs only exist once the broker is called.
  // Without capturing `reason` here, every EA preflight refusal collapsed to the
  // generic EA_REJECTED_NO_DETAIL sentinel even though the EA knew the exact cause.
  eaReason?: string | null;
}): Promise<{ ok: boolean; command: ArxLiveCommand | null; reason?: string }> {
  const row = await loadOwned(args.userId, args.commandId);
  if (!row) return { ok: false, command: null, reason: "COMMAND_NOT_FOUND" };

  // Bridge-binding invariant: only the bridge that the command was
  // dispatched to (and that picked it up) may write its result. This
  // closes the cross-bridge result-spoof window where bridge X could
  // post FILLED for a command actually executed by bridge Y. Checked
  // BEFORE the dedup branch so a spoofing bridge cannot even bump the
  // duplicate counter.
  if (row.bridgeConnectionId != null && row.bridgeConnectionId !== args.reportingBridgeConnectionId) {
    return { ok: false, command: null, reason: "BRIDGE_BINDING_MISMATCH" };
  }

  // Task #28 — exactly-once: if the command is already in a terminal state
  // this is a duplicate result POST (EA retried, or a result raced the TTL
  // sweep). We acknowledge it with ok:true so the EA stops retrying, record
  // the duplicate for audit, but NEVER re-apply the outcome.
  if (row.status !== "SENT_TO_MT5_LIVE") {
    if (isTerminalLiveStatus(row.status as ArxLiveCommandStatus)) {
      const [bumped] = await db.update(arxLiveCommandsTable).set({
        duplicateResultCount: (row.duplicateResultCount ?? 0) + 1,
        resultRecordedAt: row.resultRecordedAt ?? new Date(),
      }).where(eq(arxLiveCommandsTable.commandId, args.commandId)).returning();
      await audit({
        eventType: "LIVE_RESULT_DUPLICATE_IGNORED", severity: "WARNING",
        userId: args.userId, symbol: row.symbol,
        message: `Duplicate live result ignored for ${args.commandId} (already ${row.status}); reported ${args.outcome}`,
        metadata: { commandId: args.commandId, existingStatus: row.status, reportedOutcome: args.outcome },
      });
      return { ok: true, command: bumped ?? row, reason: "DUPLICATE_IGNORED" };
    }
    // Non-terminal but not SENT (e.g. DRAFT/APPROVED) — illegal result.
    return { ok: false, command: null, reason: "BAD_STATE" };
  }

  // Map the EA outcome to the final command status. STALE_COMMAND_REJECTED
  // becomes LIVE_EXPIRED (terminal); everything else is its own status.
  const finalStatus: ArxLiveCommandStatus =
    args.outcome === "STALE_COMMAND_REJECTED" ? "LIVE_EXPIRED" : args.outcome;

  // Validate transition is legal.
  assertCanTransition(row.status as ArxLiveCommandStatus, finalStatus);

  const now = new Date();
  const updates: Partial<typeof arxLiveCommandsTable.$inferInsert> = {
    status: finalStatus,
    resultRecordedAt: now,
    brokerTicket: args.brokerTicket ?? null,
    fillPrice: args.fillPrice ?? null,
    executedVolume: args.executedVolume ?? null,
    mt5Retcode: args.mt5Retcode ?? null,
    brokerMessage: args.brokerMessage ?? null,
  };
  if (args.outcome === "LIVE_FILLED") {
    updates.filledAt = now;
  } else if (args.outcome === "STALE_COMMAND_REJECTED") {
    updates.rejectedAt = now;
    updates.expiredAt = now;
    if (row.rejectionReason == null) updates.rejectionReason = "STALE_COMMAND_REJECTED";
  } else {
    updates.rejectedAt = now;
    // Surface a clean rejection reason for the UI even when no explicit
    // `rejectionReason` was set upstream. Without this, the row showed
    // `rejection_reason = (none)` even though the EA returned a clear
    // broker_message + mt5Retcode — masking the real broker rejection.
    if (row.rejectionReason == null) {
      // Task #30 — derive a clean, human-readable reason from the broker's MT5
      // retcode dictionary first; fall back to the raw broker message, then a
      // generic sentinel. Raw codes stay in mt5Retcode/brokerMessage columns.
      const cleanMsg = args.brokerMessage?.trim();
      const cleanEaReason = args.eaReason?.trim();
      if (args.mt5Retcode != null) {
        const entry = explainMt5Retcode(args.mt5Retcode);
        updates.rejectionReason = entry.key === "UNKNOWN" && cleanMsg && cleanMsg.length > 0
          ? cleanMsg
          : entry.friendly;
      } else if (cleanMsg && cleanMsg.length > 0) {
        updates.rejectionReason = cleanMsg;
      } else if (cleanEaReason && cleanEaReason.length > 0) {
        // EA-side preflight refusals (no broker call → no retcode/brokerMessage)
        // carry their precise cause ONLY in the `reason` field. Surface it so the
        // row shows e.g. BROKER_RULE_SYMBOL_NOT_TRADABLE instead of "no detail".
        updates.rejectionReason = cleanEaReason;
      } else {
        updates.rejectionReason = "EA_REJECTED_NO_DETAIL";
      }
    }
  }

  // Task #28 — CAS write: the status guard `= SENT_TO_MT5_LIVE` makes this
  // first-write-wins. If a concurrent result post OR the TTL sweep already
  // transitioned the row out of SENT_TO_MT5_LIVE between our read above and
  // this write, the update matches 0 rows. We then re-read the now-terminal
  // row and treat this post as a duplicate (DUPLICATE_IGNORED) — never
  // overwriting the outcome that won the race. This closes the
  // FILLED-then-REJECTED and result-vs-sweep races.
  const [updated] = await db.update(arxLiveCommandsTable).set(updates)
    .where(and(
      eq(arxLiveCommandsTable.commandId, args.commandId),
      eq(arxLiveCommandsTable.status, "SENT_TO_MT5_LIVE"),
    )).returning();

  if (!updated) {
    const current = await loadOwned(args.userId, args.commandId);
    if (current && isTerminalLiveStatus(current.status as ArxLiveCommandStatus)) {
      const [bumped] = await db.update(arxLiveCommandsTable).set({
        duplicateResultCount: (current.duplicateResultCount ?? 0) + 1,
        resultRecordedAt: current.resultRecordedAt ?? new Date(),
      }).where(eq(arxLiveCommandsTable.commandId, args.commandId)).returning();
      await audit({
        eventType: "LIVE_RESULT_DUPLICATE_IGNORED", severity: "WARNING",
        userId: args.userId, symbol: row.symbol,
        message: `Duplicate live result lost CAS race for ${args.commandId} (now ${current.status}); reported ${args.outcome}`,
        metadata: { commandId: args.commandId, existingStatus: current.status, reportedOutcome: args.outcome },
      });
      return { ok: true, command: bumped ?? current, reason: "DUPLICATE_IGNORED" };
    }
    return { ok: false, command: current ?? null, reason: "CAS_CONFLICT" };
  }

  // Tamper-evident mirror of the broker order outcome — best-effort, never
  // throws (cannot affect fill settlement). FILLED is ALLOWED; everything else
  // is DENIED so a rejected/failed order is permanently chain-recorded.
  await mirrorCriticalEvent({
    eventType: "ORDER_RESULT", severity: "CRITICAL",
    status: args.outcome === "LIVE_FILLED" ? "ALLOWED" : "DENIED",
    actorUserId: args.userId, actorType: "EA",
    affectedObject: `arx_live_commands:${args.commandId}`,
    message: `Live order result: ${args.outcome}`,
    metadata: { commandId: args.commandId, symbol: row.symbol, outcome: args.outcome, hasBrokerTicket: !!args.brokerTicket },
  });

  // Settle the master-exposure reservation taken at dispatch time.
  // LIVE_FILLED → FULFILLED (lots remain attributed via shared_trade_attribution).
  // LIVE_REJECTED / LIVE_FAILED → RELEASED (lots return to the pool).
  // Both helpers act only on rows still in RESERVED, so duplicate EA
  // callbacks are idempotent.
  try {
    const { fulfillReservationByCommandId, releaseReservationByCommandId } =
      await import("../concurrency/exposureReservation.js");
    if (args.outcome === "LIVE_FILLED") {
      await fulfillReservationByCommandId(args.commandId);
    } else {
      await releaseReservationByCommandId(args.commandId);
    }
  } catch (e) {
    logger.error({
      [PHASE_B_LIVE_LOG_PREFIX]: true,
      event: "RESERVATION_SETTLEMENT_FAILED",
      commandId: args.commandId, outcome: args.outcome,
      error: e instanceof Error ? e.message : String(e),
    }, "failed to settle exposure reservation — manual reconciliation required");
  }

  // Task #28 (T003) — forced reconciliation of position close. When a
  // CLOSE_LIVE_POSITION command fills, the broker has truly closed the
  // position, so stamp the matching arx_live_positions row's `closedAt`
  // immediately rather than waiting for the next sync-live-positions snapshot.
  // This prevents "ghost" open rows that linger after a confirmed close.
  // ALERT_ONLY-consistent: we only record broker-confirmed truth, never
  // initiate a close ourselves.
  if (args.outcome === "LIVE_FILLED" && row.commandType === "CLOSE_LIVE_POSITION") {
    const closeTicket = typeof (row.payload as Record<string, unknown> | null)?.["brokerTicket"] === "string"
      ? String((row.payload as Record<string, unknown>)["brokerTicket"])
      : (args.brokerTicket ?? null);
    if (closeTicket) {
      try {
        const closedRows = await db.update(arxLivePositionsTable).set({
          closedAt: now,
          lastSyncedAt: now,
        }).where(and(
          eq(arxLivePositionsTable.userId, args.userId),
          eq(arxLivePositionsTable.brokerTicket, closeTicket),
          isNull(arxLivePositionsTable.closedAt),
        )).returning();
        if (closedRows.length > 0) {
          await audit({
            eventType: "LIVE_POSITION_CLOSED_RECONCILED", severity: "INFO",
            userId: args.userId, symbol: row.symbol,
            message: `Position ${closeTicket} marked closed from filled CLOSE command ${args.commandId}`,
            metadata: { commandId: args.commandId, brokerTicket: closeTicket },
          });
          // Best-effort: if this closed position is a Profit Mission trade, record
          // its realised outcome + missed-profit verdict against the executed
          // mission draft. No-op for non-mission positions; never an execution
          // path and never allowed to disturb the close-confirmation result.
          try {
            const closedPos = closedRows[0] as { floatingPl?: number | null } | undefined;
            const realisedPnl =
              typeof closedPos?.floatingPl === "number" && Number.isFinite(closedPos.floatingPl)
                ? closedPos.floatingPl
                : null;
            const { recordMissionTradeCloseByBrokerTicket } = await import("../missionExitManager.js");
            await recordMissionTradeCloseByBrokerTicket({
              userId: args.userId,
              brokerTicket: closeTicket,
              realisedPnl,
              nowMs: now.getTime(),
            });
          } catch (e) {
            logger.error({
              [PHASE_B_LIVE_LOG_PREFIX]: true,
              event: "MISSION_TRADE_CLOSE_RECORD_FAILED",
              commandId: args.commandId, brokerTicket: closeTicket,
              error: e instanceof Error ? e.message : String(e),
            }, "failed to record mission-trade close (advisory) — non-fatal");
          }
        }
      } catch (e) {
        logger.error({
          [PHASE_B_LIVE_LOG_PREFIX]: true,
          event: "LIVE_POSITION_CLOSE_RECONCILE_FAILED",
          commandId: args.commandId, brokerTicket: closeTicket,
          error: e instanceof Error ? e.message : String(e),
        }, "failed to reconcile position closedAt after filled CLOSE");
      }
    }
  }

  await audit({
    eventType: `LIVE_RESULT_${args.outcome}`,
    severity: args.outcome === "LIVE_FILLED" ? "CRITICAL" : "HIGH",
    userId: args.userId, symbol: row.symbol,
    message: `Live result ${args.outcome}: ticket=${args.brokerTicket ?? "?"} retcode=${args.mt5Retcode ?? "?"}`,
    metadata: { commandId: args.commandId, brokerTicket: args.brokerTicket, mt5Retcode: args.mt5Retcode, brokerMessage: args.brokerMessage },
  });
  logger.warn({
    [PHASE_B_LIVE_LOG_PREFIX]: true,
    event: `LIVE_RESULT_${args.outcome}`,
    commandId: args.commandId, userId: args.userId,
    brokerTicket: args.brokerTicket, mt5Retcode: args.mt5Retcode,
  }, "Phase B live result recorded");
  return { ok: true, command: updated };
}

export async function cancelLiveCommand(args: { userId: number; commandId: string; reason: string }) {
  const row = await loadOwned(args.userId, args.commandId);
  if (!row) return { ok: false as const, reason: "COMMAND_NOT_FOUND" as const };
  if (!ALLOWED_TRANSITIONS[row.status as ArxLiveCommandStatus].includes("LIVE_CANCELLED")) {
    return { ok: false as const, reason: "BAD_STATE" as const, currentStatus: row.status };
  }
  const [updated] = await db.update(arxLiveCommandsTable).set({
    status: "LIVE_CANCELLED",
    rejectionReason: args.reason,
    rejectedAt: new Date(),
  }).where(eq(arxLiveCommandsTable.commandId, args.commandId)).returning();
  // Release any reservation tied to this command (no-op if absent).
  try {
    const { releaseReservationByCommandId } =
      await import("../concurrency/exposureReservation.js");
    await releaseReservationByCommandId(args.commandId);
  } catch { /* audit-only failure */ }
  await audit({ eventType: "LIVE_CANCELLED", userId: args.userId, symbol: row.symbol, message: args.reason });
  return { ok: true as const, command: updated };
}

async function loadOwned(userId: number, commandId: string) {
  const rows = await db.select().from(arxLiveCommandsTable)
    .where(and(eq(arxLiveCommandsTable.commandId, commandId), eq(arxLiveCommandsTable.userId, userId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function listMyLiveCommands(args: { userId: number; limit?: number }) {
  const limit = Math.min(Math.max(args.limit ?? 50, 1), 200);
  return db.select().from(arxLiveCommandsTable)
    .where(eq(arxLiveCommandsTable.userId, args.userId))
    .orderBy(desc(arxLiveCommandsTable.id))
    .limit(limit);
}

export async function getMyLiveCommand(userId: number, commandId: string) {
  return loadOwned(userId, commandId);
}

export async function getOrCreateUserSettings(userId: number) {
  const rows = await db.select().from(arxLiveUserSettingsTable)
    .where(eq(arxLiveUserSettingsTable.userId, userId)).limit(1);
  if (rows[0]) return rows[0];
  const [created] = await db.insert(arxLiveUserSettingsTable).values({
    userId,
    weeklyDrawdownCeilingPct: ARX_LIVE_HARD_WEEKLY_DRAWDOWN_PCT,
    maxLotPerMarket: ARX_LIVE_DEFAULT_MAX_LOT_PER_MARKET as unknown as Record<string, number>,
    allowedSymbols: ARX_LIVE_DEFAULT_ALLOWED_SYMBOLS as unknown as string[],
  }).returning();
  return created;
}

export async function updateUserSettings(args: {
  userId: number;
  weeklyDrawdownCeilingPct?: number;
  dailyLossLimitUsd?: number;
  maxLotPerMarket?: Record<string, number>;
  allowedSymbols?: string[];
  requireStopLoss?: boolean;
}) {
  await getOrCreateUserSettings(args.userId);
  const updates: Record<string, unknown> = { updatedAt: new Date() };

  if (args.weeklyDrawdownCeilingPct != null) {
    // Server hard cap: never above 10%.
    updates.weeklyDrawdownCeilingPct = Math.min(args.weeklyDrawdownCeilingPct, ARX_LIVE_HARD_WEEKLY_DRAWDOWN_PCT);
  }
  if (args.dailyLossLimitUsd != null) updates.dailyLossLimitUsd = Math.max(0, args.dailyLossLimitUsd);
  if (args.maxLotPerMarket) {
    // Cap each per-market value at its default ceiling.
    const sanitized: Record<string, number> = {};
    for (const [sym, lot] of Object.entries(args.maxLotPerMarket)) {
      const cap = ARX_LIVE_DEFAULT_MAX_LOT_PER_MARKET[sym] ?? 0.1;
      sanitized[sym] = Math.max(0, Math.min(Number(lot), cap));
    }
    updates.maxLotPerMarket = sanitized;
  }
  if (args.allowedSymbols) {
    updates.allowedSymbols = args.allowedSymbols.filter((s) => ARX_LIVE_DEFAULT_ALLOWED_SYMBOLS.includes(s));
  }
  if (args.requireStopLoss !== undefined) updates.requireStopLoss = args.requireStopLoss;

  await db.update(arxLiveUserSettingsTable).set(updates)
    .where(eq(arxLiveUserSettingsTable.userId, args.userId));
  return getOrCreateUserSettings(args.userId);
}
