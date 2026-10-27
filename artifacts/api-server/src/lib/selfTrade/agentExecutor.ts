// Self-Trade AI — Agent Executor (Task #213).
//
// Turns ONE supervisor-approved decision into a REAL autonomous live entry by
// riding the EXISTING Trade Engine one-click leg (submitInstantTrade →
// executeInstant) → createLiveDraft → confirm → dispatch →
// 16-gate Phase B pipeline → master bridge. It records every attempt in
// self_trade_agent_executions and reconciles real outcomes from
// arx_live_commands.
//
// SAFETY (inviolable):
// - There is NO new MT5 path and NO gate bypass. Every live order goes through
//   the Trade Engine (submitInstantTrade → executeInstant), which runs
//   master-live access + one-click + rate-limit
//   pre-gates and then the 16 Phase B gates. This module cannot weaken any gate.
// - dispatch ≠ fill. A DISPATCHED row means the command reached the bridge. A
//   row becomes FILLED ONLY when a real brokerTicket + LIVE_FILLED arrives via
//   reconcile. Fills are never fabricated.
// - Atomic agent admission: PENDING_TICKET reserves concurrency/daily capacity
//   before submission. Agent-row locking serializes distinct decisions; a
//   decision key stays consumed after terminal outcomes. Unknowns retain slots.
// - TOCTOU: the kill switch is re-checked immediately before dispatch.

import { and, eq } from "drizzle-orm";
import {
  db,
  selfTradeAgentExecutionsTable,
  type SelfTradeAgent,
  type SelfTradeAgentSettings,
  type SelfTradeAgentLedger,
  type SelfTradeDecision,
  type SelfTradeAgentExecution,
} from "@workspace/db";
import {
  computeRiskAwareLot,
  riskAwareLotBlockReason,
  type GovernorContext,
  type HandshakeReadinessContext,
} from "@workspace/domain/self-trade";
import { logger } from "../logger.js";
import { submitInstantTrade } from "../tradeEngine/pipeline.js";
import { routeQuote } from "../data/marketDataRouter.js";
import {
  FX_STANDARD_LOT_UNITS,
  isForexPair,
  resolveContractSize,
  resolveQuoteToAccountFx,
} from "../mt5/contractSize.js";
import { getAccountCurrency } from "../live/accountCurrency.js";
import { reserveAgentEntry } from "./entryReservation.js";
import { evaluateAgentExecution } from "./executionGate.js";
import { assertAgentNotKilled } from "./killSwitchGate.js";
import { writeSelfTradeAudit } from "./audit.js";
import { evaluateAaciExecutionAdvisory } from "../aaci/executionAdvisory.js";

export interface FleetSafetyContext {
  governor: GovernorContext;
  handshake: HandshakeReadinessContext;
}

export type AgentExecutionStatus =
  | "DISPATCHED"
  | "PREPARED"
  | "BLOCKED"
  | "LOG_ONLY"
  | "SKIPPED_DUPLICATE"
  | "AACI_DEFERRED";

export interface AgentExecutionOutcome {
  status: AgentExecutionStatus;
  executionId?: number;
  commandId?: string;
  blockReason?: string;
  action: string;
}

export interface ExecuteAgentDecisionInput {
  agent: SelfTradeAgent;
  settings: SelfTradeAgentSettings;
  ledger: SelfTradeAgentLedger | null;
  decision: SelfTradeDecision;
  fleet: FleetSafetyContext;
  actorUserId?: number | null;
  actorRole?: string | null;
  now?: Date;
}

const LOT_MIN = 0.01;
const LOT_STEP = 0.01;

// Per-lot contract size used to size the agent's position from its risk budget.
//
// P0-2 — this used `/^[A-Z]{6}$/.test(symbol) ? 100_000 : null`, which is the
// exact loose classifier the strict one exists to replace. Six capital letters
// does NOT mean "spot forex": XAUUSD (gold, contract size 100), XAGUSD (silver,
// 5,000) and BTCUSD (crypto, typically 1) all match it and were sized as if
// they were 100,000-unit FX lots — over-sizing a gold position 1,000x relative
// to the intended risk budget.
//
// Now: broker truth (arx_symbol_specs.contractSize) first, and the 100,000-unit
// FX standard lot ONLY when BOTH halves of the symbol are real ISO-4217 fiat
// codes. Anything else still refuses to size (honest NO_CONTRACT_SPEC block)
// rather than inventing a number.
//
// D2 — the value must be contractSize × QUOTE→ACCOUNT FX, not contractSize
// alone. computeRiskAwareLot divides an account-currency risk budget by
// `stopDistance × valuePerUnitPerLot`; the stop distance is measured in QUOTE
// currency, so without the conversion the two sides of that division are in
// different units and every non-account-quote pair is mis-sized. (USDJPY on a
// USD account: the factor is 1/price, so the omission made riskPerLot ~150×
// too large and the lot ~150× too small.)
//
// This is the entry-side analogue of the P0-2 close-side bug and deliberately
// reuses the SAME helper that fix introduced, so the two sides cannot drift.
// The header above always claimed "contractSize × quote-conv"; the conversion
// was documented but never applied.
type EntryValuePerLot =
  | { ok: true; value: number }
  | { ok: false; blockReason: "NO_CONTRACT_SPEC" | "NO_QUOTE_FX" };

async function valuePerUnitPerLotFor(
  userId: number | null,
  symbol: string,
  entryPrice: number,
): Promise<EntryValuePerLot> {
  if (userId == null) {
    // No user context → no broker spec and no account currency to consult.
    // Fall back to the strict classifier only, never the loose one. A fiat pair
    // sized here is assumed account-quoted; anything else refuses.
    return isForexPair(symbol)
      ? { ok: true, value: FX_STANDARD_LOT_UNITS }
      : { ok: false, blockReason: "NO_CONTRACT_SPEC" };
  }

  const sizing = await resolveContractSize(userId, symbol);
  if (sizing.contractSize == null) return { ok: false, blockReason: "NO_CONTRACT_SPEC" };

  const accountCurrency = await getAccountCurrency(userId);
  const fx = resolveQuoteToAccountFx({
    symbol,
    profitCurrency: sizing.profitCurrency,
    accountCurrency,
    // The entry price plays the role the close price plays on the realized
    // side: it is the rate at which an INVERSE_QUOTE factor is 1/price.
    closePrice: entryPrice,
  });
  // Honest refusal. Falling back to a factor of 1 would silently assume the
  // quote currency IS the account currency — exactly the mis-sizing being fixed.
  if (fx.factor == null) return { ok: false, blockReason: "NO_QUOTE_FX" };

  return { ok: true, value: sizing.contractSize * fx.factor };
}

function entryPriceFromThesis(thesis: { entryZone: { from: number; to: number } | null }): number | null {
  if (thesis.entryZone && Number.isFinite(thesis.entryZone.from) && Number.isFinite(thesis.entryZone.to)) {
    return (thesis.entryZone.from + thesis.entryZone.to) / 2;
  }
  return null;
}

/**
 * Execute (or honestly refuse) one supervisor-approved decision.
 */
export async function executeAgentDecision(
  input: ExecuteAgentDecisionInput,
): Promise<AgentExecutionOutcome> {
  const { agent, settings, decision, actorUserId, actorRole } = input;
  const now = input.now ?? new Date();

  const gate = await evaluateAgentExecution({
    agent,
    settings,
    ledger: input.ledger,
    decision,
    fleet: input.fleet,
    now,
  });
  const { verdict, thesis, executingUserId } = gate;

  // LOG_ONLY (SHADOW / L0): record the intent in the audit trail only — never a
  // row in the execution ledger, never a dispatch.
  if (verdict.action === "LOG_ONLY") {
    await writeSelfTradeAudit(db, {
      agentId: agent.id,
      eventType: "EXECUTION_LOG_ONLY",
      actorUserId: actorUserId ?? null,
      actorRole: actorRole ?? null,
      severity: "INFO",
      afterState: { decisionId: decision.id, reasons: verdict.reasons },
      reason: verdict.reasons[0] ?? "Logged only.",
    });
    return { status: "LOG_ONLY", action: verdict.action };
  }

  // Hard BLOCK. Persist a BLOCKED execution row ONLY when this is a real live
  // attempt (mode LIVE + autonomy ≥ 1) so the control room sees the refusal in
  // the executions feed; otherwise audit-only.
  if (!verdict.permitted || verdict.action === "BLOCK") {
    const blockReason = verdict.blockCode ?? "BLOCKED";
    if (agent.mode === "LIVE" && agent.autonomyLevel >= 1) {
      const [row] = await db
        .insert(selfTradeAgentExecutionsTable)
        .values({
          agentId: agent.id,
          agentKey: agent.agentKey,
          decisionId: decision.id,
          cycleId: decision.cycleId,
          symbol: decision.symbol,
          side: decision.side ?? "BUY",
          autonomyLevel: agent.autonomyLevel,
          mode: agent.mode,
          executingUserId,
          intendedVolume: 0,
          idempotencyKey: `decision:${decision.id}`,
          status: "BLOCKED",
          blockReason,
        })
        .onConflictDoNothing()
        .returning();
      await writeSelfTradeAudit(db, {
        agentId: agent.id,
        eventType: "EXECUTION_BLOCKED",
        actorUserId: actorUserId ?? null,
        actorRole: actorRole ?? null,
        severity: "WARNING",
        afterState: { decisionId: decision.id, blockReason, reasons: verdict.reasons },
        reason: verdict.reasons[0] ?? blockReason,
      });
      return { status: "BLOCKED", executionId: row?.id, blockReason, action: "BLOCK" };
    }
    await writeSelfTradeAudit(db, {
      agentId: agent.id,
      eventType: "EXECUTION_BLOCKED",
      actorUserId: actorUserId ?? null,
      actorRole: actorRole ?? null,
      severity: "WARNING",
      afterState: { decisionId: decision.id, blockReason, reasons: verdict.reasons },
      reason: verdict.reasons[0] ?? blockReason,
    });
    return { status: "BLOCKED", blockReason, action: "BLOCK" };
  }

  // Permitted (EXECUTE or PREPARE_ONLY). We must have a thesis + executing user.
  if (thesis == null || executingUserId == null) {
    return { status: "BLOCKED", blockReason: "NO_THESIS_OR_USER", action: "BLOCK" };
  }
  const side = thesis.side;

  // ── AACI advisory pre-execution cohesion check ────────────────────────────
  // Runs ONLY after the existing gate already permitted, and only ever ADDS
  // caution: it can defer (no dispatch), force prepare-only, or reduce size. A
  // positive verdict still flows through the full 16-gate executeInstant
  // pipeline below. Fail-open: an unavailable AACI degrades to prepare-only.
  const signalAgeMs = decision.createdAt
    ? Math.max(0, now.getTime() - new Date(decision.createdAt).getTime())
    : 0;
  const { advisory } = await evaluateAaciExecutionAdvisory({
    executingUserId,
    agentId: agent.id,
    agentKey: agent.agentKey,
    agentName: agent.name ?? undefined,
    autonomyLevel: agent.autonomyLevel,
    funded: (input.ledger?.allocatedFunds ?? 0) > 0,
    active: true,
    symbol: decision.symbol,
    signalAgeMs,
  });

  if (!advisory.proceed && !advisory.downgradeToPrepareOnly) {
    // AACI defers: record the refusal (the decision row is already persisted)
    // and stop short of any dispatch. No execution-ledger row for a non-attempt.
    await writeSelfTradeAudit(db, {
      agentId: agent.id,
      eventType: "EXECUTION_AACI_DEFERRED",
      actorUserId: actorUserId ?? null,
      actorRole: actorRole ?? null,
      severity: "WARNING",
      afterState: {
        decisionId: decision.id,
        symbol: decision.symbol,
        side,
        recommendedAction: advisory.recommendedAction,
        finalAaciScore: advisory.finalAaciScore,
        hardGatePass: advisory.hardGatePass,
        blockReason: advisory.blockReason,
      },
      reason: advisory.reason,
    });
    return {
      status: "AACI_DEFERRED",
      blockReason: advisory.blockReason ?? "AACI_DEFERRED",
      action: side,
    };
  }

  // Entry price: thesis entry-zone midpoint, else a real routed quote. Never a
  // fabricated price — if neither is available we block.
  let entryPrice = entryPriceFromThesis(thesis);
  if (entryPrice == null) {
    const q = await routeQuote(decision.symbol);
    const mid =
      q.ok && q.quote
        ? q.quote.bid != null && q.quote.ask != null
          ? (q.quote.bid + q.quote.ask) / 2
          : q.quote.last ?? null
        : null;
    entryPrice = mid;
  }
  if (entryPrice == null || !Number.isFinite(entryPrice) || entryPrice <= 0) {
    return { status: "BLOCKED", blockReason: "NO_ENTRY_PRICE", action: "BLOCK" };
  }

  const valuePerLot = await valuePerUnitPerLotFor(executingUserId, decision.symbol, entryPrice);
  if (!valuePerLot.ok) {
    return { status: "BLOCKED", blockReason: valuePerLot.blockReason, action: "BLOCK" };
  }
  const valuePerUnitPerLot = valuePerLot.value;

  const availableFunds = input.ledger?.availableFunds ?? 0;
  const riskBudgetUsd = (availableFunds * settings.riskPerTradePct) / 100;

  // The sizer maps a multiplier <= 0 / NaN to its defensive default of 1 (full
  // size). Every upstream factor is a REDUCTION, so a zero or non-finite
  // product here means "do not trade" and must refuse, never size at 100%.
  const composedSizeMultiplier = gate.sizeMultiplier * advisory.sizeMultiplier;
  if (!(Number.isFinite(composedSizeMultiplier) && composedSizeMultiplier > 0)) {
    return { status: "BLOCKED", blockReason: "NON_POSITIVE_SIZE_MULTIPLIER", action: "BLOCK" };
  }

  const lotResult = computeRiskAwareLot({
    side,
    entryPrice,
    stopLossPrice: thesis.stopLoss ?? null,
    riskBudgetUsd,
    valuePerUnitPerLot,
    minLot: LOT_MIN,
    maxLot: settings.maxLotPerTrade,
    lotStep: LOT_STEP,
    agentMaxLot: settings.maxLotPerTrade,
    sizeMultiplier: composedSizeMultiplier,
  });
  // Refuse — never upsize — when only the broker-minimum lot is legal and it
  // risks more than the (multiplier-reduced) budget (withinRiskBudget=false).
  const lotBlockReason = riskAwareLotBlockReason(lotResult);
  if (lotBlockReason != null) {
    return { status: "BLOCKED", blockReason: lotBlockReason, action: "BLOCK" };
  }

  // Atomically reserve per-agent concurrency and daily headroom using fresh
  // identity/settings/funding/decision rows, before the pipeline can see it.
  let execRow: SelfTradeAgentExecution;
  try {
    const reservation = await reserveAgentEntry({ agent, settings, ledger: input.ledger,
      decision, executingUserId, actorUserId, actorRole, side, volume: lotResult.lot,
      stopLoss: thesis.stopLoss ?? null, takeProfit: thesis.takeProfits[0]?.from ?? null });
    if (!reservation.ok) return {
      status: reservation.duplicate ? "SKIPPED_DUPLICATE" : "BLOCKED",
      blockReason: reservation.reason, action: verdict.action,
    };
    execRow = reservation.execution;
  } catch (err) {
    logger.error({ err, decisionId: decision.id }, "self-trade: entry reservation unavailable");
    return { status: "BLOCKED", blockReason: "ENTRY_RESERVATION_UNAVAILABLE", action: "BLOCK" };
  }

  // TOCTOU: re-check the kill switch immediately before dispatch.
  const killNow = await assertAgentNotKilled({
    agentKey: agent.agentKey,
    symbol: decision.symbol,
    strategy: decision.setupType ?? null,
  });
  if (killNow.killed) {
    await db
      .update(selfTradeAgentExecutionsTable)
      .set({ status: "BLOCKED", blockReason: killNow.reason ?? "KILL_SWITCH_ENGAGED", updatedAt: new Date() })
      .where(and(eq(selfTradeAgentExecutionsTable.id, execRow.id),
        eq(selfTradeAgentExecutionsTable.status, "PENDING_TICKET")));
    await writeSelfTradeAudit(db, {
      agentId: agent.id,
      eventType: "EXECUTION_BLOCKED_TOCTOU",
      actorUserId: actorUserId ?? null,
      actorRole: actorRole ?? null,
      severity: "WARNING",
      afterState: { executionId: execRow.id, kill: killNow },
      reason: killNow.reason ?? "Kill switch engaged at dispatch.",
    });
    return { status: "BLOCKED", executionId: execRow.id, blockReason: killNow.reason ?? "KILL_SWITCH_ENGAGED", action: "BLOCK" };
  }

  const prepareOnly = verdict.action === "PREPARE_ONLY" || advisory.downgradeToPrepareOnly;

  // Audit the dispatch INTENT before it leaves (fail-closed evidence).
  await writeSelfTradeAudit(db, {
    agentId: agent.id,
    eventType: prepareOnly ? "EXECUTION_PREPARE_INTENT" : "EXECUTION_DISPATCH_INTENT",
    actorUserId: actorUserId ?? null,
    actorRole: actorRole ?? null,
    severity: "INFO",
    afterState: {
      executionId: execRow.id,
      decisionId: decision.id,
      symbol: decision.symbol,
      side,
      volume: lotResult.lot,
      stopLoss: thesis.stopLoss,
      sizeMultiplier: gate.sizeMultiplier,
      aaciSizeMultiplier: advisory.sizeMultiplier,
      aaciAction: advisory.recommendedAction,
      aaciScore: advisory.finalAaciScore,
    },
    reason: prepareOnly ? "Staging prepare-only draft." : "Dispatching autonomous live entry.",
  });

  const res = await submitInstantTrade({
    userId: executingUserId,
    intent: {
      source: "self_trade",
      action: side,
      accountMode: "live",
      symbol: decision.symbol,
      volume: lotResult.lot,
      stopLoss: thesis.stopLoss ?? null,
      takeProfit: thesis.takeProfits[0]?.from ?? null,
      oneClick: true,
      prepareOnly,
      selfTradeAgentId: agent.id,
      selfTradeDecisionId: decision.id,
      selfTradeAgentKey: agent.agentKey,
      selfTradeExecutionId: execRow.id,
    },
  });

  if (!res.ok) {
    const blockReason = res.primaryReason ?? res.error;
    await db
      .update(selfTradeAgentExecutionsTable)
      .set({
        // A failure after draft creation can still be unknown at the broker.
        // Keep capacity until reconciliation proves non-execution.
        status: res.commandId ? "PENDING_TICKET" : "BLOCKED",
        commandId: res.commandId ?? null, blockReason, updatedAt: new Date(),
      })
      .where(and(eq(selfTradeAgentExecutionsTable.id, execRow.id),
        eq(selfTradeAgentExecutionsTable.status, "PENDING_TICKET")));
    return { status: "BLOCKED", executionId: execRow.id, blockReason, action: side };
  }

  if (prepareOnly) {
    // L1: draft staged. Keep PENDING_TICKET (awaiting human confirm); attach the
    // command id so the control room can link the staged draft.
    await db
      .update(selfTradeAgentExecutionsTable)
      .set({ commandId: res.commandId ?? null, updatedAt: new Date() })
      .where(and(eq(selfTradeAgentExecutionsTable.id, execRow.id),
        eq(selfTradeAgentExecutionsTable.status, "PENDING_TICKET")));
    return { status: "PREPARED", executionId: execRow.id, commandId: res.commandId, action: side };
  }

  // Dispatched to the bridge (NOT a fill). Reconcile resolves the real outcome.
  await db
    .update(selfTradeAgentExecutionsTable)
    .set({ status: "DISPATCHED", commandId: res.commandId ?? null, openedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(selfTradeAgentExecutionsTable.id, execRow.id),
      eq(selfTradeAgentExecutionsTable.status, "PENDING_TICKET")));
  return { status: "DISPATCHED", executionId: execRow.id, commandId: res.commandId, action: side };
}

export { reconcileAgentExecutions, type ReconcileResult } from "./agentReconciliation.js";

// Re-exported so callers can scope reconcile to one agent's active rows.
export type { SelfTradeAgentExecution };
