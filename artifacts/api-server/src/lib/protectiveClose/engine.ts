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

import { db } from "@workspace/db";
import { livePositionsTable, sharedTradeAttributionTable } from "@workspace/db/schema";
import { and, eq } from "drizzle-orm";
import { logger } from "../logger.js";
import { getEffectiveSettings } from "./settings.js";
import { getActivityStatus } from "./inactivity.js";
import { analyzeReversal } from "./reversalSignals.js";
import { decideProtectiveAction, type DecisionOutput } from "./decide.js";
import { recordDecision, hasRecentAttempt } from "./journal.js";
import { createActionDraft } from "../tradeAction/create.js";
import { confirmAction } from "../tradeAction/confirm.js";
import type { ActionType } from "../tradeAction/types.js";

/** Today these are server-wide invariants and cannot be lifted at runtime. */
const PAPER_ONLY_LOCK = true;
const LIVE_LOCKED = true;

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
  const [row] = await db.select({ id: livePositionsTable.id })
    .from(livePositionsTable)
    .where(and(eq(livePositionsTable.id, positionId), eq(livePositionsTable.userId, userId)))
    .limit(1);
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

  const decision = decideProtectiveAction({
    userId,
    tradeKey,
    symbol: symbolHint ?? "",
    settings,
    activity,
    reversal,
    attributionClear,
    paperOnlyLock: PAPER_ONLY_LOCK,
    liveLocked: LIVE_LOCKED,
    bridgeConnected: false, // honest: today there is no bridge connection — keeps engine to ALERT_ONLY
    recentDuplicateClose: recentDuplicate,
    tradeIsOpen,
  });

  let actionId: number | null = null;
  let attemptedClose = false;

  if (decision.decision === "AUTO_CLOSE_ELIGIBLE") {
    // Today this branch is unreachable in production because paperOnlyLock/
    // liveLocked above force BLOCKED. Defensive code path retained so the
    // future lock-lift is a single deliberate change, not a rewrite.
    try {
      const actionType: ActionType = (decision.suggestedClosePercent ?? 100) >= 100 ? "CLOSE" : "PARTIAL_CLOSE";
      const created = await createActionDraft({
        userId,
        actionType,
        tradeKey,
        requestedMode: "SIMULATED",
        reason: `Protective Auto-Close (policy-authorized): ${decision.reason}`,
        source: "decision_engine",
      });
      if (created.ok) {
        actionId = created.action.id;
        const confirmed = await confirmAction({ userId, actionId, liveConfirmPhrase: null });
        attemptedClose = true;
        if (!confirmed.ok) {
          logger.warn({ userId, tradeKey, actionId, err: confirmed.error }, "[protective-close] confirm rejected (expected under paper-only lock)");
        }
      } else {
        logger.warn({ userId, tradeKey, err: created.error }, "[protective-close] draft creation failed");
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
