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
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
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
// Wave-4 correlation guard — the R3 slice 6 pure core. @workspace/domain has
// no "./risk-correlation" subpath export (package.json is coordinator-owned
// and out of scope this wave), so the evaluator is consumed via the root
// barrel's `riskCorrelation` namespace — the same established pattern
// safetyCore.ts / the security modules use for the root barrel.
import { riskCorrelation } from "@workspace/domain";
import { getBrokerSymbolSpec } from "../mt5/brokerSymbolSpec.js";
import { resolveSymbolFeedVerdictForSymbol } from "../data/symbolFeedVerdictForSymbol.js";
// R4 slice 3 — enforcing broker-confirmed-feed entry gate. The pure
// predicate + fail-honest feed resolver both live in brokerConfirmedFeed.ts
// (whose modules — marketDataRouter / deriv provider / freshness — are
// already in this file's import graph via symbolFeedVerdictForSymbol).
import {
  evaluateLiveEntryFeedGate,
  resolveBrokerConfirmedFeed,
  brokerFeedGateEnforcementEnabled,
  BROKER_FEED_GATE_ENV,
} from "../data/brokerConfirmedFeed.js";
import { evaluateEntryDataSufficiency } from "./entryDataSufficiency.js";
// R2-S7 — execution-adapter seam. The pipeline consumes ONLY the interface;
// the sole implementation wraps this file's own enqueueBridgedMt5Command
// (injected below, function unchanged) so delivery behavior is byte-equivalent
// and R5's Deriv adapter can implement the same seam later.
import {
  Mt5EaBridgeAdapter,
  routeDeliveryFailure,
  type ExecutionAdapter,
  type Mt5DeliveryResult,
} from "./executionAdapter.js";
import { selectExecutionAdapter } from "./executionAdapterRegistry.js";
import type { ExecutionAdapterRegistry } from "./executionAdapterRegistry.js";
// R2-S4 — the freshness gate's run-row shape is a type-only import (erased at
// runtime). The VALUE import of reconciliationFreshnessVerdict is dynamic at
// the gate site: unknownReconciler.ts statically imports this module's pure
// helpers, so a static value import here would create an init cycle.
import type { ReconciliationRunRowLike } from "./unknownReconciler.js";
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
  ARX_LIVE_HARD_MAX_ENTRY_DEVIATION_BPS,
  ARX_LIVE_HARD_MAX_SIGNAL_AGE_MS,
  ARX_LIVE_HARD_MAX_CLUSTER_RISK_USD,
  ARX_LIVE_HARD_MAX_CLUSTER_POSITIONS,
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
// Foundation gates #19–#21 — envelope construction (draft) + input assembly
// (dispatch). The verdict logic itself is pure in @workspace/domain
// safety-contracts/foundationGates.ts and runs inside the Phase B evaluator.
import {
  buildCommandProvenanceEnvelope,
  parseCommandProvenanceEnvelope,
  type CommandProvenanceEnvelope,
} from "../provenance/commandProvenance.js";
import { buildFoundationGateInputs } from "./foundationGateInputs.js";
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
  // R2 S1 — a SENT command with pickup evidence but no confirmed broker
  // outcome enters LIVE_UNKNOWN (TTL sweep) — never a presumed terminal.
  // R2 S5 — a dispatched command may also be ACKNOWLEDGED (broker saw it, no
  // fill confirmed) or PARTIALLY_FILLED (ticket + executedVolume < requested)
  // before it settles. Both are non-terminal and hold the reservation.
  SENT_TO_MT5_LIVE: ["LIVE_FILLED", "LIVE_REJECTED", "LIVE_FAILED", "LIVE_BLOCKED", "LIVE_EXPIRED", "LIVE_UNKNOWN", "LIVE_ACKNOWLEDGED", "LIVE_PARTIALLY_FILLED"],
  // An acknowledgement settles into any real outcome, or into UNKNOWN if the
  // broker goes quiet after acking — an ack is NOT evidence of execution.
  LIVE_ACKNOWLEDGED: ["LIVE_FILLED", "LIVE_PARTIALLY_FILLED", "LIVE_REJECTED", "LIVE_FAILED", "LIVE_EXPIRED", "LIVE_UNKNOWN"],
  // A partial completes, closes, or has its remainder cancelled. It may also
  // go UNKNOWN if the remainder's fate stops being reported. It may NOT go to
  // REJECTED/FAILED: real exposure already exists at the broker.
  LIVE_PARTIALLY_FILLED: ["LIVE_FILLED", "LIVE_CLOSED", "LIVE_CANCELLED", "LIVE_UNKNOWN"],
  LIVE_FILLED: ["LIVE_CLOSED"],
  LIVE_REJECTED: [], LIVE_FAILED: [], LIVE_BLOCKED: [], LIVE_CANCELLED: [], LIVE_CLOSED: [],
  LIVE_EXPIRED: [],
  // R2 S1 — UNKNOWN is deliberately narrow: it may NOT be cancelled (a real
  // position may exist; cancel would release the held reservation) and only
  // reconciliation (R2 S3) escalates it. RECONCILIATION_REQUIRED resolves to
  // a broker-truth terminal only.
  LIVE_UNKNOWN: ["LIVE_RECONCILIATION_REQUIRED"],
  LIVE_RECONCILIATION_REQUIRED: ["LIVE_FILLED", "LIVE_PARTIALLY_FILLED", "LIVE_REJECTED", "LIVE_FAILED", "LIVE_CANCELLED", "LIVE_EXPIRED"],
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
// R2 S1 — LIVE_UNKNOWN and LIVE_RECONCILIATION_REQUIRED are intentionally
// NOT terminal: an unconfirmed outcome must keep its exposure reservation
// held and its duplicate-block active until reconciliation resolves it.
const LIVE_TERMINAL_STATUSES: ArxLiveCommandStatus[] = [
  "LIVE_FILLED", "LIVE_REJECTED", "LIVE_FAILED",
  "LIVE_BLOCKED", "LIVE_CANCELLED", "LIVE_CLOSED", "LIVE_EXPIRED",
];

// R2 S1 — the epistemic (non-terminal, unresolved-outcome) states. A late
// broker result arriving while a command rests here is RETAINED as evidence
// (execution_events) and acknowledged, but never applied — only the
// reconciliation path (R2 S3) may resolve these states.
const LIVE_EPISTEMIC_STATUSES: ArxLiveCommandStatus[] = [
  "LIVE_UNKNOWN", "LIVE_RECONCILIATION_REQUIRED",
];

// R2 S5 — statuses a fresh EA/broker result may still be APPLIED to.
//
// SENT is the ordinary case. ACKNOWLEDGED and PARTIALLY_FILLED are added
// because a result arriving after them is the normal next step of the same
// order (the ack settles; the remainder fills), NOT late evidence for the
// reconciler — deliberately kept OUT of LIVE_EPISTEMIC_STATUSES, which parks
// a result for reconciliation and would otherwise strand every partial.
// Legality of each specific hop is still enforced by ALLOWED_TRANSITIONS.
const LIVE_RESULT_APPLICABLE_STATUSES: ArxLiveCommandStatus[] = [
  "SENT_TO_MT5_LIVE", "LIVE_ACKNOWLEDGED", "LIVE_PARTIALLY_FILLED",
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

// ── R2 S1 — pure UNKNOWN-semantics helpers ──────────────────────────────────
// Extracted (same pattern as the TTL/kill-switch helpers above) so the
// epistemology contracts are unit-testable offline without a DB.

/** PURE transition-legality predicate over the live state machine. */
export function isAllowedLiveTransition(
  from: ArxLiveCommandStatus,
  to: ArxLiveCommandStatus,
): boolean {
  return (ALLOWED_TRANSITIONS[from] ?? []).includes(to);
}

/**
 * PURE classification of a TTL-elapsed SENT_TO_MT5_LIVE command (audit G1a).
 *
 * LIVE_EXPIRED (terminal, reservation released) is permitted ONLY when the EA
 * provably never saw the command:
 *   - arx-side pickup stamp (`pickedByEaAt`) is null, AND
 *   - the mt5_commands transport mirror (the mailbox the v1.50 EA actually
 *     polls) was never claimed — absent (null), still PENDING, or cancelled
 *     before pickup.
 * ANY evidence of pickup — pickedByEaAt set, or a mirror status other than
 * the never-served set — means the order may be standing at the broker, so
 * the row goes to LIVE_UNKNOWN (non-terminal, reservation HELD). Unrecognized
 * mirror statuses fail toward LIVE_UNKNOWN: when in doubt, do not presume
 * non-execution.
 */
export function classifySweptLiveCommand(input: {
  pickedByEaAt: Date | null;
  /** Transport-mirror status; null = no mirror row exists for this command. */
  mirrorStatus: string | null;
}): "LIVE_EXPIRED" | "LIVE_UNKNOWN" {
  if (input.pickedByEaAt != null) return "LIVE_UNKNOWN";
  const mirror = input.mirrorStatus;
  const neverServed = mirror == null || mirror === "PENDING" || mirror === "cancelled";
  return neverServed ? "LIVE_EXPIRED" : "LIVE_UNKNOWN";
}

/**
 * PURE master-exposure-reservation settlement rule (audit G1b).
 *
 *   FULFILL — confirmed fill (broker ticket verified upstream).
 *   RELEASE — confirmed non-execution (broker/EA explicitly rejected/failed,
 *             or the EA itself refused the command as stale, or the server
 *             proved the EA never received it).
 *   HOLD    — unconfirmed outcome: the order may be standing at the broker,
 *             so the reserved lots must stay attributed to the master pool
 *             until reconciliation resolves the command. Releasing here
 *             under-counts the pool and can over-expose the master account.
 *
 * Any status outside the live-command vocabulary holds — never releases —
 * because an unrecognized state is by definition unconfirmed.
 */
export function settleReservationForStatus(
  finalStatus: ArxLiveCommandStatus,
): "FULFILL" | "RELEASE" | "HOLD" {
  switch (finalStatus) {
    case "LIVE_FILLED":
      return "FULFILL";
    case "LIVE_REJECTED":
    case "LIVE_FAILED":
    case "LIVE_EXPIRED":
    case "LIVE_BLOCKED":
    case "LIVE_CANCELLED":
      return "RELEASE";
    // R2 S5 — explicit for clarity (the fail-closed default already did this):
    // an ack proves nothing about execution, and a partial still has a working
    // remainder. Releasing on either would under-count live exposure.
    case "LIVE_ACKNOWLEDGED":
    case "LIVE_PARTIALLY_FILLED":
      return "HOLD";
    default:
      return "HOLD";
  }
}

// ── R2 S2 — append-only execution_events writer ─────────────────────────────

/** Shaped row for one execution_events insert (see lib/db executionEvents.ts). */
export interface ExecutionEventRow {
  commandRowId: number;
  source: string;
  eventType: string;
  payload: Record<string, unknown>;
  occurredAt: Date;
}

/**
 * PURE shaping/validation of an execution-event row. Refuses (with a reason,
 * never a throw) rather than fabricating an anchor or a type:
 *   - commandRowId must be a positive integer (the arx_live_commands PK);
 *   - source and eventType must be non-empty after trimming;
 *   - a missing occurredAt falls back to `now` (the caller's clock) — the
 *     received_at column is stamped by the DB independently.
 */
export function buildExecutionEventRow(input: {
  commandRowId: number | null | undefined;
  source: string | null | undefined;
  eventType: string | null | undefined;
  payload?: Record<string, unknown> | null;
  occurredAt?: Date | null;
  now?: Date;
}): { ok: true; row: ExecutionEventRow } | { ok: false; reason: string } {
  const id = input.commandRowId;
  if (typeof id !== "number" || !Number.isInteger(id) || id <= 0) {
    return { ok: false, reason: "EVENT_COMMAND_ROW_ID_INVALID" };
  }
  const source = (input.source ?? "").trim();
  if (source === "") return { ok: false, reason: "EVENT_SOURCE_EMPTY" };
  const eventType = (input.eventType ?? "").trim();
  if (eventType === "") return { ok: false, reason: "EVENT_TYPE_EMPTY" };
  return {
    ok: true,
    row: {
      commandRowId: id,
      source,
      eventType,
      payload: input.payload ?? {},
      occurredAt: input.occurredAt ?? input.now ?? new Date(),
    },
  };
}

// execution_events writes go through raw parameterized SQL rather than the
// drizzle table object: the schema barrel export (lib/db/src/schema/index.ts)
// is a coordinator-owned registration, and evidence writing must neither
// depend on that registration landing first nor ever break this module's
// typecheck/dispatch. The INSERT computes the per-command sequence_no in the
// statement itself; the unique(command_id, sequence_no) index turns a
// concurrent-writer race into a unique violation, retried a bounded number
// of times.
const EXECUTION_EVENT_INSERT_ATTEMPTS = 3;

/**
 * Append one evidence row to execution_events. BEST-EFFORT BY CONTRACT:
 * every failure path warns and returns — an evidence write must never fail,
 * delay, or throw into dispatch/result settlement.
 */
async function recordExecutionEvent(input: {
  commandRowId: number | null | undefined;
  source: string;
  eventType: string;
  payload?: Record<string, unknown> | null;
  occurredAt?: Date | null;
}): Promise<void> {
  try {
    const shaped = buildExecutionEventRow(input);
    if (!shaped.ok) {
      logger.warn({
        [PHASE_B_LIVE_LOG_PREFIX]: true,
        event: "EXECUTION_EVENT_SKIPPED",
        reason: shaped.reason, eventType: input.eventType,
      }, "execution event refused by shaping — evidence not recorded");
      return;
    }
    const { row } = shaped;
    let payloadJson: string;
    try {
      payloadJson = JSON.stringify(row.payload);
    } catch {
      payloadJson = JSON.stringify({ unserializablePayload: true });
    }
    for (let attempt = 1; attempt <= EXECUTION_EVENT_INSERT_ATTEMPTS; attempt++) {
      try {
        await db.execute(sql`
          insert into execution_events
            (command_id, source, event_type, payload, occurred_at, sequence_no)
          values (
            ${row.commandRowId}, ${row.source}, ${row.eventType},
            ${payloadJson}::jsonb, ${row.occurredAt},
            (select coalesce(max(sequence_no), 0) + 1
               from execution_events where command_id = ${row.commandRowId})
          )
        `);
        return;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const isSeqRace = /execution_events_command_seq_uq|duplicate key/.test(msg);
        if (isSeqRace && attempt < EXECUTION_EVENT_INSERT_ATTEMPTS) continue;
        logger.warn({
          [PHASE_B_LIVE_LOG_PREFIX]: true,
          event: "EXECUTION_EVENT_WRITE_FAILED",
          commandRowId: row.commandRowId, eventType: row.eventType,
          attempt, error: msg,
        }, "execution event write failed — evidence not recorded (dispatch unaffected)");
        return;
      }
    }
  } catch (e) {
    logger.warn({
      [PHASE_B_LIVE_LOG_PREFIX]: true,
      event: "EXECUTION_EVENT_WRITE_FAILED",
      eventType: input.eventType,
      error: e instanceof Error ? e.message : String(e),
    }, "execution event write failed — evidence not recorded (dispatch unaffected)");
  }
}

// Global emergency-kill-switch pre-gate. POST /api/admin/trading/emergency-kill
// engages global_trading_settings.emergency_kill_switch; dispatch consumes it
// via this reason literal BEFORE the 23-gate evaluator, in BOTH routing modes.
export const EMERGENCY_KILL_SWITCH_BLOCK_REASON =
  "LIVE_BLOCKED:EMERGENCY_KILL_SWITCH_ENGAGED" as const;

/**
 * PURE decision for the emergency-kill-switch pre-gate (no I/O — extracted so
 * the contract is unit-testable offline, like the CAS/TTL helpers above).
 * TRUE = refuse the dispatch.
 *
 * - Fail-closed: a missing/unreadable settings value counts as ENGAGED
 *   (`!== false`), matching the column default (emergency_kill_switch NOT NULL
 *   DEFAULT true), the FAIL_CLOSED safety envelope, and
 *   buildApprovedTraderLiveState's `settingsRow?.emergencyKillSwitch !== false`.
 * - The ONLY exemption is the Task #743 Cluster D admin-emergency-close marker
 *   (integrity-hashed, CLOSE_LIVE_POSITION only) — the same narrow relaxation
 *   gate #5 grants — so an operator can still flatten exposure while the
 *   platform is halted. OPEN / MODIFY / un-stamped CLOSE never qualify.
 */
export function emergencyKillSwitchBlocksDispatch(args: {
  emergencyKillSwitch: boolean | null | undefined;
  commandType: string;
  hasKillSwitchCloseBypassMarker: boolean;
}): boolean {
  const engaged = args.emergencyKillSwitch !== false;
  if (!engaged) return false;
  return !killSwitchCloseBypassApplies({
    commandType: args.commandType,
    hasBypassMarker: args.hasKillSwitchCloseBypassMarker,
  });
}

// R3 slice 1 — weekly-drawdown-ceiling pre-gate. arx_live_user_settings.
// weekly_drawdown_ceiling_pct was stored + hard-capped (≤10) at write time
// but read by no gate; dispatch consumes it via this reason literal BEFORE
// the 23-gate evaluator, next to the daily-loss input assembly.
export const WEEKLY_DRAWDOWN_BLOCK_REASON =
  "LIVE_BLOCKED:WEEKLY_DRAWDOWN_CEILING_REACHED" as const;

/**
 * PURE decision for the weekly-drawdown pre-gate (no I/O — extracted so the
 * contract is unit-testable offline, like the kill-switch helper above).
 * TRUE = refuse the dispatch.
 *
 * - ENTRY-ONLY: close/modify commands never block here. A user at the weekly
 *   ceiling must still be able to flatten exposure — same never-trap-money
 *   rule the allocation-freeze `tradingFrozen` split and the per-user
 *   exposure gates apply.
 * - Fail-OPEN only when the ceiling is unset/zero: 0 = no weekly cap,
 *   matching the `dailyLossLimitUsd = 0` semantics of gate #15.
 * - Fail-CLOSED on unreadable data mid-check: a set ceiling with a corrupt
 *   pct, an unresolvable/non-positive reference equity, or a non-finite or
 *   negative loss figure refuses dispatch — never guesses a number.
 * - Breach is `loss >= ceiling` (inclusive), mirroring gate #15's
 *   `realisedDailyLossUsd >= dailyLossLimitUsd`.
 */
export function weeklyDrawdownBlocksDispatch(args: {
  weeklyDrawdownCeilingPct: number | null | undefined;
  referenceEquityUsd: number | null | undefined;
  realisedWeeklyLossUsd: number | null | undefined;
  isEntryCommand: boolean;
}): boolean {
  if (!args.isEntryCommand) return false;
  const pct = args.weeklyDrawdownCeilingPct;
  if (pct == null || pct === 0) return false;
  if (!Number.isFinite(pct) || pct < 0) return true;
  const ref = args.referenceEquityUsd;
  if (ref == null || !Number.isFinite(ref) || ref <= 0) return true;
  const loss = args.realisedWeeklyLossUsd;
  if (loss == null || !Number.isFinite(loss) || loss < 0) return true;
  return loss >= ref * (pct / 100);
}

// R3 slice 2 — risk-lock pre-gate. risk_locks rows (cooldown /
// consecutive-loss / revenge / manual …) were enforced only on the paper
// permission routes; dispatch consumes them via this prefixed reason
// (LIVE_BLOCKED:RISK_LOCK_<TYPE>) BEFORE the 23-gate evaluator.
export const RISK_LOCK_BLOCK_REASON_PREFIX = "LIVE_BLOCKED:RISK_LOCK_" as const;

// ── CLOSE-ONLY MODE (spec §3.1 global control / §20 "close-only proven") ────
export const CLOSE_ONLY_BLOCK_REASON = "LIVE_BLOCKED:CLOSE_ONLY_MODE" as const;

/**
 * PURE — does close-only mode refuse this dispatch?
 *
 * Close-only means: manage what you already hold, open nothing new. So it
 * refuses ENTRY commands only; CLOSE/MODIFY always pass, because a control
 * that trapped open exposure would be strictly more dangerous than the risk
 * it was set to contain.
 *
 * Distinct from `tradingFrozen`, which is an operator FREEZE carrying a
 * reason/actor/timestamp. Close-only is a risk posture that can be set
 * without the administrative framing, so the two are read independently and
 * either one refuses on its own.
 *
 * Fail-open on absence is deliberate and safe here: the flag defaults false,
 * and an absent allocation row already fails elsewhere in the pool checks.
 * This gate only ever ADDS a refusal.
 */
export function closeOnlyBlocksDispatch(args: {
  closeOnlyMode: boolean | null | undefined;
  isEntryCommand: boolean;
}): boolean {
  if (!args.isEntryCommand) return false;
  return args.closeOnlyMode === true;
}

/**
 * PURE decision for the risk-lock pre-gate (no I/O — extracted so the
 * contract is unit-testable offline). Returns the full block-reason literal
 * for the first blocking lock, or null when nothing blocks.
 *
 * - ENTRY-ONLY: close/modify commands always pass — a lock exists to stop
 *   NEW risk, never to trap open exposure (same entry-vs-ops split the
 *   allocation-freeze `tradingFrozen` rule uses).
 * - A lock blocks only while ACTIVE and unexpired: `isActive` true AND
 *   (`endTime` null = indefinite, or `endTime` still in the future) —
 *   matching routes/permission.ts `loadActiveLocks`. Released or expired
 *   rows never block.
 * - Every active lock TYPE blocks (the table's lock_type is free text; an
 *   unknown type still refuses — an unrecognised lock must fail closed,
 *   not silently grant capacity).
 */
export function activeRiskLockBlockReason(args: {
  locks: ReadonlyArray<{
    lockType: string;
    isActive: boolean;
    endTime: Date | string | null;
  }>;
  isEntryCommand: boolean;
  now?: Date;
}): string | null {
  if (!args.isEntryCommand) return null;
  const nowMs = (args.now ?? new Date()).getTime();
  for (const lock of args.locks) {
    if (!lock.isActive) continue;
    if (lock.endTime != null && new Date(lock.endTime).getTime() <= nowMs) continue;
    return `${RISK_LOCK_BLOCK_REASON_PREFIX}${lock.lockType}`;
  }
  return null;
}

// Per-trade required-margin / risk USD proxy shared by the allocation
// headroom pre-gate (preflight) and the wave-4 correlation-cluster pre-gate:
// lot × 1000 USD-equivalent (a typical 100:1 leveraged forex mini-lot margin
// envelope). Deliberately conservative; MT5 still enforces true margin
// server-side. Hoisted to module scope (was preflight-local) so both
// consumers derive the SAME per-command risk figure and can never drift.
export const REQUIRED_MARGIN_PROXY_PER_LOT_USD = 1000;

// The R3 slice 6 pure cluster-exposure evaluator (see import note above).
const { evaluateClusterExposure } = riskCorrelation;

// ── R3 slice 4 — price-collar pre-gate ──────────────────────────────────────
// Preflight intentionally passes `requestedPrice: null` into the broker-rule
// guard ("server does not enforce slippage") and delegates deviation to the
// EA — fail-OPEN by design when the user has NOT asked for a server-side
// collar. arx_live_user_settings.max_entry_deviation_bps is that ask: when
// set, dispatch resolves a dispatch-time reference price from the execution
// broker feed (the same getLiveQuote provider chain the preflight quote legs
// use) and refuses entries whose draft-vs-now deviation exceeds the cap,
// BEFORE the 23-gate evaluator.
export const PRICE_DEVIATION_BLOCK_REASON =
  "LIVE_BLOCKED:PRICE_DEVIATION_TOO_LARGE" as const;

/**
 * PURE decision for the price-collar pre-gate (no I/O — same extraction
 * pattern as the kill-switch / weekly / risk-lock helpers above).
 * TRUE = refuse the dispatch.
 *
 * - ENTRY-ONLY: close/modify never block here (never-trap-money split).
 * - Cap null/undefined = gate skipped (fail-open): the EA's own
 *   DEVIATION_TOO_LARGE guard + broker-side SetDeviationInPoints still apply.
 * - Cap SET (including a REAL cap of 0 bps — 0 is never "unlimited"): the
 *   check is DEMANDED, so unprovable inputs fail CLOSED —
 *     · corrupt cap (non-finite / negative)            → refuse;
 *     · missing/non-positive draft requested price     → refuse (no
 *       provenance of the price the user approved);
 *     · missing/unresolvable dispatch reference price  → refuse (cannot
 *       prove the deviation is inside the cap).
 * - The deviation decision is NOT re-derived here: it REUSES the pure
 *   DEVIATION_TOO_LARGE check in @workspace/domain preTradeBrokerGuard by
 *   feeding it a synthetic 1-point == 1-bp frame (point = reference/10000,
 *   maxDeviationPoints = cap-in-bps, bid = ask = reference, fresh quote).
 *   Under these inputs every other leg of that guard is inert (positive
 *   prices, zero spread, null broker spec ⇒ spec legs fail-open), so the
 *   ONLY consulted check is the deviation leg — one shared slippage
 *   definition, zero drift between server and EA semantics.
 */
export function priceCollarBlocksDispatch(args: {
  maxEntryDeviationBps: number | null | undefined;
  /** Draft-time price the user approved (payload.referencePrice). */
  requestedPrice: number | null | undefined;
  /** Dispatch-time reference price from the execution broker feed. */
  referencePrice: number | null | undefined;
  side: "BUY" | "SELL";
  isEntryCommand: boolean;
}): boolean {
  if (!args.isEntryCommand) return false;
  const cap = args.maxEntryDeviationBps;
  if (cap == null) return false;
  if (!Number.isFinite(cap) || cap < 0) return true;
  const requested = args.requestedPrice;
  if (requested == null || !Number.isFinite(requested) || requested <= 0) return true;
  const reference = args.referencePrice;
  if (reference == null || !Number.isFinite(reference) || reference <= 0) return true;
  const guard = evaluatePreTradeBrokerGuard({
    side: args.side,
    volume: 0.01, // inert: every volume leg fails open on a null broker spec
    stopLoss: null,
    takeProfit: null,
    requestedPrice: requested,
    quote: { bid: reference, ask: reference, quoteAgeMs: 0 },
    spec: {
      visible: null, tradeAllowed: null, tradeMode: null, marketOpen: null,
      point: reference / 10_000, // 1 "point" == 1 bp of the reference price
      minVolume: null, maxVolume: null, volumeStep: null,
      stopsLevelPoints: null, freezeLevelPoints: null,
    },
    limits: { ...DEFAULT_PRE_TRADE_GUARD_LIMITS, maxDeviationPoints: cap },
  });
  const deviation = guard.checks.find((c) => c.key === "DEVIATION_TOO_LARGE");
  // Fail-closed: if the shared guard ever stopped emitting the deviation
  // check, a demanded collar must refuse rather than silently pass.
  return deviation == null || deviation.passed === false;
}

// ── R3 slice 5 — signal-age pre-gate ────────────────────────────────────────
// arx_live_commands.signal_timestamp carries the caller-supplied provenance
// of WHEN the signal/decision behind an entry was generated (threaded from
// createLiveDraft's typed input). arx_live_user_settings.max_signal_age_ms
// is the user's demanded bound; dispatch consumes both via this reason
// literal BEFORE the 23-gate evaluator.
export const SIGNAL_TOO_OLD_BLOCK_REASON = "LIVE_BLOCKED:SIGNAL_TOO_OLD" as const;

/**
 * PURE decision for the signal-age pre-gate (no I/O). TRUE = refuse.
 *
 * - ENTRY-ONLY: close/modify never block here.
 * - Bound null/undefined = no bound configured — gate skipped.
 * - Corrupt bound (non-finite / negative) = refuse (fail-closed, never guess).
 * - Bound SET + missing/unparseable signalTimestamp = refuse: a configured
 *   bound means the user demands provenance of timing, so an entry that
 *   cannot prove when its signal was generated must not fire.
 * - Refusal is strictly `age > bound` (a REAL bound of 0 ms admits only a
 *   signal stamped at/after `now`). A FUTURE timestamp yields negative age
 *   and passes — clock skew must not spuriously refuse here; the TTL /
 *   clock-drift contracts own that direction.
 */
export function signalAgeBlocksDispatch(args: {
  maxSignalAgeMs: number | null | undefined;
  signalTimestamp: Date | string | null | undefined;
  isEntryCommand: boolean;
  now?: Date;
}): boolean {
  if (!args.isEntryCommand) return false;
  const bound = args.maxSignalAgeMs;
  if (bound == null) return false;
  if (!Number.isFinite(bound) || bound < 0) return true;
  if (args.signalTimestamp == null) return true;
  const tsMs = new Date(args.signalTimestamp).getTime();
  if (!Number.isFinite(tsMs)) return true;
  const nowMs = (args.now ?? new Date()).getTime();
  return nowMs - tsMs > bound;
}

// ── Wave-4 — correlation-cluster pre-gate (wires the R3 slice 6 pure core) ──
// evaluateClusterExposure clusters the candidate with same-(risk family ×
// direction) open exposure; caps come from the TWO nullable
// arx_live_user_settings columns max_cluster_risk_usd / max_cluster_positions.
export const CLUSTER_BLOCK_REASON_PREFIX = "LIVE_BLOCKED:CLUSTER_" as const;

/**
 * PURE decision for the cluster-exposure pre-gate (no I/O). Returns the full
 * LIVE_BLOCKED:CLUSTER_<REASON> literal plus the evaluator's evaluation (for
 * the audit snapshot), or null when nothing blocks.
 *
 * - ENTRY-ONLY: close/modify never block here.
 * - BOTH caps null/undefined = no cap configured — gate skipped entirely
 *   (matching the evaluator's nullable-cap "unset ⇒ no cap" semantics; 0 is
 *   a REAL cap of zero, never "unlimited").
 * - With ANY cap set the evaluator decides, and its fail-closed validation
 *   refusals (corrupt candidate / corrupt open row / corrupt cap) block too —
 *   a corrupt row must never silently create capacity.
 * - Reason composition mirrors the risk-lock prefix pattern; a leading
 *   "CLUSTER_" on the evaluator reason is collapsed so CLUSTER_RISK_EXCEEDED
 *   surfaces as LIVE_BLOCKED:CLUSTER_RISK_EXCEEDED (never ..._CLUSTER_CLUSTER_...)
 *   while CANDIDATE_INVALID surfaces as LIVE_BLOCKED:CLUSTER_CANDIDATE_INVALID.
 */
export function clusterExposureBlockReason(args: {
  candidate: { symbol: string; side: string; riskAmount: number };
  openPositions: ReadonlyArray<{ symbol: string; side: string; riskAmount: number }>;
  maxClusterRiskUsd: number | null | undefined;
  maxClusterPositions: number | null | undefined;
  isEntryCommand: boolean;
}): { reason: string; evaluation: ReturnType<typeof evaluateClusterExposure> } | null {
  if (!args.isEntryCommand) return null;
  const riskCap = args.maxClusterRiskUsd ?? null;
  const positionsCap = args.maxClusterPositions ?? null;
  if (riskCap == null && positionsCap == null) return null;
  const evaluation = evaluateClusterExposure({
    candidate: args.candidate,
    openPositions: [...args.openPositions],
    maxClusterRisk: riskCap,
    maxClusterPositions: positionsCap,
  });
  if (evaluation.allowed) return null;
  const evaluatorReason = evaluation.reason ?? "REFUSED";
  const suffix = evaluatorReason.startsWith("CLUSTER_")
    ? evaluatorReason.slice("CLUSTER_".length)
    : evaluatorReason;
  return { reason: `${CLUSTER_BLOCK_REASON_PREFIX}${suffix}`, evaluation };
}

// ── R4 slice 3 — broker-confirmed-feed entry gate (ENFORCING) ───────────────
// evaluateLiveEntryFeedGate (lib/data/brokerConfirmedFeed.ts) was landed as a
// pure predicate with the pipeline still observe-only; this wave makes it an
// enforcing entry pre-gate. Default-ON: ARX_ENFORCE_BROKER_CONFIRMED_FEED
// absent/any-non-disable value ENFORCES; only an explicit disable value
// (e.g. "false") turns it observe-only — named loudly at startup below.
// Close/reduce/modify are exempt inside the predicate itself (intent split).
export const BROKER_FEED_BLOCK_REASON =
  "LIVE_BLOCKED:BROKER_FEED_NOT_CONFIRMED" as const;

// Startup override notice — a disabled safety gate must never be silent.
// Evaluated once at module init (the pipeline is loaded at server startup).
if (!brokerFeedGateEnforcementEnabled(process.env[BROKER_FEED_GATE_ENV])) {
  logger.warn({
    [PHASE_B_LIVE_LOG_PREFIX]: true,
    event: "BROKER_FEED_GATE_ENFORCEMENT_DISABLED",
    envVar: BROKER_FEED_GATE_ENV,
    rawValue: process.env[BROKER_FEED_GATE_ENV] ?? null,
  }, `${BROKER_FEED_GATE_ENV} explicitly disables broker-confirmed-feed enforcement — live ENTRY dispatch will NOT be blocked on an unconfirmed feed (observe-only)`);
}

// ── R2-S4 — reconciliation-freshness entry pre-gate (flag-staged) ───────────
// reconciliationFreshnessVerdict (unknownReconciler.ts) is the pure read-side
// predicate over the newest reconciliation_runs row; this wave wires it as an
// ENTRY-ONLY dispatch pre-gate behind ARX_REQUIRE_FRESH_RECONCILIATION.
//
// DEFAULT OFF THIS RELEASE (deliberate, not an oversight): no scheduled
// reconciler exists yet on Replit, so a default-ON gate would see zero
// reconciliation_runs rows and fail-closed refuse EVERY live entry — including
// the owner's own live testing. The default flips ON once the reconciler is
// scheduled; that flip is an owner call and must be recorded in the Owner
// Decision Registry (docs/OWNER_DECISIONS.md) — see the startup log below.
//
// When ON: the newest run row for this user (scope 'user') or bridge-wide
// (user_id NULL) must be COMPLETED, younger than ARX_RECONCILIATION_MAX_AGE_MS
// (default 300000), and verified-clean on BOTH match verdicts. Everything else
// — no run, unfinished run, stale run, unreadable table — refuses entries
// fail-closed with LIVE_BLOCKED:RECONCILIATION_STALE; a verified mismatch
// refuses with LIVE_BLOCKED:RECONCILIATION_MISMATCH. ENTRIES ONLY:
// close/modify always pass (never trap open exposure — the same entry-vs-ops
// split every other pre-gate applies).
export const RECONCILIATION_FRESHNESS_GATE_ENV = "ARX_REQUIRE_FRESH_RECONCILIATION" as const;
export const RECONCILIATION_MAX_AGE_ENV = "ARX_RECONCILIATION_MAX_AGE_MS" as const;
export const DEFAULT_RECONCILIATION_MAX_AGE_MS = 300_000;
export const RECONCILIATION_STALE_BLOCK_REASON =
  "LIVE_BLOCKED:RECONCILIATION_STALE" as const;
export const RECONCILIATION_MISMATCH_BLOCK_REASON =
  "LIVE_BLOCKED:RECONCILIATION_MISMATCH" as const;

/**
 * PURE flag parse. Default OFF: ONLY an explicit enable value ("1" | "true" |
 * "on" | "yes", case-insensitive, trimmed) turns the gate on. Absent / empty /
 * anything else stays off — the opposite polarity of the broker-feed gate
 * (default-ON) because here the enforcing dependency (a scheduled reconciler)
 * does not exist yet.
 */
export function reconciliationFreshnessGateEnabled(raw: string | null | undefined): boolean {
  if (raw == null) return false;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true" || v === "on" || v === "yes";
}

/** PURE max-age parse: positive finite ms, else the 300000 default (a
 *  corrupt bound must not silently widen OR narrow the window — it falls
 *  back to the documented default, never to "no bound"). */
export function resolveReconciliationMaxAgeMs(raw: string | null | undefined): number {
  if (raw == null || raw.trim() === "") return DEFAULT_RECONCILIATION_MAX_AGE_MS;
  const n = Number(raw.trim());
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_RECONCILIATION_MAX_AGE_MS;
}

/**
 * PURE verdict → block-reason mapping (offline-testable). null = pass. A
 * verified MISMATCH gets its own literal; EVERY other refusal (NO_RUN,
 * RUN_NOT_COMPLETED, RUN_STALE, RUN_TIMESTAMP_INVALID, MATCH_UNVERIFIED,
 * INVALID_MAX_AGE) is surfaced as STALE — fail-closed, and honest: none of
 * those states proves a mismatch, only that freshness cannot be proven.
 */
export function reconciliationGateBlockReason(
  verdict: { ok: boolean; reason: string },
): string | null {
  if (verdict.ok) return null;
  return verdict.reason === "MISMATCH"
    ? RECONCILIATION_MISMATCH_BLOCK_REASON
    : RECONCILIATION_STALE_BLOCK_REASON;
}

// Startup notice — the staged flag must never be silent in either direction.
// Evaluated once at module init (the pipeline is loaded at server startup).
if (!reconciliationFreshnessGateEnabled(process.env[RECONCILIATION_FRESHNESS_GATE_ENV])) {
  logger.warn({
    [PHASE_B_LIVE_LOG_PREFIX]: true,
    event: "RECONCILIATION_FRESHNESS_GATE_OFF",
    envVar: RECONCILIATION_FRESHNESS_GATE_ENV,
    rawValue: process.env[RECONCILIATION_FRESHNESS_GATE_ENV] ?? null,
  }, `${RECONCILIATION_FRESHNESS_GATE_ENV} is OFF (default this release): live ENTRY dispatch is NOT gated on reconciliation freshness. The scheduled reconciler NOW EXISTS (startUnknownReconcilerWorker, 60s cadence), so the original blocker is cleared — the gate stays OFF only until an operator confirms reconciliation_runs rows are accumulating cleanly against the real database. Flipping it is an owner decision (Owner Decision Registry, Ruling 10): a default-ON gate whose reconciler is failing would refuse every live entry.`);
} else {
  logger.warn({
    [PHASE_B_LIVE_LOG_PREFIX]: true,
    event: "RECONCILIATION_FRESHNESS_GATE_ON",
    envVar: RECONCILIATION_FRESHNESS_GATE_ENV,
    maxAgeMs: resolveReconciliationMaxAgeMs(process.env[RECONCILIATION_MAX_AGE_ENV]),
  }, `${RECONCILIATION_FRESHNESS_GATE_ENV} is ON: live ENTRY dispatch refuses without a fresh, clean reconciliation run (fail-closed; close/modify exempt)`);
}

// ── R3 slice 7 — failure-streak breaker ─────────────────────────────────────
// After recordLiveCommandResult APPLIES a terminal LIVE_FAILED/LIVE_REJECTED,
// the user's consecutive per-symbol terminal failures are counted (pure
// helper below) and at >= FAILURE_STREAK_THRESHOLD a 30-minute risk_locks row
// is inserted. Enforcement is automatic: the wave-2 risk-lock pre-gate blocks
// entries with LIVE_BLOCKED:RISK_LOCK_FAILURE_STREAK while the lock is active
// (it blocks EVERY active lock type, unknown ones included — fail-closed by
// its own contract), and close/modify stay allowed via that gate's
// entry-vs-ops split. riskLocks.ts's RISK_LOCK_TYPES vocabulary is not in
// this wave's scope; risk_locks.lock_type is free text, so the literal lives
// here.
export const FAILURE_STREAK_LOCK_TYPE = "FAILURE_STREAK" as const;
export const FAILURE_STREAK_THRESHOLD = 3;
export const FAILURE_STREAK_LOCK_MINUTES = 30;

/**
 * PURE consecutive-terminal-failure counter over a user's per-symbol command
 * statuses ordered NEWEST FIRST (arx_live_commands ORDER BY id DESC).
 *
 * - LIVE_FAILED / LIVE_REJECTED extend the streak.
 * - LIVE_FILLED / LIVE_CLOSED (broker-confirmed success) RESET — stop.
 * - Every other status (BLOCKED / CANCELLED / EXPIRED, the epistemic
 *   UNKNOWN states, and non-terminal rows) is NEUTRAL: it neither extends
 *   nor resets. A gate refusal or an unresolved outcome is not broker
 *   success, so it must not launder a failure streak back to zero.
 */
export function countConsecutiveTerminalFailures(
  statusesNewestFirst: readonly string[],
): number {
  let streak = 0;
  for (const status of statusesNewestFirst) {
    if (status === "LIVE_FAILED" || status === "LIVE_REJECTED") {
      streak += 1;
      continue;
    }
    if (status === "LIVE_FILLED" || status === "LIVE_CLOSED") break;
  }
  return streak;
}

/** PURE threshold rule: >= FAILURE_STREAK_THRESHOLD consecutive terminal
 *  failures engages the breaker (non-finite input never engages). */
export function failureStreakShouldLock(
  streak: number,
  threshold: number = FAILURE_STREAK_THRESHOLD,
): boolean {
  return Number.isFinite(streak) && streak >= threshold;
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
  /**
   * R3 slice 5 — provenance timestamp of the signal/decision this entry was
   * generated from (caller-supplied: scanner signal time, agent decision
   * time, …). Persisted on the typed `signal_timestamp` column. When the
   * user configures arx_live_user_settings.max_signal_age_ms, the dispatch
   * signal-age pre-gate refuses entries older than the bound — and, fail
   * CLOSED, refuses entries with NO stamp at all while a bound is set (a
   * bound demands provenance of timing). Absent + no bound = unchanged
   * behaviour.
   */
  signalTimestamp?: Date | string | null;
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
  /**
   * Foundation gate #19 — producer-supplied command provenance envelope (see
   * lib/provenance/commandProvenance.ts, the exposed helper ANY producer —
   * instant trade, agents, missions, future strategy drivers — can adopt).
   * Optional: when absent, an ENTRY draft derives its envelope honestly from
   * the routed quote at draft time (source = the router's real provenance,
   * UNKNOWN when no quote could be served — gate #19 then refuses at
   * dispatch). A malformed value is discarded, never repaired. The stored
   * envelope also rides `payload.commandProvenance`, covered by payloadHash,
   * so it cannot be forged between confirm and dispatch.
   */
  provenance?: CommandProvenanceEnvelope | null;
  /**
   * Foundation gate #20 — production_edges reference for the strategy/edge
   * that produced this command. Optional + nullable: human manual commands
   * leave it NULL (promotion not required for USER/ADMIN/OWNER actors); an
   * autonomous (SELF_TRADE_AGENT/SYSTEM) entry with NULL — or with a row not
   * promoted to owner-pressed LIVE_CANDIDATE — is REFUSED at dispatch.
   */
  edgeId?: number | null;
  /** Mission attribution for the provenance envelope (additive, optional). */
  missionId?: number | null;
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
    // never weakens/skips/ORs the 23-gate dispatch. Fires when the trader has
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
    // conservative notional-style proxy: lot * REQUIRED_MARGIN_PROXY_PER_LOT_USD
    // (module-scope const — ALSO the risk unit of the wave-4 correlation
    // cluster pre-gate, so the two can never drift). This matches a typical
    // 100:1 leveraged forex mini-lot margin envelope and refuses obviously
    // over-sized tickets (e.g. 5.0 lots on a $200 headroom). MT5 will still
    // enforce true margin server-side.
    //
    // OWNER/ADMIN UNRESTRICTED: this internal proxy is skipped. The real
    // broker-side margin check at OrderSend remains the authority for the
    // unrestricted profile, so a tiny owner ticket (e.g. 0.01 lot of a
    // synthetic) is not refused by the $1000/lot heuristic. Every other
    // pool gate above (userAvailable > 0, isOverAllocated, master cap) STILL
    // applies to the owner.
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
  // backstop and BEFORE the synthetic floor / SL policy / 23-gate evaluator —
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
    } catch (err) {
      // Quote unavailable; defer to the 16-gate + MT5 broker rejection.
      logger.warn(
        { err, userId: input.userId, symbol: input.symbol, commandType: input.commandType },
        "live-preflight: stop-loss sanity quote fetch failed (non-gating — SL sanity check skipped)",
      );
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
        } catch (err) {
          // no quote — stops/freeze legs skip, spec legs still enforce
          logger.warn(
            { err, userId: input.userId, symbol: input.symbol, commandType: input.commandType },
            "live-preflight: broker-rule guard quote fetch failed (stops/freeze legs skipped)",
          );
        }
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
    } catch (err) {
      // Resolver failure must never block a trade that would otherwise pass;
      // defer to the EA guard + MT5 broker rejection.
      logger.warn(
        { err, userId: input.userId, symbol: input.symbol, commandType: input.commandType },
        "live-preflight: broker symbol-spec resolver failed (non-gating — broker-rule guard skipped)",
      );
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
  // canonical preflight gates above and the 23-gate dispatch below remain the
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
  // pipeline + 23-gate dispatch; ONLY gate #5 (kill switch) is relaxed and ONLY
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
    // R6 — the venue, stated rather than inherited from the column default.
    // This path binds an MT5 bridgeConnectionId, so the command IS an MT5
    // command; saying so explicitly keeps the column default a historical
    // backfill instead of a silent fallback for anything that forgets.
    executionVenue: "MT5_EA_BRIDGE",
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

  // ── Foundation gate #19 — stamp the command provenance envelope ─────────
  // ENTRY drafts only (close/modify are exempt at the gate). Producer-supplied
  // envelope wins (validated strictly — a malformed one is DISCARDED, never
  // repaired); otherwise derive honestly from the routed quote at draft time:
  // the router's real SeriesProvenance origin, or UNKNOWN when no quote could
  // be served (gate #19 then refuses at dispatch — default-deny, and honesty:
  // provenance is never fabricated).
  const isEntryDraft = input.commandType === "PLACE_LIVE_MARKET_ORDER"
    || input.commandType === "PLACE_LIVE_PENDING_ORDER";
  const draftOriginActorType = input.selfTradeAgentId != null ? "SELF_TRADE_AGENT" as const : "USER" as const;
  let provenanceEnvelope: CommandProvenanceEnvelope | null =
    input.provenance != null ? parseCommandProvenanceEnvelope(input.provenance) : null;
  if (provenanceEnvelope == null && isEntryDraft) {
    let quoteSource: CommandProvenanceEnvelope["dataSource"] = "UNKNOWN";
    let quoteSourceId = `router:${input.symbol}`;
    let quoteAsOf: string | null = null;
    try {
      const { routeQuote } = await import("../data/marketDataRouter.js");
      const q = await routeQuote(input.symbol);
      if (q.ok && q.provenance) {
        quoteSource = q.provenance.source;
        quoteSourceId = q.provenance.sourceId;
        quoteAsOf = q.quote?.timestamp ?? q.provenance.receivedAt;
      }
    } catch {
      // Honest degrade: envelope stays UNKNOWN/no-asOf and gate #19 refuses.
    }
    provenanceEnvelope = buildCommandProvenanceEnvelope({
      originActorType: draftOriginActorType,
      dataSource: quoteSource,
      sourceId: quoteSourceId,
      asOf: quoteAsOf,
      selfTradeAgentId: input.selfTradeAgentId ?? null,
      selfTradeDecisionId: input.selfTradeDecisionId ?? null,
      missionId: input.missionId ?? null,
    });
  }

  // SAFETY: scrub the override key from any client-supplied payload —
  // only this server-side path may set it, and only from the dedicated
  // `input.allowNoStopLossThisDraft` argument (which itself is gated
  // by `/me/one-click/submit-live` verifying liveOneClickEnabled +
  // allowOrdersWithoutStopLoss + master-live access). A client cannot
  // smuggle the bit through `payload`. `commandProvenance` is scrubbed for
  // the same reason: only the server-built envelope above may occupy the
  // payload-hash-covered slot gate #19 trusts.
  const draftPayload: Record<string, unknown> = (() => {
    const raw = (input.payload ?? {}) as Record<string, unknown>;
    const {
      allowNoStopLossThisDraft: _stripped,
      referencePrice: _rpStripped,
      commandProvenance: _provStripped,
      ...safe
    } = raw;
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
    // Foundation gate #19 — the envelope's payload-hash-covered copy. The
    // typed provenance_envelope column mirrors it; the dispatch gate compares
    // the two so the envelope cannot be forged between confirm and dispatch.
    const withProvenance = provenanceEnvelope != null
      ? { ...withAgent, commandProvenance: provenanceEnvelope }
      : withAgent;
    return input.allowNoStopLossThisDraft === true
      ? { ...withProvenance, allowNoStopLossThisDraft: true as const }
      : withProvenance;
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
    // R6 — the venue, stated rather than inherited from the column default.
    // This path binds an MT5 bridgeConnectionId, so the command IS an MT5
    // command; saying so explicitly keeps the column default a historical
    // backfill instead of a silent fallback for anything that forgets.
    executionVenue: "MT5_EA_BRIDGE",
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
    // Foundation gates #19/#20 — typed provenance envelope (mirrors the
    // payload-hash-covered payload.commandProvenance copy) + promotion-ledger
    // reference. Both nullable + additive.
    provenanceEnvelope: provenanceEnvelope as unknown as Record<string, unknown> | null,
    edgeId: input.edgeId ?? null,
    // R3 slice 5 — signal-provenance stamp (typed column; nullable). An
    // unparseable caller value is stored as NULL — provenance is never
    // fabricated; with a max_signal_age_ms bound configured the dispatch
    // pre-gate then fail-closed refuses the entry.
    signalTimestamp: (() => {
      if (input.signalTimestamp == null) return null;
      const d = new Date(input.signalTimestamp);
      return Number.isFinite(d.getTime()) ? d : null;
    })(),
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

  // ── EMERGENCY KILL SWITCH PRE-GATE (global halt) ───────────────────────
  // Refuses dispatch while global_trading_settings.emergency_kill_switch is
  // engaged. Runs BEFORE the 23-gate evaluator in BOTH routing modes: the
  // evaluator's `globalLiveEnabled` input does NOT fold the kill switch in
  // (getEnvelope computes it from platformMode + liveEnabled alone), so
  // without this pre-gate a USER_OWNED_MT5 dispatch passes all 23 gates
  // during a platform-wide halt. Additive only — never replaces or weakens
  // any downstream gate. Fail-closed: on a missing/unreadable settings row
  // the envelope reports emergencyKillSwitch=true (FAIL_CLOSED). The ONLY
  // exemption is the Task #743 Cluster D admin-emergency-close CLOSE marker
  // (already verified by the command-integrity pre-gate above), mirroring
  // the narrow gate-#5 relaxation so an operator can still flatten exposure
  // while the platform is halted.
  {
    const hasKillSwitchCloseBypassMarker =
      row.payload != null
      && typeof row.payload === "object"
      && (row.payload as { killSwitchCloseBypass?: unknown }).killSwitchCloseBypass != null;
    if (emergencyKillSwitchBlocksDispatch({
      emergencyKillSwitch: env.emergencyKillSwitch,
      commandType: row.commandType,
      hasKillSwitchCloseBypassMarker,
    })) {
      const reason = EMERGENCY_KILL_SWITCH_BLOCK_REASON;
      const [blocked] = await db.update(arxLiveCommandsTable).set({
        status: "LIVE_BLOCKED",
        rejectionReason: reason,
        rejectedAt: new Date(),
        dispatchGateSnapshot: {
          decision: "BLOCKED",
          primaryReason: reason,
          blockReasons: [reason, "BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED"],
          emergencyKillSwitchGate: true,
          at: new Date().toISOString(),
        } as unknown as Record<string, unknown>,
      }).where(eq(arxLiveCommandsTable.commandId, args.commandId)).returning();
      await audit({
        eventType: "EMERGENCY_KILL_SWITCH_BLOCKED", severity: "HIGH",
        userId: args.userId, symbol: row.symbol,
        message: `Live dispatch BLOCKED by emergency kill switch: ${reason}`,
        metadata: { commandId: args.commandId, commandType: row.commandType },
      });
      logger.warn({
        [PHASE_B_LIVE_LOG_PREFIX]: true,
        event: "EMERGENCY_KILL_SWITCH_BLOCKED",
        commandId: args.commandId, userId: args.userId, primaryReason: reason,
      }, "Emergency kill switch blocked live dispatch");
      return { ok: false as const, reason: "LIVE_BLOCKED" as const,
        primaryReason: reason, blockReasons: [reason], command: blocked };
    }
  }

  // ── RISK-LOCK PRE-GATE (R3 slice 2) ────────────────────────────────────
  // Gives risk_locks its first live-path teeth: an ACTIVE, unexpired row
  // refuses ENTRY dispatch with LIVE_BLOCKED:RISK_LOCK_<TYPE>. Runs BEFORE
  // the 23-gate evaluator in BOTH routing modes; additive only — never
  // replaces or weakens any downstream gate. CLOSE_LIVE_POSITION /
  // MODIFY_LIVE_SLTP always pass (entry-vs-ops split mirroring the
  // allocation-freeze `tradingFrozen` rule — a lock must never trap open
  // exposure). Row scope: this user's rows PLUS legacy ownerless rows
  // (user_id IS NULL predates the Phase-2 ownership column; the paper path
  // in routes/permission.ts applies active locks with no ownership filter,
  // so the live path must not silently exempt those rows). Active-ness
  // (isActive + expiry vs end_time) is decided by the pure helper so the
  // contract is unit-tested in one place.
  if (row.commandType === "PLACE_LIVE_MARKET_ORDER"
    || row.commandType === "PLACE_LIVE_PENDING_ORDER") {
    const { riskLocksTable } = await import("@workspace/db");
    const lockRows = await db.select({
      lockType: riskLocksTable.lockType,
      isActive: riskLocksTable.isActive,
      endTime: riskLocksTable.endTime,
    }).from(riskLocksTable).where(and(
      eq(riskLocksTable.isActive, true),
      sql`(${riskLocksTable.userId} = ${args.userId} OR ${riskLocksTable.userId} IS NULL)`,
    ));
    const lockReason = activeRiskLockBlockReason({
      locks: lockRows,
      isEntryCommand: true,
    });
    if (lockReason != null) {
      const [blocked] = await db.update(arxLiveCommandsTable).set({
        status: "LIVE_BLOCKED",
        rejectionReason: lockReason,
        rejectedAt: new Date(),
        dispatchGateSnapshot: {
          decision: "BLOCKED",
          primaryReason: lockReason,
          blockReasons: [lockReason, "BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED"],
          riskLockGate: true,
          at: new Date().toISOString(),
        } as unknown as Record<string, unknown>,
      }).where(eq(arxLiveCommandsTable.commandId, args.commandId)).returning();
      await audit({
        eventType: "RISK_LOCK_BLOCKED", severity: "HIGH",
        userId: args.userId, symbol: row.symbol,
        message: `Live dispatch BLOCKED by active risk lock: ${lockReason}`,
        metadata: { commandId: args.commandId, commandType: row.commandType },
      });
      logger.warn({
        [PHASE_B_LIVE_LOG_PREFIX]: true,
        event: "RISK_LOCK_BLOCKED",
        commandId: args.commandId, userId: args.userId, primaryReason: lockReason,
      }, "Active risk lock blocked live dispatch");
      return { ok: false as const, reason: "LIVE_BLOCKED" as const,
        primaryReason: lockReason, blockReasons: [lockReason], command: blocked };
    }
  }

  // ── CLOSE-ONLY PRE-GATE (spec §3.1 / §20) ──────────────────────────────
  // user_slot_allocation.close_only_mode was persisted and surfaced to admin
  // UI but never read by any dispatch path — the schema said so outright
  // ("future hook ... Not enforced yet"). Spec §3.1 lists close-only as a
  // global control and §20 requires it PROVEN, so it now refuses ENTRY
  // dispatch. Entry-only: closes and SL/TP edits must always survive, or the
  // control would trap the exposure it exists to wind down. Additive — the
  // flag defaults false, so enabling enforcement changes nothing until an
  // operator sets it, and it can only ever refuse, never permit.
  if (row.commandType === "PLACE_LIVE_MARKET_ORDER"
    || row.commandType === "PLACE_LIVE_PENDING_ORDER") {
    const { userSlotAllocationTable: _closeOnlyAllocTable } = await import("@workspace/db");
    const closeOnlyRows = await db.select({
      closeOnlyMode: _closeOnlyAllocTable.closeOnlyMode,
    }).from(_closeOnlyAllocTable)
      .where(eq(_closeOnlyAllocTable.userId, args.userId)).limit(1);
    if (closeOnlyBlocksDispatch({
      closeOnlyMode: closeOnlyRows[0]?.closeOnlyMode,
      isEntryCommand: true,
    })) {
      const [blocked] = await db.update(arxLiveCommandsTable).set({
        status: "LIVE_BLOCKED",
        rejectionReason: CLOSE_ONLY_BLOCK_REASON,
        rejectedAt: new Date(),
        dispatchGateSnapshot: {
          decision: "BLOCKED",
          primaryReason: CLOSE_ONLY_BLOCK_REASON,
          blockReasons: [CLOSE_ONLY_BLOCK_REASON, "BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED"],
          closeOnlyGate: true,
          at: new Date().toISOString(),
        } as unknown as Record<string, unknown>,
      }).where(eq(arxLiveCommandsTable.commandId, args.commandId)).returning();
      await audit({
        eventType: "CLOSE_ONLY_MODE_BLOCKED", severity: "HIGH",
        userId: args.userId, symbol: row.symbol,
        message: "Live ENTRY dispatch BLOCKED by close-only mode; closes and SL/TP edits remain allowed",
        metadata: { commandId: args.commandId, commandType: row.commandType },
      });
      logger.warn({
        [PHASE_B_LIVE_LOG_PREFIX]: true,
        event: "CLOSE_ONLY_MODE_BLOCKED",
        commandId: args.commandId, userId: args.userId,
      }, "Close-only mode blocked live entry dispatch");
      return { ok: false as const, reason: "LIVE_BLOCKED" as const,
        primaryReason: CLOSE_ONLY_BLOCK_REASON,
        blockReasons: [CLOSE_ONLY_BLOCK_REASON], command: blocked };
    }
  }

  // ── WAVE-4 PRE-GATES (R3 slices 4/5 + correlation guard + R4 slice 3) ───
  // Four additive, ENTRY-ONLY refusal walls, ordered AFTER the risk-lock
  // pre-gate above and BEFORE the 23-gate evaluator below (source order is
  // pinned by preGateWave4.test.ts; the pure 23-gate contract file is
  // untouched). Each follows the established pre-gate shape: pure-helper
  // decision → LIVE_BLOCKED row + dispatchGateSnapshot + audit +
  // kill-switch-style typed return. CLOSE_LIVE_POSITION / MODIFY_LIVE_SLTP
  // pass every one of them (never trap open exposure — the same
  // entry-vs-ops split the risk-lock gate applies).
  const isWave4EntryCommand = row.commandType === "PLACE_LIVE_MARKET_ORDER"
    || row.commandType === "PLACE_LIVE_PENDING_ORDER";

  // ── PRICE-COLLAR PRE-GATE (R3 slice 4) ─────────────────────────────────
  // Runs only when the user demanded a server-side collar (cap non-null);
  // otherwise slippage stays delegated to the EA exactly as before.
  if (isWave4EntryCommand && settings.maxEntryDeviationBps != null) {
    // Draft-time approved price: the SAME payload.referencePrice the draft
    // stamped for the EA's deviation guard (set only from the typed
    // server-side argument; client payloads are scrubbed at draft).
    const draftRefRaw = (row.payload as Record<string, unknown> | null)?.["referencePrice"];
    const requestedPrice = typeof draftRefRaw === "number" ? draftRefRaw : null;
    // Dispatch-time reference from the execution broker feed — the same
    // getLiveQuote provider chain the preflight quote legs read. With a cap
    // SET, a fetch failure leaves the reference null and the pure helper
    // refuses (fail-CLOSED — deliberately unlike the advisory preflight
    // SL-sanity legs, which skip on a failed quote: a demanded collar must
    // never be silently skipped).
    let dispatchReferencePrice: number | null = null;
    try {
      const { getMarketProvider } = await import("../assistant/marketProvider.js");
      const q = await getMarketProvider().getLiveQuote(row.symbol);
      const ref = row.side === "BUY" ? (q.ask ?? q.price) : (q.bid ?? q.price);
      dispatchReferencePrice =
        typeof ref === "number" && Number.isFinite(ref) && ref > 0 ? ref : null;
    } catch (err) {
      logger.warn(
        { err, userId: args.userId, symbol: row.symbol, commandId: args.commandId },
        "live-dispatch: price-collar reference quote fetch failed — collar is fail-closed (entry will refuse)",
      );
    }
    if (priceCollarBlocksDispatch({
      maxEntryDeviationBps: Number(settings.maxEntryDeviationBps),
      requestedPrice,
      referencePrice: dispatchReferencePrice,
      side: row.side as "BUY" | "SELL",
      isEntryCommand: true,
    })) {
      const reason = PRICE_DEVIATION_BLOCK_REASON;
      const [blocked] = await db.update(arxLiveCommandsTable).set({
        status: "LIVE_BLOCKED",
        rejectionReason: reason,
        rejectedAt: new Date(),
        dispatchGateSnapshot: {
          decision: "BLOCKED",
          primaryReason: reason,
          blockReasons: [reason, "BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED"],
          priceCollarGate: true,
          maxEntryDeviationBps: Number(settings.maxEntryDeviationBps),
          requestedPrice,
          dispatchReferencePrice,
          at: new Date().toISOString(),
        } as unknown as Record<string, unknown>,
      }).where(eq(arxLiveCommandsTable.commandId, args.commandId)).returning();
      await audit({
        eventType: "PRICE_COLLAR_BLOCKED", severity: "HIGH",
        userId: args.userId, symbol: row.symbol,
        message: `Live dispatch BLOCKED by price collar: ${reason}`,
        metadata: {
          commandId: args.commandId, commandType: row.commandType,
          maxEntryDeviationBps: Number(settings.maxEntryDeviationBps),
          requestedPrice, dispatchReferencePrice,
        },
      });
      logger.warn({
        [PHASE_B_LIVE_LOG_PREFIX]: true,
        event: "PRICE_COLLAR_BLOCKED",
        commandId: args.commandId, userId: args.userId, primaryReason: reason,
      }, "Price collar blocked live dispatch");
      return { ok: false as const, reason: "LIVE_BLOCKED" as const,
        primaryReason: reason, blockReasons: [reason], command: blocked };
    }
  }

  // ── SIGNAL-AGE PRE-GATE (R3 slice 5) ───────────────────────────────────
  // Refuses entries whose signal_timestamp is older than the user's
  // max_signal_age_ms bound; with a bound set, a missing stamp refuses
  // fail-closed (a bound demands provenance of timing). No bound = skipped.
  if (isWave4EntryCommand) {
    if (signalAgeBlocksDispatch({
      maxSignalAgeMs: settings.maxSignalAgeMs,
      signalTimestamp: row.signalTimestamp,
      isEntryCommand: true,
    })) {
      const reason = SIGNAL_TOO_OLD_BLOCK_REASON;
      const [blocked] = await db.update(arxLiveCommandsTable).set({
        status: "LIVE_BLOCKED",
        rejectionReason: reason,
        rejectedAt: new Date(),
        dispatchGateSnapshot: {
          decision: "BLOCKED",
          primaryReason: reason,
          blockReasons: [reason, "BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED"],
          signalAgeGate: true,
          maxSignalAgeMs: settings.maxSignalAgeMs,
          signalTimestamp: row.signalTimestamp != null
            ? new Date(row.signalTimestamp).toISOString() : null,
          at: new Date().toISOString(),
        } as unknown as Record<string, unknown>,
      }).where(eq(arxLiveCommandsTable.commandId, args.commandId)).returning();
      await audit({
        eventType: "SIGNAL_AGE_BLOCKED", severity: "HIGH",
        userId: args.userId, symbol: row.symbol,
        message: `Live dispatch BLOCKED by signal age: ${reason}`,
        metadata: {
          commandId: args.commandId, commandType: row.commandType,
          maxSignalAgeMs: settings.maxSignalAgeMs,
          signalTimestamp: row.signalTimestamp != null
            ? new Date(row.signalTimestamp).toISOString() : null,
        },
      });
      logger.warn({
        [PHASE_B_LIVE_LOG_PREFIX]: true,
        event: "SIGNAL_AGE_BLOCKED",
        commandId: args.commandId, userId: args.userId, primaryReason: reason,
      }, "Signal age blocked live dispatch");
      return { ok: false as const, reason: "LIVE_BLOCKED" as const,
        primaryReason: reason, blockReasons: [reason], command: blocked };
    }
  }

  // ── CORRELATION-CLUSTER PRE-GATE (wires R3 slice 6's pure core) ────────
  // Runs only when the user configured at least one cluster cap. Candidate
  // risk uses the SAME conservative USD proxy the allocation headroom
  // pre-gate derives per trade (lots × REQUIRED_MARGIN_PROXY_PER_LOT_USD);
  // clustered exposure re-reads the same open-position + in-flight rows the
  // per-user exposure gate counts (open arx_live_positions PLUS
  // SENT_TO_MT5_LIVE commands, closing the same TOCTOU window: two parallel
  // dispatches must not both pass the cluster cap before either reaches the
  // EA). The pure evaluator decides — including its fail-closed validation
  // refusals (a corrupt row must never silently create capacity).
  if (isWave4EntryCommand
    && (settings.maxClusterRiskUsd != null || settings.maxClusterPositions != null)) {
    const clusterOpenPositions = await db.select({
      symbol: arxLivePositionsTable.symbol,
      side: arxLivePositionsTable.side,
      volume: arxLivePositionsTable.volume,
    }).from(arxLivePositionsTable).where(and(
      eq(arxLivePositionsTable.userId, args.userId),
      isNull(arxLivePositionsTable.closedAt),
    ));
    const clusterInFlight = await db.select({
      symbol: arxLiveCommandsTable.symbol,
      side: arxLiveCommandsTable.side,
      volume: arxLiveCommandsTable.requestedVolume,
    }).from(arxLiveCommandsTable).where(and(
      eq(arxLiveCommandsTable.userId, args.userId),
      eq(arxLiveCommandsTable.status, "SENT_TO_MT5_LIVE"),
      isNull(arxLiveCommandsTable.filledAt),
      isNull(arxLiveCommandsTable.rejectedAt),
    ));
    const clusterBlock = clusterExposureBlockReason({
      candidate: {
        symbol: row.symbol,
        side: row.side,
        riskAmount: Number(row.requestedVolume) * REQUIRED_MARGIN_PROXY_PER_LOT_USD,
      },
      openPositions: [...clusterOpenPositions, ...clusterInFlight].map((p) => ({
        symbol: p.symbol,
        side: p.side,
        riskAmount: Number(p.volume ?? 0) * REQUIRED_MARGIN_PROXY_PER_LOT_USD,
      })),
      maxClusterRiskUsd: settings.maxClusterRiskUsd,
      maxClusterPositions: settings.maxClusterPositions,
      isEntryCommand: true,
    });
    if (clusterBlock != null) {
      const reason = clusterBlock.reason;
      const [blocked] = await db.update(arxLiveCommandsTable).set({
        status: "LIVE_BLOCKED",
        rejectionReason: reason,
        rejectedAt: new Date(),
        dispatchGateSnapshot: {
          decision: "BLOCKED",
          primaryReason: reason,
          blockReasons: [reason, "BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED"],
          clusterExposureGate: true,
          clusterKey: clusterBlock.evaluation.clusterKey,
          clusterRisk: clusterBlock.evaluation.clusterRisk,
          clusterCount: clusterBlock.evaluation.clusterCount,
          maxClusterRiskUsd: settings.maxClusterRiskUsd,
          maxClusterPositions: settings.maxClusterPositions,
          at: new Date().toISOString(),
        } as unknown as Record<string, unknown>,
      }).where(eq(arxLiveCommandsTable.commandId, args.commandId)).returning();
      await audit({
        eventType: "CLUSTER_EXPOSURE_BLOCKED", severity: "HIGH",
        userId: args.userId, symbol: row.symbol,
        message: `Live dispatch BLOCKED by correlation-cluster guard: ${reason}`,
        metadata: {
          commandId: args.commandId, commandType: row.commandType,
          clusterKey: clusterBlock.evaluation.clusterKey,
          clusterRisk: clusterBlock.evaluation.clusterRisk,
          clusterCount: clusterBlock.evaluation.clusterCount,
          maxClusterRiskUsd: settings.maxClusterRiskUsd,
          maxClusterPositions: settings.maxClusterPositions,
        },
      });
      logger.warn({
        [PHASE_B_LIVE_LOG_PREFIX]: true,
        event: "CLUSTER_EXPOSURE_BLOCKED",
        commandId: args.commandId, userId: args.userId, primaryReason: reason,
      }, "Correlation-cluster guard blocked live dispatch");
      return { ok: false as const, reason: "LIVE_BLOCKED" as const,
        primaryReason: reason, blockReasons: [reason], command: blocked };
    }
  }

  // ── BROKER-CONFIRMED-FEED PRE-GATE (R4 slice 3 — now ENFORCING) ────────
  // Feed facts are resolved fail-honest (errors / timeouts / no candles ⇒
  // AWAITING ⇒ not confirmed — resolveBrokerConfirmedFeed never throws); the
  // pure evaluateLiveEntryFeedGate predicate decides. Bridge binding is
  // deliberately NOT passed: this pre-gate runs before bridge selection, in
  // the predicate's documented feed-confirmation-only mode. Enforcement is
  // default-ON (env absent enforces); an explicit disable value logs the
  // violation observe-only (plus the startup override notice at module init).
  // Close/modify are exempt both here (isWave4EntryCommand) and inside the
  // predicate's own intent split.
  if (isWave4EntryCommand) {
    const feed = await resolveBrokerConfirmedFeed(row.symbol);
    const feedGate = evaluateLiveEntryFeedGate({
      intent: "ENTRY",
      verdict: feed.verdict,
      source: feed.feedSource,
      derivBacked: feed.derivBacked,
      enforceEnvValue: process.env[BROKER_FEED_GATE_ENV] ?? null,
    });
    if (!feedGate.allowed) {
      // Without bridge binding the only reachable refusal is
      // BROKER_FEED_NOT_CONFIRMED; the composition stays general so a future
      // bridge-bound caller cannot silently mislabel a different violation.
      const reason = feedGate.refusalCode === "BROKER_FEED_NOT_CONFIRMED"
        ? BROKER_FEED_BLOCK_REASON
        : `LIVE_BLOCKED:${feedGate.refusalCode}`;
      const [blocked] = await db.update(arxLiveCommandsTable).set({
        status: "LIVE_BLOCKED",
        rejectionReason: reason,
        rejectedAt: new Date(),
        dispatchGateSnapshot: {
          decision: "BLOCKED",
          primaryReason: reason,
          blockReasons: [reason, "BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED"],
          brokerFeedGate: true,
          feedVerdict: feed.verdict,
          feedSource: feed.feedSource,
          derivBacked: feed.derivBacked,
          lastCandleAt: feed.lastCandleAt,
          detail: feedGate.detail,
          at: new Date().toISOString(),
        } as unknown as Record<string, unknown>,
      }).where(eq(arxLiveCommandsTable.commandId, args.commandId)).returning();
      await audit({
        eventType: "BROKER_FEED_BLOCKED", severity: "HIGH",
        userId: args.userId, symbol: row.symbol,
        message: `Live dispatch BLOCKED by broker-confirmed-feed gate: ${reason}`,
        metadata: {
          commandId: args.commandId, commandType: row.commandType,
          feedVerdict: feed.verdict, feedSource: feed.feedSource,
          derivBacked: feed.derivBacked,
        },
      });
      logger.warn({
        [PHASE_B_LIVE_LOG_PREFIX]: true,
        event: "BROKER_FEED_BLOCKED",
        commandId: args.commandId, userId: args.userId, primaryReason: reason,
      }, "Broker-confirmed-feed gate blocked live dispatch");
      return { ok: false as const, reason: "LIVE_BLOCKED" as const,
        primaryReason: reason, blockReasons: [reason], command: blocked };
    }
    if (feedGate.violation != null) {
      // Enforcement explicitly disabled — observe-only parity: the violation
      // is still named so the override can never hide a bad feed silently.
      logger.warn({
        [PHASE_B_LIVE_LOG_PREFIX]: true,
        event: "BROKER_FEED_VIOLATION_OBSERVED",
        commandId: args.commandId, userId: args.userId,
        violation: feedGate.violation, feedVerdict: feed.verdict,
        feedSource: feed.feedSource, envVar: BROKER_FEED_GATE_ENV,
      }, "Broker-feed violation observed but enforcement is explicitly disabled — entry NOT blocked");
    }
  }

  // ── RECONCILIATION-FRESHNESS PRE-GATE (R2-S4, flag-staged, default OFF) ──
  // See the module-scope constants above for the full staging rationale.
  // ENTRY-ONLY, additive: runs after the broker-feed pre-gate and BEFORE the
  // 23-gate evaluator; never replaces or weakens any downstream gate. The
  // run row is read with raw parameterized SQL for the same reason the
  // reconciler writes it that way: the reconciliation_runs registration is
  // coordinator-owned and the table may not exist yet — with the flag ON, an
  // unreadable table degrades to "no run", which is the fail-closed
  // direction (an operator who demanded proof must not trade without it).
  if (isWave4EntryCommand
    && reconciliationFreshnessGateEnabled(process.env[RECONCILIATION_FRESHNESS_GATE_ENV])) {
    const maxAgeMs = resolveReconciliationMaxAgeMs(process.env[RECONCILIATION_MAX_AGE_ENV]);
    let freshnessRunRow: ReconciliationRunRowLike | null = null;
    let runReadError: string | null = null;
    try {
      // Newest run covering this user: a user-scoped run (user_id = X) or a
      // bridge-wide run (user_id NULL) both qualify. id DESC = insertion order.
      const res = await db.execute(sql`
        select status, completed_at, positions_match, orders_match
          from reconciliation_runs
         where user_id = ${args.userId} or user_id is null
         order by id desc
         limit 1
      `);
      const rows = (res as unknown as { rows?: Array<Record<string, unknown>> }).rows ?? [];
      const r0 = rows[0];
      if (r0 != null) {
        freshnessRunRow = {
          status: (r0["status"] ?? null) as string | null,
          completedAt: (r0["completed_at"] ?? null) as Date | string | null,
          positionsMatch: (r0["positions_match"] ?? null) as boolean | null,
          ordersMatch: (r0["orders_match"] ?? null) as boolean | null,
        };
      }
    } catch (e) {
      runReadError = e instanceof Error ? e.message : String(e);
    }
    // Dynamic value import — unknownReconciler statically imports this
    // module's pure helpers; a static value import here would be a cycle.
    const { reconciliationFreshnessVerdict } = await import("./unknownReconciler.js");
    const verdict = reconciliationFreshnessVerdict(freshnessRunRow, maxAgeMs);
    const freshnessBlockReason = reconciliationGateBlockReason(verdict);
    if (freshnessBlockReason != null) {
      const reason = freshnessBlockReason;
      const [blocked] = await db.update(arxLiveCommandsTable).set({
        status: "LIVE_BLOCKED",
        rejectionReason: reason,
        rejectedAt: new Date(),
        dispatchGateSnapshot: {
          decision: "BLOCKED",
          primaryReason: reason,
          blockReasons: [reason, "BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED"],
          reconciliationFreshnessGate: true,
          freshnessReason: verdict.reason,
          runAgeMs: verdict.ageMs,
          maxAgeMs,
          runReadError,
          at: new Date().toISOString(),
        } as unknown as Record<string, unknown>,
      }).where(eq(arxLiveCommandsTable.commandId, args.commandId)).returning();
      await audit({
        eventType: "RECONCILIATION_FRESHNESS_BLOCKED", severity: "HIGH",
        userId: args.userId, symbol: row.symbol,
        message: `Live dispatch BLOCKED by reconciliation-freshness gate: ${reason}`,
        metadata: {
          commandId: args.commandId, commandType: row.commandType,
          freshnessReason: verdict.reason, runAgeMs: verdict.ageMs,
          maxAgeMs, runReadError,
        },
      });
      logger.warn({
        [PHASE_B_LIVE_LOG_PREFIX]: true,
        event: "RECONCILIATION_FRESHNESS_BLOCKED",
        commandId: args.commandId, userId: args.userId,
        primaryReason: reason, freshnessReason: verdict.reason,
        runAgeMs: verdict.ageMs, maxAgeMs, runReadError,
      }, "Reconciliation-freshness gate blocked live dispatch");
      return { ok: false as const, reason: "LIVE_BLOCKED" as const,
        primaryReason: reason, blockReasons: [reason], command: blocked };
    }
  }

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
  // floor and the 23-gate evaluator, all of which still run and keep final say.
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

  // ── WEEKLY DRAWDOWN CEILING PRE-GATE (R3 slice 1) ──────────────────────
  // First reader of arx_live_user_settings.weekly_drawdown_ceiling_pct.
  // Week-to-date loss is composed EXACTLY like the daily snapshot above —
  // open negative floating P/L + realised negative P/L on positions closed
  // inside the window — over a ROLLING 7-day window (spec check #21 asks
  // for rolling drawdown, not a calendar week), so the daily "close losers
  // and re-trade" bypass stays closed here too. The ceiling is a
  // percentage while the daily cap is absolute USD, so no shared pct
  // reference exists; reference equity is resolved per user:
  // user_slot_allocation.allocated_funds when a funded slot exists
  // (SHARED_MASTER_MT5 — the master bridge's equity is the whole pool,
  // never one user's slice), else the dispatch bridge's heartbeat
  // account_equity (USER_OWNED_MT5 — the user's own account truth).
  // T019 — under owner/admin governance mode the settings-tier caps are
  // replaced by governance (which has no weekly field), mirroring the
  // dailyLossLimitUsd input swap below, so the pre-gate does not run.
  // ENTRY-ONLY + fail-open ONLY on unset/zero ceiling + fail-closed on
  // unresolvable reference/loss — all decided by the pure helper.
  {
    const weeklyCeilingPct = useGovernanceDispatch
      ? 0
      : Number(settings.weeklyDrawdownCeilingPct ?? 0);
    if (isEntryRow && weeklyCeilingPct !== 0) {
      const weekWindowStart = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const closedWeekLossRows = await db.select({
        totalNegRealised: sql<number>`COALESCE(SUM(CASE WHEN ${arxLivePositionsTable.floatingPl} < 0 THEN ${arxLivePositionsTable.floatingPl} ELSE 0 END), 0)`,
      }).from(arxLivePositionsTable).where(and(
        eq(arxLivePositionsTable.userId, args.userId),
        sql`${arxLivePositionsTable.closedAt} IS NOT NULL`,
        sql`${arxLivePositionsTable.closedAt} >= ${weekWindowStart.toISOString()}`,
      ));
      const realisedWeeklyLossUsd =
        Math.abs(Number(openLossRows[0]?.totalNegFloat ?? 0)) +
        Math.abs(Number(closedWeekLossRows[0]?.totalNegRealised ?? 0));
      const { userSlotAllocationTable: slotAllocForWeekly } = await import("@workspace/db");
      const weeklyAllocRows = await db.select({
        allocatedFunds: slotAllocForWeekly.allocatedFunds,
      }).from(slotAllocForWeekly)
        .where(eq(slotAllocForWeekly.userId, args.userId)).limit(1);
      const allocatedFunds = Number(weeklyAllocRows[0]?.allocatedFunds ?? 0);
      const bridgeEquity = Number(bridge?.accountEquity ?? 0);
      const referenceEquityUsd = allocatedFunds > 0
        ? allocatedFunds
        : (bridgeEquity > 0 ? bridgeEquity : null);
      if (weeklyDrawdownBlocksDispatch({
        weeklyDrawdownCeilingPct: weeklyCeilingPct,
        referenceEquityUsd,
        realisedWeeklyLossUsd,
        isEntryCommand: true,
      })) {
        const reason = WEEKLY_DRAWDOWN_BLOCK_REASON;
        const [blocked] = await db.update(arxLiveCommandsTable).set({
          status: "LIVE_BLOCKED",
          rejectionReason: reason,
          rejectedAt: new Date(),
          dispatchGateSnapshot: {
            decision: "BLOCKED",
            primaryReason: reason,
            blockReasons: [reason, "BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED"],
            weeklyDrawdownGate: true,
            weeklyDrawdownCeilingPct: weeklyCeilingPct,
            referenceEquityUsd,
            realisedWeeklyLossUsd,
            at: new Date().toISOString(),
          } as unknown as Record<string, unknown>,
        }).where(eq(arxLiveCommandsTable.commandId, args.commandId)).returning();
        await audit({
          eventType: "WEEKLY_DRAWDOWN_BLOCKED", severity: "HIGH",
          userId: args.userId, symbol: row.symbol,
          message: `Live dispatch BLOCKED by weekly drawdown ceiling: ${reason}`,
          metadata: {
            commandId: args.commandId, commandType: row.commandType,
            weeklyDrawdownCeilingPct: weeklyCeilingPct,
            referenceEquityUsd, realisedWeeklyLossUsd,
          },
        });
        logger.warn({
          [PHASE_B_LIVE_LOG_PREFIX]: true,
          event: "WEEKLY_DRAWDOWN_BLOCKED",
          commandId: args.commandId, userId: args.userId, primaryReason: reason,
        }, "Weekly drawdown ceiling blocked live dispatch");
        return { ok: false as const, reason: "LIVE_BLOCKED" as const,
          primaryReason: reason, blockReasons: [reason], command: blocked };
      }
    }
  }

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
  // runs BEFORE — and never in place of — the 23-gate evaluator below. A
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
  // full 23-gate evaluator otherwise runs unchanged, so any other failing gate
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

  // ── Capability #49 — management-authority arbitration (deterministic,
  // journaled). When THIS command manages an open position (CLOSE/MODIFY by
  // brokerTicket) while another in-flight command already claims the same
  // position, the pure arbiter (@workspace/domain live-position) adjudicates:
  // risk-reduction dominates, the human user dominates automation, ties go to
  // the earlier claim. REFUSE-ONLY: the loser here is only ever the INCOMING
  // command, and an incoming risk-reducing CLOSE is never trapped (it
  // proceeds with the adjudication journaled as an advisory). Every
  // arbitration is journaled to the live audit ledger.
  {
    const { evaluateManagementAuthority, MANAGEMENT_AUTHORITY_CONTENTION } =
      await import("./managementAuthorityService.js");
    const authority = await evaluateManagementAuthority({
      commandId: args.commandId,
      userId: args.userId,
      commandType: row.commandType,
      actorType: row.actorType ?? null,
      createdAt: row.createdAt ?? null,
      payload: row.payload ?? null,
    });
    if (authority.outcome === "PROCEED" || authority.outcome === "PROCEED_ADVISORY"
      || authority.outcome === "REFUSE") {
      await audit({
        eventType: "MANAGEMENT_AUTHORITY_ARBITRATED",
        severity: authority.outcome === "REFUSE" ? "HIGH" : "INFO",
        userId: args.userId, symbol: row.symbol,
        message: `Management-authority arbitration (${authority.outcome}) for ${args.commandId}: `
          + `rule=${authority.decision.rule} winner=${authority.decision.journal.winnerCommandId ?? "none"}`,
        metadata: { commandId: args.commandId, ...authority.decision.journal },
      });
    }
    if (authority.outcome === "REFUSE") {
      const [blocked] = await db.update(arxLiveCommandsTable).set({
        status: "LIVE_BLOCKED",
        rejectionReason: MANAGEMENT_AUTHORITY_CONTENTION,
        rejectedAt: new Date(),
        dispatchGateSnapshot: {
          managementAuthority: authority.decision.journal,
          evaluatedAt: new Date().toISOString(),
        } as unknown as Record<string, unknown>,
      }).where(eq(arxLiveCommandsTable.commandId, args.commandId)).returning();
      logger.warn({
        [PHASE_B_LIVE_LOG_PREFIX]: true,
        event: "LIVE_DISPATCH_BLOCKED",
        commandId: args.commandId, userId: args.userId,
        primaryReason: MANAGEMENT_AUTHORITY_CONTENTION,
        rule: authority.decision.rule,
      }, "Phase B dispatch blocked: management-authority contention lost");
      return { ok: false as const, reason: MANAGEMENT_AUTHORITY_CONTENTION, command: blocked };
    }
    if (authority.outcome === "LOOKUP_FAILED" && !authority.riskReducing) {
      // Contention state UNKNOWN for a non-risk-reducing management command:
      // default-deny toward action. (A risk-reducing CLOSE proceeds — a read
      // failure must never trap a close.)
      const { MANAGEMENT_AUTHORITY_LOOKUP_FAILED } =
        await import("./managementAuthorityService.js");
      const [blocked] = await db.update(arxLiveCommandsTable).set({
        status: "LIVE_BLOCKED",
        rejectionReason: MANAGEMENT_AUTHORITY_LOOKUP_FAILED,
        rejectedAt: new Date(),
      }).where(eq(arxLiveCommandsTable.commandId, args.commandId)).returning();
      await audit({
        eventType: "LIVE_DISPATCH_BLOCKED", severity: "HIGH",
        userId: args.userId, symbol: row.symbol,
        message: `Live dispatch BLOCKED: ${MANAGEMENT_AUTHORITY_LOOKUP_FAILED} (contention state unknown)`,
        metadata: { commandId: args.commandId, blockReasons: [MANAGEMENT_AUTHORITY_LOOKUP_FAILED] },
      });
      return { ok: false as const, reason: MANAGEMENT_AUTHORITY_LOOKUP_FAILED, command: blocked };
    }
  }

  // ── Foundation gates #19–#23 — assemble dispatch-time inputs ───────────
  // Provenance (typed column vs payload-hash-covered copy), promotion-ledger
  // state (production_edges, read-only), capital-tier exposure facts, the
  // tenant-context ownership stamps (#22), and the edge-capacity facts (#23).
  // Assembled HERE (dispatch time, not draft time) so revocations/retirements
  // between draft and dispatch are honoured, exactly like every other
  // evaluator input. Every unresolvable fact arrives as the honest "unknown"
  // and the pure gates fail CLOSED for entries.
  const foundationInputs = await buildFoundationGateInputs({
    userId: args.userId,
    row: {
      commandType: row.commandType,
      symbol: row.symbol,
      requestedVolume: Number(row.requestedVolume),
      actorType: row.actorType ?? null,
      provenanceEnvelope: row.provenanceEnvelope ?? null,
      edgeId: row.edgeId ?? null,
      payload: row.payload ?? null,
      // #22 — the owner AS THE ROW ITSELF STATES IT (never echoed from args).
      ownerUserId: row.userId ?? null,
    },
    // #22 — tenant stamps for the scoped facts THIS function read before the
    // evaluator runs. Each stamp is written beside its own query: the command
    // row was loaded scoped by args.userId (loadOwned), and the arming/kill-
    // switch row was loaded scoped by args.userId (getMyArming).
    extraTenantStamps: [
      {
        fact: "live_command_row",
        scopedToUserId: args.userId,
        rowOwnerUserIds: [row.userId],
      },
      {
        fact: "live_arming_kill_switch",
        scopedToUserId: args.userId,
        rowOwnerUserIds: arming ? [arming.userId] : [],
      },
    ],
  });

  // Capability #52 — compliance-eligibility consult, assembled at DISPATCH
  // time (like every other evaluator input) so a review revoked between draft
  // and dispatch is honoured. Fail-closed: no broker_eligibility review, a
  // READ_ONLY posture, unknown funds provenance, or a failed read all refuse
  // INSIDE gate #3 (USER_NOT_LIVE_APPROVED) — deliberately not a new gate key.
  // CLOSE-PATH POSTURE: for exactly CLOSE_LIVE_POSITION a refusal is degraded
  // to advisory (recorded in the gate readout + logged loudly, not blocking)
  // so a compliance hold can never trap an open position — mirrors the
  // kill-switch emergency-CLOSE exemption and the management-authority
  // advisory degradation for risk-reducing closes. Entries and MODIFY stay
  // fully blocked.
  const complianceEligibility = await (async () => {
    const { buildComplianceEligibilityVerdict, complianceVerdictForCommand } =
      await import("./complianceDispatchInput.js");
    const raw = await buildComplianceEligibilityVerdict(args.userId);
    const effective = complianceVerdictForCommand(raw, row.commandType);
    if (!effective.allowed && effective.advisoryOnly === true) {
      logger.warn({
        [PHASE_B_LIVE_LOG_PREFIX]: true,
        event: "COMPLIANCE_REFUSAL_ADVISORY_FOR_CLOSE",
        commandId: args.commandId, userId: args.userId,
        reasons: effective.reasons,
      }, "Compliance eligibility refused, but this is a risk-reducing CLOSE: "
        + "refusal recorded as ADVISORY, close not trapped");
    }
    return effective;
  })();

  const phaseBGate: LivePhaseBGateResult = evaluateLivePhaseBDispatchGate({
    liveBrokerExecutionEnabled: await resolveLiveBrokerExecutionEnabledAsync(),
    globalLiveEnabled: !!env.globalLiveEnabled,
    userLiveApproved: !!env.userLiveApproved,
    // #52 — ALWAYS supplied on the dispatch path (the evaluator's null branch
    // exists only for preview callers). Pinned by test:compliance-dispatch-consult.
    complianceEligibility,
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
    // Foundation gates #19–#23 — ALWAYS supplied on the dispatch path (the
    // evaluator's null branch exists only for readiness previews with no
    // command context). Pinned by test:foundation-gates and
    // test:tenant-capacity-gates.
    foundation: foundationInputs,
  });

  // Foundation gate verdicts are logged on EVERY dispatch — PASS included —
  // so enforcement can never go silent (they also persist in the
  // dispatchGateSnapshot on both the BLOCKED and SENT paths).
  logger.info({
    [PHASE_B_LIVE_LOG_PREFIX]: true,
    event: "FOUNDATION_GATES_EVALUATED",
    commandId: args.commandId, userId: args.userId, symbol: row.symbol,
    verdicts: phaseBGate.gates.filter((g) =>
      g.key === "PROVENANCE_UNPROVEN"
      || g.key === "STRATEGY_NOT_LIVE_PROMOTED"
      || g.key === "CAPITAL_TIER_EXCEEDED"
      || g.key === "TENANT_CONTEXT_VIOLATION"
      || g.key === "EDGE_CAPACITY_EXCEEDED"),
  }, "Foundation gates #19-#23 evaluated");

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
      // R3 slice 3 — the per-user allocation headroom check previously ran
      // ONLY at preflight, unlocked, against user_slot_allocation.reserved_risk
      // (which the reconciler stub hard-coded to 0), so two parallel same-user
      // dispatches could both pass it. The reservation call below now takes a
      // pg advisory lock keyed by userId and re-derives headroom INSIDE the
      // lock from live in-flight rows before the reservation row is written
      // (then the master-exposure lock runs unchanged inside it). Enforcement
      // mirrors the preflight margin-proxy governance split EXACTLY
      // (enforceMarginProxy = !useGovernance || gov.enforceAllocationLimit)
      // and is ENTRY-ONLY — a close/modify must never be trapped by headroom.
      const { reserveExposureAtomicWithUserHeadroom } =
        await import("../concurrency/exposureReservation.js");
      const enforceUserHeadroom = isEntryRow
        && (!useGovernanceDispatch || govDispatch.enforceAllocationLimit);
      const r = await reserveExposureAtomicWithUserHeadroom({
        sharedMasterAccountId: sma.id,
        addingLot: Number(row.requestedVolume),
        userId: args.userId,
        commandId: args.commandId,
        symbol: row.symbol,
        userHeadroom: enforceUserHeadroom
          ? {
              estRequiredMarginUsd:
                Math.max(0, Number(row.requestedVolume)) * REQUIRED_MARGIN_PROXY_PER_LOT_USD,
              marginProxyPerLotUsd: REQUIRED_MARGIN_PROXY_PER_LOT_USD,
            }
          : null,
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
            ...(r.userHeadroom != null ? { userHeadroom: r.userHeadroom } : {}),
            routingMode,
            at: new Date().toISOString(),
          } as unknown as Record<string, unknown>,
        }).where(eq(arxLiveCommandsTable.commandId, args.commandId)).returning();
        await audit({
          eventType: "LIVE_DISPATCH_BLOCKED", severity: "HIGH",
          userId: args.userId, symbol: row.symbol,
          message: `Master exposure reservation refused: ${r.reason}`,
          metadata: {
            commandId: args.commandId, currentOpenLots: r.currentOpenLots,
            reservedLots: r.reservedLots, cap: r.cap,
            ...(r.userHeadroom != null ? { userHeadroom: r.userHeadroom } : {}),
          },
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
    // saw LIVE_APPROVED, and all 23 gates then passed. Every one of those
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
    await recordExecutionEvent({
      commandRowId: sent.id, source: "arx", eventType: "DISPATCH_SENT",
      occurredAt: dispatchNow,
      payload: {
        commandId: args.commandId,
        bridgeConnectionId: bridge!.id,
        idempotencyKey: idemKey,
        requestedVolume: Number(row.requestedVolume),
        ttlSeconds: LIVE_COMMAND_TTL_SECONDS,
        expiresAt: expiresAt.toISOString(),
      },
    });

    // ── ARX live transport bridge ───────────────────────────────────────────
    // Mirror the live command into the legacy mt5_commands mailbox that the
    // v1.50 EA actually polls. If this mirror fails the command would sit
    // unclaimed until its TTL elapsed (silent dead order), so fail it CLOSED
    // instead and release any exposure reservation.
    //
    // R2-S7 — delivery goes through the ExecutionAdapter seam. The adapter is
    // the SAME enqueueBridgedMt5Command function (injected unchanged below),
    // so behavior is byte-equivalent; the mirror-failure → mark-failed
    // semantics in the catch stay HERE so every future venue inherits them.
    try {
      // R6 — venue routing. The adapter is no longer a compile-time literal:
      // it is selected from the registry by the venue the SERVER persisted on
      // this command row. `row.executionVenue` is server-written; a
      // client-supplied venue must never reach here, or a client could name a
      // more privileged execution path than the server authorized.
      //
      // There is NO default venue. selectExecutionAdapter throws
      // UnroutableVenueError for an absent, empty or unrecognised venue, and
      // that throw is caught below as a DEFINITE failure — correct, because
      // nothing can have been transmitted when no adapter was ever chosen.
      const executionAdapter = selectExecutionAdapter(EXECUTION_ADAPTERS, row.executionVenue);
      const delivered = await executionAdapter.deliver({
        liveRow: sent,
        bridgeUserId: bridge!.userId!,
        bridgeConnectionId: bridge!.id,
      });
      // transportRef is the venue-neutral handle. mt5CommandId exists only on
      // the EA bridge's result, so it is read narrowly rather than destructured
      // — a second venue has no mailbox row to report.
      const eaAction = delivered.action;
      const mt5CommandId = (delivered as { mt5CommandId?: number }).mt5CommandId ?? null;
      logger.warn({
        [PHASE_B_LIVE_LOG_PREFIX]: true,
        event: "LIVE_BRIDGE_ENQUEUED",
        commandId: args.commandId, mt5CommandId, transportRef: delivered.transportRef, eaAction,
        bridgeConnectionId: bridge!.id,
      }, "Phase B live command mirrored into mt5_commands for v1.50 EA pickup");
    } catch (bridgeErr: unknown) {
      const msg = bridgeErr instanceof Error ? bridgeErr.message : String(bridgeErr);

      // R6 — the INDETERMINATE delivery outcome, checked BEFORE the generic
      // failure routing below.
      //
      // The EA bridge cannot reach here: its deliver() is a local mailbox
      // INSERT, so a throw genuinely proves nothing was transmitted and the
      // fail-closed handling below is correct. A network venue is different —
      // a frame written with no reply may well have placed an order. Recording
      // that as LIVE_FAILED and releasing the reservation would free risk
      // budget for a position that may be open, and tell the user "no trade"
      // about an order that may be live.
      //
      // So: LIVE_UNKNOWN, reservation HELD, duplicate submission still blocked
      // by arx_live_commands_idem_active_uq (which covers LIVE_UNKNOWN
      // precisely so an unconfirmed outcome cannot be retried into a double
      // order), and resolution left to reconciliation against broker truth.
      // NOTE the deliberate absence of a releaseReservation call in this
      // branch — that omission IS the safety property, and it is asserted by
      // test:phase6-indeterminate.
      const deliveryRouting = routeDeliveryFailure(bridgeErr);
      if (deliveryRouting.kind === "INDETERMINATE") {
        const [unresolved] = await db.update(arxLiveCommandsTable).set({
          status: "LIVE_UNKNOWN",
          brokerMessage: msg.slice(0, 400),
        }).where(eq(arxLiveCommandsTable.commandId, args.commandId)).returning();
        await audit({
          eventType: "LIVE_DISPATCH_INDETERMINATE", severity: "HIGH",
          userId: args.userId, symbol: row.symbol,
          message: `Delivery outcome INDETERMINATE at ${deliveryRouting.venue} — an order may exist at the venue`,
          metadata: {
            commandId: args.commandId,
            venue: deliveryRouting.venue,
            intentRef: deliveryRouting.intentRef,
            detail: deliveryRouting.detail,
            reservationHeld: reservationId != null,
          },
        });
        logger.error({
          [PHASE_B_LIVE_LOG_PREFIX]: true,
          event: "LIVE_DELIVERY_INDETERMINATE",
          commandId: args.commandId, venue: deliveryRouting.venue,
          intentRef: deliveryRouting.intentRef,
        }, "Delivery indeterminate — command held as LIVE_UNKNOWN, exposure reservation NOT released, awaiting reconciliation");
        return {
          ok: false as const,
          indeterminate: true as const,
          reason: "LIVE_DELIVERY_INDETERMINATE" as const,
          command: unresolved,
          gate: phaseBGate,
        };
      }

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
 * Task #28 / R2 S1 — sweep TTL-elapsed live commands.
 *
 * A SENT_TO_MT5_LIVE command whose `expiresAt` is in the past is classified
 * by pickup evidence (`classifySweptLiveCommand`):
 *
 *   - NO pickup evidence (arx `pickedByEaAt` null AND the mt5_commands
 *     transport mirror was never claimed) → terminal LIVE_EXPIRED; the master
 *     exposure reservation is released — the EA provably never saw it.
 *   - ANY pickup evidence → NON-TERMINAL LIVE_UNKNOWN; the reservation is
 *     HELD — the order may be standing at the broker and only reconciliation
 *     may resolve it (audit G1a: never presume non-execution after pickup).
 *
 * Scoped to a single user when `userId` is given (the natural choke point is
 * the EA poll); call with no userId for a global sweep. `expired` counts only
 * LIVE_EXPIRED terminalizations; `unknown` counts LIVE_UNKNOWN entries.
 */
export async function sweepExpiredLiveCommands(args?: { userId?: number }): Promise<{
  expired: number;
  commandIds: string[];
  unknown: number;
  unknownCommandIds: string[];
}> {
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

  const candidates = await db.select().from(arxLiveCommandsTable).where(where);
  if (candidates.length === 0) {
    return { expired: 0, commandIds: [], unknown: 0, unknownCommandIds: [] };
  }

  // Transport-mirror pickup evidence. The v1.50 EA polls ONLY the legacy
  // mt5_commands mailbox, so a bridged command's arx-side `pickedByEaAt`
  // stays null even after the EA claimed (and possibly executed) the mirror.
  // Classifying on `pickedByEaAt` alone would terminalize those rows as
  // LIVE_EXPIRED — exactly the G1a hole — so the mirror status is consulted
  // as a second pickup-evidence source. A failed lookup degrades to a
  // non-never-served sentinel: when the evidence is unreadable, classify
  // toward LIVE_UNKNOWN, never toward presumed non-execution.
  const mirrorStatusByCommandId = new Map<string, string>();
  try {
    const { mt5CommandsTable } = await import("@workspace/db");
    const mirrors = await db.select({
      liveCommandId: sql<string | null>`${mt5CommandsTable.payload} ->> 'liveCommandId'`,
      status: mt5CommandsTable.status,
    }).from(mt5CommandsTable)
      .where(inArray(
        sql`${mt5CommandsTable.payload} ->> 'liveCommandId'`,
        candidates.map((c) => c.commandId),
      ));
    for (const m of mirrors) {
      if (m.liveCommandId == null) continue;
      const prev = mirrorStatusByCommandId.get(m.liveCommandId);
      // If any mirror row shows pickup, that evidence wins over a never-served one.
      const prevNeverServed = prev == null || prev === "PENDING" || prev === "cancelled";
      if (prev === undefined || prevNeverServed) mirrorStatusByCommandId.set(m.liveCommandId, m.status);
    }
  } catch (e) {
    for (const c of candidates) mirrorStatusByCommandId.set(c.commandId, "MIRROR_LOOKUP_FAILED");
    logger.warn({
      [PHASE_B_LIVE_LOG_PREFIX]: true,
      event: "LIVE_SWEEP_MIRROR_LOOKUP_FAILED",
      error: e instanceof Error ? e.message : String(e),
    }, "sweep could not read transport mirrors — classifying all candidates toward LIVE_UNKNOWN");
  }

  const toExpire: string[] = [];
  const toUnknown: string[] = [];
  for (const c of candidates) {
    const verdict = classifySweptLiveCommand({
      pickedByEaAt: c.pickedByEaAt,
      mirrorStatus: mirrorStatusByCommandId.get(c.commandId) ?? null,
    });
    (verdict === "LIVE_EXPIRED" ? toExpire : toUnknown).push(c.commandId);
  }

  // CAS updates guarded by status so a concurrent EA result/pickup cannot
  // race the sweep — only rows still SENT_TO_MT5_LIVE transition.
  const expired = toExpire.length === 0 ? [] : await db.update(arxLiveCommandsTable).set({
    status: "LIVE_EXPIRED",
    expiredAt: now,
    rejectedAt: now,
    rejectionReason: "LIVE_COMMAND_TTL_EXPIRED",
  }).where(and(
    inArray(arxLiveCommandsTable.commandId, toExpire),
    eq(arxLiveCommandsTable.status, "SENT_TO_MT5_LIVE"),
  )).returning();

  const unknown = toUnknown.length === 0 ? [] : await db.update(arxLiveCommandsTable).set({
    status: "LIVE_UNKNOWN",
  }).where(and(
    inArray(arxLiveCommandsTable.commandId, toUnknown),
    eq(arxLiveCommandsTable.status, "SENT_TO_MT5_LIVE"),
  )).returning();

  for (const cmd of expired) {
    // Provably-never-delivered: release the reservation (no-op if absent).
    try {
      const { releaseReservationByCommandId } =
        await import("../concurrency/exposureReservation.js");
      await releaseReservationByCommandId(cmd.commandId);
    } catch { /* audit-only failure */ }
    await audit({
      eventType: "LIVE_COMMAND_TTL_EXPIRED", severity: "HIGH",
      userId: cmd.userId, symbol: cmd.symbol,
      message: `Live command expired before EA pickup: ${cmd.commandId} (ttl=${cmd.ttlSeconds ?? "?"}s)`,
      metadata: { commandId: cmd.commandId, sentToMt5At: cmd.sentToMt5At, expiresAt: cmd.expiresAt },
    });
    await recordExecutionEvent({
      commandRowId: cmd.id, source: "arx", eventType: "TTL_EXPIRED",
      occurredAt: now,
      payload: {
        commandId: cmd.commandId,
        sentToMt5At: cmd.sentToMt5At?.toISOString() ?? null,
        expiresAt: cmd.expiresAt?.toISOString() ?? null,
        mirrorStatus: mirrorStatusByCommandId.get(cmd.commandId) ?? null,
        reservationSettlement: "RELEASE",
      },
    });
    logger.warn({
      [PHASE_B_LIVE_LOG_PREFIX]: true,
      event: "LIVE_COMMAND_TTL_EXPIRED",
      commandId: cmd.commandId, userId: cmd.userId,
    }, "Phase B live command swept to LIVE_EXPIRED (TTL, never picked up)");
  }

  for (const cmd of unknown) {
    // Pickup evidence exists and no result arrived: the outcome is UNKNOWN.
    // The reservation is deliberately NOT released (audit G1a/G1b) — reserved
    // lots stay attributed until reconciliation confirms the true outcome.
    await audit({
      eventType: "LIVE_COMMAND_OUTCOME_UNKNOWN", severity: "CRITICAL",
      userId: cmd.userId, symbol: cmd.symbol,
      message: `Live command picked up but no broker result within TTL — outcome UNKNOWN, reservation held: ${cmd.commandId}`,
      metadata: {
        commandId: cmd.commandId,
        pickedByEaAt: cmd.pickedByEaAt,
        mirrorStatus: mirrorStatusByCommandId.get(cmd.commandId) ?? null,
        sentToMt5At: cmd.sentToMt5At, expiresAt: cmd.expiresAt,
      },
    });
    await recordExecutionEvent({
      commandRowId: cmd.id, source: "arx", eventType: "UNKNOWN_ENTERED_TTL_NO_RESULT",
      occurredAt: now,
      payload: {
        commandId: cmd.commandId,
        pickedByEaAt: cmd.pickedByEaAt?.toISOString() ?? null,
        mirrorStatus: mirrorStatusByCommandId.get(cmd.commandId) ?? null,
        sentToMt5At: cmd.sentToMt5At?.toISOString() ?? null,
        expiresAt: cmd.expiresAt?.toISOString() ?? null,
        reservationSettlement: "HOLD",
      },
    });
    logger.error({
      [PHASE_B_LIVE_LOG_PREFIX]: true,
      event: "LIVE_COMMAND_OUTCOME_UNKNOWN",
      commandId: cmd.commandId, userId: cmd.userId,
    }, "Phase B live command entered LIVE_UNKNOWN — reservation held, reconciliation required");
  }

  return {
    expired: expired.length,
    commandIds: expired.map((c) => c.commandId),
    unknown: unknown.length,
    unknownCommandIds: unknown.map((c) => c.commandId),
  };
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

  await recordExecutionEvent({
    commandRowId: row.id, source: "ea", eventType: "EA_PICKED_UP",
    occurredAt: row.pickedByEaAt,
    payload: { commandId: row.commandId, bridgeConnectionId: args.bridgeConnectionId },
  });

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

// R2-S7 — the ONE adapter instance the dispatch path consumes (typed as the
// interface, never the class, so the R5 Deriv adapter can slot in behind the
// same seam). Wrapping — not reimplementing — enqueueBridgedMt5Command keeps
// delivery byte-equivalent: same INSERT, same silent-close-failure guard,
// same UNMAPPED_LIVE_COMMAND_TYPE throw the call site's catch maps to
// BRIDGE_UNMAPPED_COMMAND_TYPE. The wrapper is an explicit field-forwarding
// call (not a bare function reference) so the check-live-dispatch-cas CI
// guard's mirror-call literal keeps matching the ONLY place delivery is
// invoked — which sits, as the guard requires, after the dispatch CAS claim
// and the race-lost refusal in source order.
// R6 — still the SOLE MT5 implementation, unchanged, now registered under its
// venue key rather than named directly at the dispatch call site.
const mt5ExecutionAdapter: ExecutionAdapter<Mt5DeliveryResult> = new Mt5EaBridgeAdapter(
  // Deliberately `.then(...)` rather than an async/await block: the seam's own
  // test pins that the enqueue helper is never directly awaited in this file,
  // so a direct awaited call can never bypass the adapter. Keeping that pin
  // literally true is worth more than the cosmetic win of await.
  // transportRef is the venue-neutral handle; for the EA bridge it IS the
  // mailbox row id. Both are carried so existing consumers keep the typed
  // numeric id while the seam itself stays venue-agnostic.
  (command) => enqueueBridgedMt5Command({
    liveRow: command.liveRow,
    bridgeUserId: command.bridgeUserId,
    bridgeConnectionId: command.bridgeConnectionId,
  }).then((r) => ({ ...r, transportRef: String(r.mt5CommandId) })),
);

/**
 * R6 — the venue→adapter registry the dispatch path selects from.
 *
 * Typed as Record<ExecutionVenue, ...>, so adding a venue to the union without
 * registering a certified adapter for it FAILS THE BUILD. That is the property
 * the old hard-coded literal had for free, kept rather than traded away.
 *
 * DERIV_DEMO is intentionally absent from this static registry. Its adapter
 * needs per-request dependencies — the resolved execution tier, the proven-demo
 * assertion, the durable intent writer — so it cannot be a module constant
 * without reading ambient state, which is exactly how a tier or an account
 * check gets bypassed. It is supplied per dispatch by
 * `buildExecutionAdapterRegistry`. Until that wiring lands, a DERIV_DEMO
 * command reaching dispatch throws UnroutableVenueError and fails CLOSED:
 * no adapter, no frame, no order.
 */
const EXECUTION_ADAPTERS: ExecutionAdapterRegistry = {
  MT5_EA_BRIDGE: mt5ExecutionAdapter,
  DERIV_DEMO: {
    venue: "deriv_demo",
    deliver: () => {
      throw new Error(
        "DERIV_DEMO_ADAPTER_NOT_WIRED: the Deriv adapter requires per-request dependencies "
        + "(execution tier, proven-demo assertion, durable intent writer) and is not available "
        + "as a module constant. Dispatch fails CLOSED rather than sending without them.",
      );
    },
  },
};

export type BridgedLiveOutcome =
  | "LIVE_FILLED"
  | "LIVE_PARTIALLY_FILLED"
  | "LIVE_REJECTED"
  | "LIVE_FAILED"
  | "LIVE_UNKNOWN"
  | "STALE_COMMAND_REJECTED";

const LIVE_FAILED_STATUS_RE = /fail|error|reject/i;

/**
 * Pure, honest mapping of an EA/broker terminal result into a Phase B outcome.
 *
 * HONESTY RULES (see memory dispatch-vs-execution-honesty; audit G1b):
 *   - `LIVE_FILLED` is only ever returned when a confirmed broker ticket is
 *     present — a fill is never fabricated from a success-looking status.
 *   - R2 S1: a non-failure status with NO broker ticket is `LIVE_UNKNOWN`,
 *     never `LIVE_FAILED`. The old coercion to LIVE_FAILED released the
 *     master exposure reservation; if the order actually stood at the broker
 *     the pool was under-counted and the next reservation could over-expose
 *     the master account. UNKNOWN holds the reservation until reconciliation
 *     resolves the true outcome.
 *   - Explicit failure/rejection statuses (the legacy `/fail|error|reject/i`
 *     EA-boundary test) are the EA/broker CONFIRMING non-execution — those
 *     remain LIVE_FAILED / LIVE_REJECTED. Stale wins first so a TTL-elapsed
 *     refusal lands on LIVE_EXPIRED.
 */
/**
 * R2 S5 — lot-comparison tolerance. Volumes are doubles carrying broker lot
 * steps (0.01 and finer), so an exact `<` would classify float noise as a
 * partial fill. A fill within this tolerance of the request counts as FULL.
 */
export const LIVE_VOLUME_EPSILON = 1e-9;

/**
 * PURE — is this broker result a partial fill? Requires ALL of: a confirmed
 * ticket (no ticket is never a fill of any size), a finite positive executed
 * volume, a finite positive requested volume, and executed strictly below
 * requested beyond the float tolerance. Anything unknown returns false, so a
 * missing volume degrades to the existing full-fill/UNKNOWN behavior rather
 * than inventing a partial.
 */
export function isPartialFill(input: {
  hasBrokerTicket: boolean;
  executedVolume?: number | null;
  requestedVolume?: number | null;
}): boolean {
  if (!input.hasBrokerTicket) return false;
  const executed = input.executedVolume;
  const requested = input.requestedVolume;
  if (typeof executed !== "number" || !Number.isFinite(executed)) return false;
  if (typeof requested !== "number" || !Number.isFinite(requested)) return false;
  if (executed <= 0 || requested <= 0) return false;
  return executed < requested - LIVE_VOLUME_EPSILON;
}

export function mapBridgedLiveOutcome(input: {
  status: string;
  reason?: string | null;
  hasBrokerTicket: boolean;
  /** R2 S5 — supplied by the EA result; absent on paths that do not report it. */
  executedVolume?: number | null;
  /** R2 S5 — the command row's requested volume. */
  requestedVolume?: number | null;
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
  // R2 S5 — a ticket with a short fill is a PARTIAL, not a full fill. Checked
  // before the full-fill branch so a partial can never be recorded as
  // complete (spec §12: partial fills update exposure immediately).
  if (isPartialFill(input)) return "LIVE_PARTIALLY_FILLED";
  return input.hasBrokerTicket ? "LIVE_FILLED" : "LIVE_UNKNOWN";
}

export async function recordLiveCommandResult(args: {
  userId: number;
  commandId: string;
  // Task #28 — STALE_COMMAND_REJECTED lets the EA report that it refused a
  // command whose TTL had already elapsed when it polled it. The server maps
  // it to the terminal LIVE_EXPIRED state.
  // R2 S1 — LIVE_UNKNOWN is the honest mapping of an ambiguous EA report
  // (success-looking status, no broker ticket): non-terminal, reservation
  // held, resolved only by reconciliation.
  // R2 S5 — LIVE_ACKNOWLEDGED is accepted here but is NOT producible by
  // mapBridgedLiveOutcome: the v1.5x EA posts only a settled result and has no
  // ack signal. It is forward-declared for the bridge-v2 TRADE_TRANSACTION
  // lifecycle (REQUEST/ORDER_ADD without a dealTicket), which can call this
  // entry point directly once its lifecycle mapping lands.
  outcome: "LIVE_FILLED" | "LIVE_PARTIALLY_FILLED" | "LIVE_ACKNOWLEDGED" | "LIVE_REJECTED" | "LIVE_FAILED" | "LIVE_UNKNOWN" | "STALE_COMMAND_REJECTED";
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

  // R2 S2 — the full reported broker evidence, retained verbatim on every
  // path (applied, duplicate, late, conflicting). Previously the losing side
  // of the first-write-wins CAS survived only as duplicateResultCount++ and
  // the ticket/price/retcode were destroyed (audit G3).
  const reportedEvidence: Record<string, unknown> = {
    reportedOutcome: args.outcome,
    brokerTicket: args.brokerTicket ?? null,
    fillPrice: args.fillPrice ?? null,
    executedVolume: args.executedVolume ?? null,
    mt5Retcode: args.mt5Retcode ?? null,
    brokerMessage: args.brokerMessage ?? null,
    eaReason: args.eaReason ?? null,
    reportingBridgeConnectionId: args.reportingBridgeConnectionId,
  };

  // Task #28 — exactly-once: if the command is already in a terminal state
  // this is a duplicate result POST (EA retried, or a result raced the TTL
  // sweep). We acknowledge it with ok:true so the EA stops retrying, record
  // the duplicate for audit, but NEVER re-apply the outcome. R2 S2: the
  // reported payload is RETAINED as an execution event, not destroyed.
  if (!LIVE_RESULT_APPLICABLE_STATUSES.includes(row.status as ArxLiveCommandStatus)) {
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
      await recordExecutionEvent({
        commandRowId: row.id, source: "ea", eventType: "LATE_RESULT_RETAINED",
        payload: { commandId: args.commandId, existingStatus: row.status, applied: false, ...reportedEvidence },
      });
      return { ok: true, command: bumped ?? row, reason: "DUPLICATE_IGNORED" };
    }
    // R2 S1 — a result arriving while the command rests in an epistemic state
    // (LIVE_UNKNOWN / LIVE_RECONCILIATION_REQUIRED) is late broker evidence.
    // It is retained for the reconciler and acknowledged so the EA stops
    // retrying, but NEVER applied here: only reconciliation (R2 S3) may
    // resolve an unknown outcome, and the reservation stays held meanwhile.
    if (LIVE_EPISTEMIC_STATUSES.includes(row.status as ArxLiveCommandStatus)) {
      await audit({
        eventType: "LIVE_RESULT_RETAINED_UNKNOWN", severity: "CRITICAL",
        userId: args.userId, symbol: row.symbol,
        message: `Late live result retained for ${args.commandId} (currently ${row.status}); reported ${args.outcome} — reconciliation required to resolve`,
        metadata: { commandId: args.commandId, existingStatus: row.status, reportedOutcome: args.outcome, brokerTicket: args.brokerTicket ?? null },
      });
      await recordExecutionEvent({
        commandRowId: row.id, source: "ea", eventType: "LATE_RESULT_RETAINED",
        payload: { commandId: args.commandId, existingStatus: row.status, applied: false, ...reportedEvidence },
      });
      return { ok: true, command: row, reason: "RESULT_RETAINED_FOR_RECONCILIATION" };
    }
    // Non-terminal but not SENT (e.g. DRAFT/APPROVED) — illegal result.
    return { ok: false, command: null, reason: "BAD_STATE" };
  }

  // Map the EA outcome to the final command status. STALE_COMMAND_REJECTED
  // becomes LIVE_EXPIRED (terminal); everything else is its own status
  // (LIVE_UNKNOWN stays LIVE_UNKNOWN — non-terminal).
  // R2 S5 — reclassify a short fill as PARTIAL using the row's authoritative
  // requestedVolume. The EA reports executedVolume but not what was asked for,
  // so this is the only place the comparison can be made honestly. A partial
  // previously landed as a full LIVE_FILLED, which both overstated execution
  // and FULFILLED the whole exposure reservation.
  const effectiveOutcome: typeof args.outcome =
    args.outcome === "LIVE_FILLED"
      && isPartialFill({
        hasBrokerTicket: args.brokerTicket != null,
        executedVolume: args.executedVolume ?? null,
        requestedVolume: row.requestedVolume,
      })
      ? "LIVE_PARTIALLY_FILLED"
      : args.outcome;

  const finalStatus: ArxLiveCommandStatus =
    effectiveOutcome === "STALE_COMMAND_REJECTED" ? "LIVE_EXPIRED" : effectiveOutcome;

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
  if (effectiveOutcome === "LIVE_FILLED") {
    updates.filledAt = now;
  } else if (effectiveOutcome === "LIVE_UNKNOWN") {
    // R2 S1 — no terminal stamps: this is not a rejection, not an expiry,
    // not a fill. The evidence columns above (retcode/brokerMessage/…) and
    // the execution event carry what the EA reported; rejectionReason stays
    // untouched so the row never claims a confident refusal it cannot prove.
  } else if (effectiveOutcome === "LIVE_PARTIALLY_FILLED") {
    // R2 S5 — real exposure exists, but the order is NOT complete: no
    // filledAt (that would claim a full fill) and no rejectedAt (nothing was
    // refused). executedVolume above carries the filled size; the remainder
    // is still working and the reservation stays HELD.
  } else if (effectiveOutcome === "LIVE_ACKNOWLEDGED") {
    // R2 S5 — the broker saw the order; nothing is filled and nothing is
    // refused. No terminal stamps of any kind (spec §20: acknowledged is not
    // treated as filled).
  } else if (effectiveOutcome === "STALE_COMMAND_REJECTED") {
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
      // R2 S2 — retain the losing side of the race: if the first-arriving
      // result was wrong, this event is the evidence reconciliation needs.
      await recordExecutionEvent({
        commandRowId: current.id, source: "ea", eventType: "LATE_RESULT_RETAINED",
        payload: { commandId: args.commandId, existingStatus: current.status, applied: false, lostCasRace: true, ...reportedEvidence },
      });
      return { ok: true, command: bumped ?? current, reason: "DUPLICATE_IGNORED" };
    }
    // R2 S1 — the race may also have been lost to the TTL sweep moving the
    // row into LIVE_UNKNOWN: retain the evidence, never apply it here.
    if (current && LIVE_EPISTEMIC_STATUSES.includes(current.status as ArxLiveCommandStatus)) {
      await recordExecutionEvent({
        commandRowId: current.id, source: "ea", eventType: "LATE_RESULT_RETAINED",
        payload: { commandId: args.commandId, existingStatus: current.status, applied: false, lostCasRace: true, ...reportedEvidence },
      });
      return { ok: true, command: current, reason: "RESULT_RETAINED_FOR_RECONCILIATION" };
    }
    return { ok: false, command: current ?? null, reason: "CAS_CONFLICT" };
  }

  // Tamper-evident mirror of the broker order outcome — best-effort, never
  // throws (cannot affect fill settlement). FILLED is ALLOWED; an UNKNOWN
  // outcome is ATTEMPTED (no confirmed result exists to allow or deny);
  // everything else is DENIED so a rejected/failed order is permanently
  // chain-recorded.
  await mirrorCriticalEvent({
    eventType: "ORDER_RESULT", severity: "CRITICAL",
    status: args.outcome === "LIVE_FILLED" ? "ALLOWED"
      : args.outcome === "LIVE_UNKNOWN" ? "ATTEMPTED"
      : "DENIED",
    actorUserId: args.userId, actorType: "EA",
    affectedObject: `arx_live_commands:${args.commandId}`,
    message: `Live order result: ${args.outcome}`,
    metadata: { commandId: args.commandId, symbol: row.symbol, outcome: args.outcome, hasBrokerTicket: !!args.brokerTicket },
  });

  // R2 S2 — the applied transition, with the full broker evidence.
  await recordExecutionEvent({
    commandRowId: updated.id, source: "ea", eventType: `RESULT_${finalStatus}`,
    occurredAt: now,
    payload: { commandId: args.commandId, applied: true, finalStatus, ...reportedEvidence },
  });

  // Settle the master-exposure reservation taken at dispatch time
  // (pure rule: settleReservationForStatus — audit G1b).
  //   FULFILL — confirmed fill (lots stay attributed via shared_trade_attribution).
  //   RELEASE — confirmed non-execution (lots return to the pool).
  //   HOLD    — UNKNOWN outcome: the reservation is deliberately NOT touched;
  //             releasing an unconfirmed order under-counts the pool and can
  //             over-expose the master account. Reconciliation settles it.
  // The fulfil/release helpers act only on rows still in RESERVED, so
  // duplicate EA callbacks are idempotent.
  const settlement = settleReservationForStatus(finalStatus);
  if (settlement === "HOLD") {
    logger.error({
      [PHASE_B_LIVE_LOG_PREFIX]: true,
      event: "RESERVATION_HELD_UNKNOWN_OUTCOME",
      commandId: args.commandId, outcome: args.outcome,
    }, "exposure reservation HELD — outcome unknown, reconciliation required");
  } else {
    try {
      const { fulfillReservationByCommandId, releaseReservationByCommandId } =
        await import("../concurrency/exposureReservation.js");
      if (settlement === "FULFILL") {
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
  }

  // F-build — draft→fill linkage at OPEN. When a PLACE order fills (fully or
  // partially) with a broker ticket, backfill that ticket onto the executed
  // Profit-Mission draft that dispatched this command (matched by commandId).
  // Best-effort + idempotent, a pure additive column write: no-op for
  // non-mission commands, never an execution path, and never allowed to
  // disturb the fill-confirmation result.
  if (
    (effectiveOutcome === "LIVE_FILLED" || effectiveOutcome === "LIVE_PARTIALLY_FILLED")
    && args.brokerTicket
    && (row.commandType === "PLACE_LIVE_MARKET_ORDER" || row.commandType === "PLACE_LIVE_PENDING_ORDER")
  ) {
    try {
      const { backfillMissionDraftBrokerTicket } = await import("../missionExecution.js");
      await backfillMissionDraftBrokerTicket({
        userId: args.userId,
        commandId: args.commandId,
        brokerTicket: args.brokerTicket,
        nowMs: now.getTime(),
      });
    } catch (e) {
      logger.error({
        [PHASE_B_LIVE_LOG_PREFIX]: true,
        event: "MISSION_DRAFT_FILL_LINK_FAILED",
        commandId: args.commandId, brokerTicket: args.brokerTicket,
        error: e instanceof Error ? e.message : String(e),
      }, "failed to link broker fill to mission draft (advisory) — non-fatal");
    }

    // Economic truth spine (#30) — fill-confirmation posting. Best-effort,
    // append-only, and NEVER a settlement dependency: the fee at open is
    // honestly UNKNOWN (the EA result carries no commission figure), so this
    // posts an explicit UNKNOWN-flagged fee journal rather than a silent
    // zero. Idempotent via unique(journal_id, leg_index) — a duplicate EA
    // callback cannot double-post.
    try {
      const { postLiveOpenFill } = await import("../accounting/economicSeams.js");
      await postLiveOpenFill({
        userId: args.userId,
        commandId: args.commandId,
        brokerTicket: args.brokerTicket ?? null,
        bridgeConnectionId: args.reportingBridgeConnectionId,
        strategyId: row.edgeId != null ? `edge:${row.edgeId}` : null,
        filledAt: now,
      });
    } catch (e) {
      logger.warn({
        [PHASE_B_LIVE_LOG_PREFIX]: true,
        event: "ECONOMIC_OPEN_POSTING_FAILED",
        commandId: args.commandId,
        error: e instanceof Error ? e.message : String(e),
      }, "open-fill economic posting failed (advisory) — fill settlement unaffected");
    }
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
          // Economic truth spine (#29/#30) — close-reconciliation posting.
          // Realized P&L comes from the row's last-synced floatingPl, which
          // is a LOCAL_EXECUTION record and is labelled as such; when it is
          // null the P&L journal posts UNKNOWN-flagged, never a claimed
          // zero. Best-effort: cannot disturb the close settlement.
          try {
            const closedPos = closedRows[0] as { floatingPl?: number | null } | undefined;
            const realisedPnlForLedger =
              typeof closedPos?.floatingPl === "number" && Number.isFinite(closedPos.floatingPl)
                ? closedPos.floatingPl
                : null;
            const { postLiveClose } = await import("../accounting/economicSeams.js");
            await postLiveClose({
              userId: args.userId,
              commandId: args.commandId,
              brokerTicket: closeTicket,
              bridgeConnectionId: args.reportingBridgeConnectionId,
              strategyId: row.edgeId != null ? `edge:${row.edgeId}` : null,
              realizedPnl: realisedPnlForLedger,
              closedAt: now,
            });
          } catch (e) {
            logger.warn({
              [PHASE_B_LIVE_LOG_PREFIX]: true,
              event: "ECONOMIC_CLOSE_POSTING_FAILED",
              commandId: args.commandId, brokerTicket: closeTicket,
              error: e instanceof Error ? e.message : String(e),
            }, "close economic posting failed (advisory) — close settlement unaffected");
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

  // ── R3 slice 7 — FAILURE-STREAK BREAKER (best-effort, never gates) ───────
  // A terminal broker failure was just APPLIED (the CAS above won — this is
  // not a duplicate/late report). Count this user's consecutive per-symbol
  // terminal failures (newest first; broker-confirmed success resets — pure
  // countConsecutiveTerminalFailures) and at >= FAILURE_STREAK_THRESHOLD
  // insert a FAILURE_STREAK_LOCK_MINUTES-long risk_locks row. Enforcement is
  // automatic and needs no new gate: the wave-2 risk-lock pre-gate refuses
  // entries with LIVE_BLOCKED:RISK_LOCK_FAILURE_STREAK while the lock is
  // active, and close/modify stay allowed via that gate's entry-vs-ops
  // split. The ENTIRE block is try/caught: streak accounting must NEVER
  // break result recording — the applied result above is already committed
  // and is returned unchanged regardless of what happens here.
  if (finalStatus === "LIVE_FAILED" || finalStatus === "LIVE_REJECTED") {
    try {
      const recentRows = await db.select({ status: arxLiveCommandsTable.status })
        .from(arxLiveCommandsTable)
        .where(and(
          eq(arxLiveCommandsTable.userId, args.userId),
          eq(arxLiveCommandsTable.symbol, row.symbol),
        ))
        .orderBy(desc(arxLiveCommandsTable.id))
        .limit(50);
      const streak = countConsecutiveTerminalFailures(recentRows.map((r) => r.status));
      if (failureStreakShouldLock(streak)) {
        const { riskLocksTable } = await import("@workspace/db");
        // Dedupe: one active FAILURE_STREAK lock per user at a time — the
        // 4th/5th consecutive failure must extend nothing and stack nothing.
        const existing = await db.select({ id: riskLocksTable.id })
          .from(riskLocksTable)
          .where(and(
            eq(riskLocksTable.userId, args.userId),
            eq(riskLocksTable.lockType, FAILURE_STREAK_LOCK_TYPE),
            eq(riskLocksTable.isActive, true),
            sql`(${riskLocksTable.endTime} is null or ${riskLocksTable.endTime} > ${now})`,
          )).limit(1);
        if (!existing[0]) {
          const lockEnd = new Date(now.getTime() + FAILURE_STREAK_LOCK_MINUTES * 60 * 1000);
          await db.insert(riskLocksTable).values({
            userId: args.userId,
            lockType: FAILURE_STREAK_LOCK_TYPE,
            reason: `${streak} consecutive terminal live failures on ${row.symbol} (last command ${args.commandId})`,
            startTime: now,
            endTime: lockEnd,
            isActive: true,
            overrideAllowed: false,
            relatedTradeId: args.commandId,
          });
          await audit({
            eventType: "FAILURE_STREAK_LOCK_CREATED", severity: "HIGH",
            userId: args.userId, symbol: row.symbol,
            message: `Failure-streak breaker engaged: ${streak} consecutive terminal failures on ${row.symbol} — ${FAILURE_STREAK_LOCK_MINUTES}m ${FAILURE_STREAK_LOCK_TYPE} risk lock created`,
            metadata: {
              commandId: args.commandId,
              streak,
              lockType: FAILURE_STREAK_LOCK_TYPE,
              endTime: lockEnd.toISOString(),
            },
          });
          logger.warn({
            [PHASE_B_LIVE_LOG_PREFIX]: true,
            event: "FAILURE_STREAK_LOCK_CREATED",
            commandId: args.commandId, userId: args.userId,
            symbol: row.symbol, streak,
          }, "Failure-streak breaker engaged — FAILURE_STREAK risk lock created (entries blocked by the risk-lock pre-gate)");
        }
      }
    } catch (e) {
      logger.warn({
        [PHASE_B_LIVE_LOG_PREFIX]: true,
        event: "FAILURE_STREAK_ACCOUNTING_FAILED",
        commandId: args.commandId, userId: args.userId,
        error: e instanceof Error ? e.message : String(e),
      }, "failure-streak accounting failed — result recording unaffected");
    }
  }

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
  // Wave-4 pre-gate caps. `null` explicitly clears a cap (gate skipped for
  // that dimension); `undefined` leaves the stored value untouched.
  // Non-null values are ALWAYS clamped to the hard ceiling in liveArming.ts —
  // a user can tighten past it but can never loosen beyond it.
  maxEntryDeviationBps?: number | null;
  maxSignalAgeMs?: number | null;
  maxClusterRiskUsd?: number | null;
  maxClusterPositions?: number | null;
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

  // Each cap: undefined = leave untouched; null = explicitly clear (gate
  // skipped); a finite number = clamp into (0, hardCeiling].
  const clampCap = (value: number | null | undefined, hardCeiling: number): number | null | undefined => {
    if (value === undefined) return undefined;
    if (value === null) return null;
    if (!Number.isFinite(value) || value <= 0) return null; // non-positive/garbage clears, never fabricates a cap
    return Math.min(value, hardCeiling);
  };
  const entryDeviation = clampCap(args.maxEntryDeviationBps, ARX_LIVE_HARD_MAX_ENTRY_DEVIATION_BPS);
  if (entryDeviation !== undefined) updates.maxEntryDeviationBps = entryDeviation;
  const signalAge = clampCap(args.maxSignalAgeMs, ARX_LIVE_HARD_MAX_SIGNAL_AGE_MS);
  if (signalAge !== undefined) updates.maxSignalAgeMs = signalAge;
  const clusterRisk = clampCap(args.maxClusterRiskUsd, ARX_LIVE_HARD_MAX_CLUSTER_RISK_USD);
  if (clusterRisk !== undefined) updates.maxClusterRiskUsd = clusterRisk;
  const clusterPositions = clampCap(args.maxClusterPositions, ARX_LIVE_HARD_MAX_CLUSTER_POSITIONS);
  if (clusterPositions !== undefined) updates.maxClusterPositions = clusterPositions;

  await db.update(arxLiveUserSettingsTable).set(updates)
    .where(eq(arxLiveUserSettingsTable.userId, args.userId));
  return getOrCreateUserSettings(args.userId);
}
