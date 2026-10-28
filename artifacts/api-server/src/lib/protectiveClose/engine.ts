// Phase 13 — Protective Auto-Close: orchestrator.
//
// SAFETY:
//   * Server-only. Cannot be triggered from a frontend request. Called by
//     the monitor worker per-user-with-open-trades.
//   * Every cycle for every (user, trade) writes a journal row BEFORE
//     attempting any action — alert / recommend / blocked / eligible.
//   * On AUTO_CLOSE_ELIGIBLE, the engine creates a SIMULATED close draft
//     and invokes the EXISTING confirmAction chain. That chain runs the
//     14-check guards and forwards to queueMt5CommandWithGate — which
//     forces BLOCKED today (mt5.ts:662) under the paper-only lock. So
//     today the journal will always show BLOCKED_BY_PAPER_LOCK on
//     eligibility, and `actionTakenActionId` points at the action row
//     that holds the BLOCKED command for full audit.
//   * AI cannot open / add / widen. It can only emit CLOSE / PARTIAL_CLOSE
//     against an already-open user-owned position.

import { demoPositionLedger, demoPositionColumns } from "../positions/ledger.js";
import { db } from "@workspace/db";
import { sharedTradeAttributionTable } from "@workspace/db/schema";
import { and, eq } from "drizzle-orm";
import { logger } from "../logger.js";
import { getEffectiveSettings } from "./settings.js";
import { getActivityStatus } from "./inactivity.js";
import { analyzeReversal } from "./reversalSignals.js";
import { decideProtectiveAction, type DecisionOutput } from "./decide.js";
import { recordDecision, hasRecentAttempt } from "./journal.js";
import { guardianTradeActionClose } from "../positionGuardian/manage.js";

/** Today these are server-wide invariants and cannot be lifted at runtime. */
const PAPER_ONLY_LOCK = true;
const LIVE_LOCKED = true;

// The two locks above are fixed product locks on AUTO-CLOSE, not readings of
// the user's account: an armed LIVE_SHARED trader is not "paper-only", yet
// decide.ts words the lock as "paper-only lock active". The decision and its
// blockedReason code are unchanged; only the sentence journalled and returned
// says what is actually true. Display text only — the gate is untouched.
//
// Likewise bridgeConnected is passed as the constant false below, so
// decide.ts's "MT5 bridge disconnected — alert only" is not a reading of the
// user's bridge (the MT5 Bridge page may show it online). That sentence is
// replaced the same way; the ALERT_ONLY decision is unchanged.
const BRIDGE_CONNECTED_INPUT = false;
const PRODUCT_LOCK_REASON =
  "Automatic protective close is switched off for every account in this build (a fixed product lock), so ARX only alerts or recommends here; it never closes a trade by itself. This says nothing about whether your account trades live.";
const BRIDGE_LOCK_REASON =
  "Alert only: automatic protective close does not use your MT5 bridge in this build (a fixed product lock). This is not a reading of your bridge; its live status is on the MT5 Bridge page.";

export function describeLockedDecision(decision: DecisionOutput, bridgeConnectedInput: boolean = BRIDGE_CONNECTED_INPUT): DecisionOutput {
  if (decision.decision === "BLOCKED" && (decision.blockedReason === "BLOCKED_BY_PAPER_LOCK" || decision.blockedReason === "LIVE_LOCKED")) {
    return { ...decision, reason: PRODUCT_LOCK_REASON };
  }
  if (decision.decision === "ALERT_ONLY" && !bridgeConnectedInput && /^MT5 bridge disconnected\b/.test(decision.reason)) {
    return { ...decision, reason: BRIDGE_LOCK_REASON };
  }
  return decision;
}

function parsePositionId(tradeKey: string): number | null {
  const m = /^lp_(\d+)$/.exec(tradeKey);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/**
 * Attribution check: a tradeKey is "clear" only if it maps to a
 * `live_positions` row owned by this user (lp_<id>). Shared-master
 * `att_<id>` keys are treated as attribution-unclear for this slice and
 * the engine will only ALERT — never auto-close them.
 */
async function isAttributionClear(userId: number, tradeKey: string): Promise<boolean> {
  const positionId = parsePositionId(tradeKey);
  if (positionId == null) return false; // att_* or unrecognized
  const [row] = await demoPositionLedger.select(
    { id: demoPositionColumns.id },
    { where: and(eq(demoPositionColumns.id, positionId), eq(demoPositionColumns.userId, userId)), limit: 1 },
  );
  if (row) return true;
  // Belt-and-braces: confirm this user is NOT in the shared-attribution
  // table for the same broker ticket — if shared, attribution is unclear.
  const sharedRows = await db.select({ id: sharedTradeAttributionTable.id })
    .from(sharedTradeAttributionTable)
    .where(eq(sharedTradeAttributionTable.userId, userId))
    .limit(1);
  return sharedRows.length === 0;
}

export interface EngineEvaluation {
  decision: DecisionOutput;
  actionId: number | null;
  attemptedClose: boolean;
}

export async function evaluateTrade(userId: number, tradeKey: string, symbolHint?: string): Promise<EngineEvaluation> {
  const settings = await getEffectiveSettings(userId);
  const activity = await getActivityStatus(userId, settings.inactivityThresholdMin);
  const reversal = await analyzeReversal(userId, tradeKey);
  const attributionClear = await isAttributionClear(userId, tradeKey);
  const recentDuplicate = await hasRecentAttempt(userId, tradeKey, settings.cooldownMin);

  // tradeIsOpen verified by analyzeReversal (which returns INSUFFICIENT when not open).
  // We treat dataStatus=INSUFFICIENT as "we don't know" rather than "not open".
  // SAFETY: only treat the trade as open when a real position row exists.
  // analyzeReversalForTrade returns dataStatus="INSUFFICIENT" when the
  // position is missing/closed. Never default to `true`.
  const tradeIsOpen = reversal.dataStatus !== "INSUFFICIENT" && (!!reversal.invalidationLevel || reversal.currentPnl != null);

  const decision = describeLockedDecision(decideProtectiveAction({
    userId,
    tradeKey,
    symbol: symbolHint ?? "",
    settings,
    activity,
    reversal,
    attributionClear,
    paperOnlyLock: PAPER_ONLY_LOCK,
    liveLocked: LIVE_LOCKED,
    bridgeConnected: BRIDGE_CONNECTED_INPUT, // fixed product lock (not a bridge reading) — keeps engine to ALERT_ONLY
    recentDuplicateClose: recentDuplicate,
    tradeIsOpen,
  }));

  let actionId: number | null = null;
  let attemptedClose = false;

  if (decision.decision === "AUTO_CLOSE_ELIGIBLE") {
    // Today this branch is unreachable in production because paperOnlyLock/
    // liveLocked above force BLOCKED. Defensive code path retained so the
    // future lock-lift is a single deliberate change, not a rewrite.
    try {
      // Position Guardian rule "protective-close": the guardian checks the
      // request against its registry, then drafts and confirms it through the
      // Trade Action Center.
      const r = await guardianTradeActionClose({
        ruleId: "protective-close",
        userId,
        tradeKey,
        closePercent: decision.suggestedClosePercent ?? 100,
        reason: `Protective Auto-Close (policy-authorized): ${decision.reason}`,
      });
      actionId = r.actionId;
      attemptedClose = r.attempted;
      if (r.attempted && r.confirmed && !r.confirmed.ok) {
        logger.warn({ userId, tradeKey, actionId, err: r.error }, "[protective-close] confirm rejected (expected under the auto-close product lock)");
      } else if (!r.authorized) {
        logger.warn({ userId, tradeKey, refusal: r.refusal }, "[protective-close] refused by Position Guardian");
      } else if (!r.attempted) {
        logger.warn({ userId, tradeKey, err: r.error }, "[protective-close] draft creation failed");
      }
    } catch (e) {
      logger.error({ userId, tradeKey, err: String(e).slice(0, 200) }, "[protective-close] eligible-action attempt failed");
    }
  }

  await recordDecision({
    userId,
    tradeKey,
    symbol: symbolHint ?? "",
    decision,
    actionTakenActionId: actionId,
  });

  return { decision, actionId, attemptedClose };
}

/** Called by monitor worker per-user. Defensive; never throws upstream. */
export async function evaluateUserOpenTrades(userId: number, tradeKeys: string[]): Promise<{ evaluated: number; eligible: number; blocked: number; alerts: number }> {
  let evaluated = 0; let eligible = 0; let blocked = 0; let alerts = 0;
  for (const k of tradeKeys) {
    try {
      const r = await evaluateTrade(userId, k);
      evaluated++;
      if (r.decision.decision === "AUTO_CLOSE_ELIGIBLE") eligible++;
      else if (r.decision.decision === "BLOCKED") blocked++;
      else if (r.decision.decision === "ALERT_ONLY" || r.decision.decision === "RECOMMEND_CLOSE" || r.decision.decision === "RECOMMEND_PARTIAL_CLOSE") alerts++;
    } catch (e) {
      logger.warn({ userId, tradeKey: k, err: String(e).slice(0, 200) }, "[protective-close] evaluate failed");
    }
  }
  return { evaluated, eligible, blocked, alerts };
}
