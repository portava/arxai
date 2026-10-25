// Self-Trade AI — Execution Gate (Task #213).
//
// Gathers the LIVE, real-world context for ONE supervisor-approved decision
// (kill switches, master-live access, quota pressure, headroom, daily P/L from
// real fills) and feeds it into the PURE `evaluateExecutionPermission`. The
// output is a verdict + the resolved facts the executor needs.
//
// SAFETY (inviolable):
// - This module is READ-ONLY. It never places, modifies, or closes an order.
// - It is an ADDITIONAL pre-gate on top of the 16 live gates — never a
//   replacement. A PERMIT here only means "the executor may attempt"; the real
//   executeInstant → 16-gate Phase B pipeline still runs and can refuse.
// - Daily P/L, open-position counts, and trades-taken are derived from REAL
//   execution rows / broker positions only — never from intents.

import { livePositionColumns } from "../positions/ledger.js";
import { selectLiveOpenPositions, RISK_COUNT_BASIS } from "../positions/openPositions.js";
import { eq } from "drizzle-orm";
import {
  db,
  selfTradeAgentExecutionsTable,
  type SelfTradeAgent,
  type SelfTradeAgentSettings,
  type SelfTradeAgentLedger,
  type SelfTradeDecision,
} from "@workspace/db";
import {
  evaluateExecutionPermission,
  evaluateQuotaPressure,
  type ExecutionPermissionVerdict,
  type QuotaContext,
  type QuotaPressureVerdict,
  type TradeThesis,
} from "@workspace/domain/self-trade";
import {
  computeQuotaFromSettings,
  countAgentFilledTradesToday,
  startOfUtcDay,
} from "./agentQuotaEngine.js";
import { assertAgentNotKilled, type KillSwitchVerdict } from "./killSwitchGate.js";
import { loadAndEvaluateUserMasterLiveAccessGate } from "../mt5/userMasterLiveAccessGate.js";
import type { FleetSafetyContext } from "./agentExecutor.js";

export interface AgentExecutionGateInput {
  agent: SelfTradeAgent;
  settings: SelfTradeAgentSettings;
  ledger: SelfTradeAgentLedger | null;
  decision: SelfTradeDecision;
  fleet: FleetSafetyContext;
  now?: Date;
}

export interface AgentExecutionGateResult {
  verdict: ExecutionPermissionVerdict;
  executingUserId: number | null;
  hasMasterLiveAccess: boolean;
  kill: KillSwitchVerdict;
  quotaPressure: QuotaPressureVerdict;
  /** quota-pressure size mult × reduced-outcome 0.5 (APPROVED_REDUCED). */
  sizeMultiplier: number;
  thesis: TradeThesis | null;
  dailyPnlUsd: number;
  openPositionsCount: number;
  tradesTakenToday: number;
}

// agent.ownerId (USER-owned) takes priority; fall back to the operator who
// created a fleet agent. null ⇒ no executing identity (honest block downstream).
export function resolveExecutingUserId(agent: SelfTradeAgent): number | null {
  return agent.ownerId ?? agent.createdByUserId ?? null;
}

function toQuotaContext(
  v: ReturnType<typeof computeQuotaFromSettings>,
  tradesTakenToday: number,
): QuotaContext {
  return {
    dailyMinTrades: v.dailyMinTrades,
    effectiveMaxTrades: v.effectiveMaxTrades,
    tradesTakenToday,
    remainingToMax: Math.max(0, v.effectiveMaxTrades - tradesTakenToday),
    belowDailyMinimum: tradesTakenToday < v.dailyMinTrades,
    baseReached: tradesTakenToday >= v.baseMaxTrades,
    hardCapReached: tradesTakenToday >= v.effectiveMaxTrades,
  };
}

/**
 * Realized P/L for the day from CLOSED executions (real fills only) PLUS the
 * floating P/L of still-open FILLED executions (read from the real broker
 * arx_live_positions rows). Executions whose realized P/L could not be computed
 * from genuine fills contribute 0 — never an invented number.
 */
export async function computeAgentDailyPnlUsd(
  agentId: number,
  executingUserId: number | null,
  now: Date,
): Promise<{ dailyPnlUsd: number; openPositionsCount: number }> {
  const start = startOfUtcDay(now);
  const execs = await db
    .select()
    .from(selfTradeAgentExecutionsTable)
    .where(eq(selfTradeAgentExecutionsTable.agentId, agentId));

  let realizedToday = 0;
  for (const e of execs) {
    if (e.status !== "CLOSED") continue;
    if (!e.closedAt || e.closedAt < start) continue;
    if (e.realizedPnl != null) realizedToday += e.realizedPnl;
  }

  const filled = execs.filter((e) => e.status === "FILLED" && e.brokerTicket != null);

  // openPositionsCount (the MAX_CONCURRENT_POSITIONS input) counts on the Risk
  // Governor's conservative basis, RISK_COUNT_BASIS = UNCLOSED (owner decision
  // 6): a FILLED execution whose live row is still not closed counts, even when
  // an operator labelled it IGNORED / EXTERNAL / IMPORTED, because a label is
  // not a broker-confirmed close and the position may still stand at the
  // broker. Only a stamped closed_at (a real close, or the broker-absence
  // reconciler) removes it. It is derived from the live rows, never from
  // filled.length, so an execution with no live row does not count.
  //
  // Floating P/L is a separate figure and stays on EXPOSURE: a reconciled
  // ghost carries no live exposure, so its floating P/L is not summed
  // (consistent with getUserAllocationView and recomputeMasterPool).
  let openPositionsCount = 0;
  let floating = 0;
  if (executingUserId != null && filled.length > 0) {
    const tickets = filled.map((e) => e.brokerTicket as string);
    const unclosed = await selectLiveOpenPositions({ id: livePositionColumns.id }, {
      userId: executingUserId,
      basis: RISK_COUNT_BASIS,
      tickets,
    });
    openPositionsCount = unclosed.length;
    const exposure = await selectLiveOpenPositions(livePositionColumns, {
      userId: executingUserId,
      basis: "EXPOSURE",
      tickets,
    });
    for (const p of exposure) {
      if (p.floatingPl != null) floating += Number(p.floatingPl);
    }
  }

  return { dailyPnlUsd: round2(realizedToday + floating), openPositionsCount };
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Gather live context + run the pure permission evaluator for one decision.
 */
export async function evaluateAgentExecution(
  input: AgentExecutionGateInput,
): Promise<AgentExecutionGateResult> {
  const { agent, settings, ledger, decision, fleet } = input;
  const now = input.now ?? new Date();

  const executingUserId = resolveExecutingUserId(agent);
  const thesis = (decision.thesis as TradeThesis | null) ?? null;

  // Master-live access — honest, attributed pre-check (the pipeline re-checks).
  let hasMasterLiveAccess = false;
  if (executingUserId != null) {
    const gate = await loadAndEvaluateUserMasterLiveAccessGate(executingUserId);
    hasMasterLiveAccess = gate.decision !== "BLOCKED";
  }

  const kill = await assertAgentNotKilled({
    agentKey: agent.agentKey,
    symbol: decision.symbol,
    strategy: decision.setupType ?? null,
  });

  const tradesTakenToday = await countAgentFilledTradesToday(agent.id, now);
  const { dailyPnlUsd, openPositionsCount } = await computeAgentDailyPnlUsd(
    agent.id,
    executingUserId,
    now,
  );

  const quota = toQuotaContext(
    computeQuotaFromSettings(settings, tradesTakenToday),
    tradesTakenToday,
  );

  const quotaPressure = evaluateQuotaPressure({
    dailyPnlUsd,
    maxDailyLossUsd: settings.maxDailyLossUsd,
    dailyProfitGoalUsd: settings.dailyProfitGoalUsd,
    quota,
    baseMinScore: 0,
  });

  const funded = (ledger?.allocatedFunds ?? 0) > 0;

  const verdict = evaluateExecutionPermission({
    agentStatus: agent.status,
    agentMode: agent.mode,
    autonomyLevel: agent.autonomyLevel,
    outcome: decision.outcome as never,
    thesis,
    setupExpiresAt: decision.setupExpiresAt ? decision.setupExpiresAt.toISOString() : null,
    funded,
    quota,
    governor: fleet.governor,
    handshake: fleet.handshake,
    killEngaged: kill.killed,
    openPositionsCount,
    maxConcurrentPositions: settings.maxConcurrentPositions,
    executingUserId,
    hasMasterLiveAccess,
    now: now.getTime(),
  });

  const reducedMult = decision.outcome === "APPROVED_REDUCED" ? 0.5 : 1;
  const sizeMultiplier = round2(quotaPressure.sizeMultiplier * reducedMult);

  return {
    verdict,
    executingUserId,
    hasMasterLiveAccess,
    kill,
    quotaPressure,
    sizeMultiplier,
    thesis,
    dailyPnlUsd,
    openPositionsCount,
    tradesTakenToday,
  };
}
