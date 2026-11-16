// Build TT — Live Order Execution Guard.
//
// INVIOLABLE SAFETY DESIGN:
// This module exposes ONE function — placeLiveOrderGuarded — which is the
// SOLE supported path for live order placement. In this build, that function
// is a HARDENED STUB: it runs every safety check and then ALWAYS returns
// REJECTED with reason "BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED".
//
// There is no broker integration code in this file. There is no MT5 import.
// There is no execute-trade fetch. There is no live order send. Even a
// fully-armed, fully-approved trade card cannot reach a real broker through
// this module — by design, no such code path exists.

import { randomUUID } from "node:crypto";
import { db } from "@workspace/db";
import { liveTradeApprovalsTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { getState } from "./state.js";
import { computeReadiness } from "./readiness.js";
import { MICRO_LIVE_LIMITS } from "./limits.js";
import { recordLiveAudit } from "./audit.js";

export interface PlaceLiveOrderArgs {
  approvalId: string;
  idempotencyKey: string;
  actorRole: string;
  actorSession?: string;
  brokerHealthy: boolean;
  spreadPips: number;
  symbolAllowlisted: boolean;
  openLivePositions: number;
}

export interface PlaceLiveOrderResult {
  status: "REJECTED";          // Only REJECTED is reachable in this build.
  reason: string;
  failedChecks: string[];
  approvalId: string;
  auditEventId: string;
}

export async function placeLiveOrderGuarded(args: PlaceLiveOrderArgs): Promise<PlaceLiveOrderResult> {
  const failed: string[] = [];

  // Preconditions — every one must pass before placement is even contemplated.
  const state = await getState();
  if (state.mode !== "MICRO_LIVE") failed.push("MODE_NOT_MICRO_LIVE");
  if (!state.armed) failed.push("NOT_ARMED");
  if (state.killSwitchActive) failed.push("KILL_SWITCH_ACTIVE");
  if (state.emergencyStopActive) failed.push("EMERGENCY_STOP_ACTIVE");

  const approvalRows = await db.select().from(liveTradeApprovalsTable)
    .where(eq(liveTradeApprovalsTable.approvalId, args.approvalId)).limit(1);
  const approval = approvalRows[0];
  if (!approval) failed.push("APPROVAL_NOT_FOUND");
  else {
    if (approval.status !== "APPROVED") failed.push("APPROVAL_NOT_APPROVED");
    if (approval.idempotencyKey !== args.idempotencyKey) failed.push("IDEMPOTENCY_MISMATCH");
    if (approval.expiresAt.getTime() < Date.now()) failed.push("APPROVAL_EXPIRED");
    if (approval.consumedAt) failed.push("DUPLICATE_ORDER_PREVENTED");
    if (approval.lotSize > MICRO_LIVE_LIMITS.MAX_LOT_SIZE) failed.push("LOT_SIZE_EXCEEDS_CAP");
    if (approval.riskPercent > MICRO_LIVE_LIMITS.MAX_RISK_PCT_PER_TRADE) failed.push("RISK_PCT_EXCEEDS_CAP");
    if (approval.confidenceScore < MICRO_LIVE_LIMITS.MIN_CONFIDENCE_SCORE) failed.push("CONFIDENCE_BELOW_THRESHOLD");
    if (!approval.stopLoss) failed.push("MISSING_STOP_LOSS");
    if (!approval.takeProfit) failed.push("MISSING_TAKE_PROFIT");
  }

  const readiness = await computeReadiness(args.actorRole);
  if (!readiness.liveTradingEligible) failed.push("READINESS_NOT_ELIGIBLE");

  if (!args.brokerHealthy) failed.push("BROKER_UNHEALTHY");
  if (!args.symbolAllowlisted) failed.push("SYMBOL_NOT_ALLOWLISTED");
  if (args.spreadPips > MICRO_LIVE_LIMITS.MAX_SPREAD_PIPS) failed.push("SPREAD_TOO_HIGH");
  if (args.openLivePositions >= MICRO_LIVE_LIMITS.MAX_OPEN_LIVE_POSITIONS) failed.push("OPEN_POSITION_LIMIT_REACHED");
  if (state.liveTradesToday >= MICRO_LIVE_LIMITS.MAX_LIVE_TRADES_PER_DAY) failed.push("DAILY_TRADE_LIMIT_REACHED");
  if (state.liveTradesSession >= MICRO_LIVE_LIMITS.MAX_LIVE_TRADES_PER_SESSION) failed.push("SESSION_TRADE_LIMIT_REACHED");
  if (state.dailyLossPct >= MICRO_LIVE_LIMITS.MAX_DAILY_LOSS_PCT) failed.push("DAILY_LOSS_LIMIT_BREACHED");
  if (state.weeklyLossPct >= MICRO_LIVE_LIMITS.MAX_WEEKLY_LOSS_PCT) failed.push("WEEKLY_LOSS_LIMIT_BREACHED");
  if (state.consecutiveLiveLosses >= MICRO_LIVE_LIMITS.MAX_CONSECUTIVE_LIVE_LOSSES) failed.push("CONSECUTIVE_LOSSES_LIMIT");

  // === INVIOLABLE FINAL GATE ===
  // Even if every check above passed, this build rejects placement at the
  // code level. There is no broker integration. There is no MT5 send. There
  // is no order route. The system cannot, by construction, place live orders.
  failed.push("BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED");

  const eventId = await recordLiveAudit({
    eventType: "ORDER_REJECTED", severity: "CRITICAL",
    mode: state.mode, symbol: approval?.symbol ?? null,
    approvalId: args.approvalId, actorRole: args.actorRole, actorSession: args.actorSession,
    riskScore: approval?.riskScore ?? null, confidenceScore: approval?.confidenceScore ?? null,
    message: `Live order REJECTED — ${failed.length} failed check(s). Build TT has no broker placement layer.`,
    metadata: { failedChecks: failed, idempotencyKey: args.idempotencyKey, openLivePositions: args.openLivePositions, spreadPips: args.spreadPips },
  });

  // Mark idempotency to prevent retries from reaching even this stub a second time.
  if (approval) {
    await db.update(liveTradeApprovalsTable)
      .set({ status: "BLOCKED", consumedAt: new Date(), consumedResult: { failedChecks: failed, eventId } })
      .where(eq(liveTradeApprovalsTable.approvalId, args.approvalId));
  }

  return {
    status: "REJECTED",
    reason: "BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED",
    failedChecks: failed,
    approvalId: args.approvalId,
    auditEventId: eventId,
  };
}

export interface GenerateApprovalArgs {
  symbol: string;
  direction: "BUY" | "SELL";
  entry: number;
  stopLoss: number;
  takeProfit: number;
  lotSize: number;
  riskAmount: number;
  riskPercent: number;
  confidenceScore: number;
  riskScore: number;
  reasonForTrade: string;
  invalidationReason: string;
  maxLossIfWrong: number;
  decisionId?: number;
  actorRole: string;
}

export async function generateApproval(args: GenerateApprovalArgs): Promise<{
  approvalId: string; idempotencyKey: string; expiresAt: Date;
}> {
  const approvalId = `lapp_${randomUUID()}`;
  const idempotencyKey = `idem_${randomUUID()}`;
  const expiresAt = new Date(Date.now() + MICRO_LIVE_LIMITS.APPROVAL_TTL_SECONDS * 1000);
  await db.insert(liveTradeApprovalsTable).values({
    approvalId, idempotencyKey, status: "PENDING",
    symbol: args.symbol, direction: args.direction,
    entryPrice: args.entry, stopLoss: args.stopLoss, takeProfit: args.takeProfit,
    lotSize: args.lotSize, riskAmount: args.riskAmount, riskPercent: args.riskPercent,
    confidenceScore: args.confidenceScore, riskScore: args.riskScore,
    reasonForTrade: args.reasonForTrade, invalidationReason: args.invalidationReason,
    maxLossIfWrong: args.maxLossIfWrong,
    decisionId: args.decisionId ?? null,
    expiresAt, generatedBy: args.actorRole,
  });
  await recordLiveAudit({
    eventType: "APPROVAL_GENERATED", severity: "INFO",
    symbol: args.symbol, approvalId, decisionId: args.decisionId ?? null,
    riskScore: args.riskScore, confidenceScore: args.confidenceScore,
    actorRole: args.actorRole,
    message: `Trade card generated for ${args.direction} ${args.symbol} (lot ${args.lotSize}, risk ${args.riskPercent}%)`,
    metadata: { entry: args.entry, stopLoss: args.stopLoss, takeProfit: args.takeProfit, expiresAt },
  });
  return { approvalId, idempotencyKey, expiresAt };
}
