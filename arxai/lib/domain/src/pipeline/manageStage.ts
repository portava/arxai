import { computeTradeHealth } from "../trade/tradeHealth.engine";
import { createDomainEvent } from "../events/eventFactory";
import type { Trade, TradeSnapshot } from "../trade/trade.types";
import type { MonitorPort, ExecutionPort } from "./ports";
import type { PipelineContext, StageResult, ManageOutput } from "./pipeline.types";

export interface ManageStageInput {
  trades: Trade[];
  // BE move kicks in once unrealized R-multiple crosses this threshold.
  breakevenAtR?: number;
  // Trailing stop activates after this R-multiple, trailing by ATR multiple.
  trailAfterR?: number;
  trailAtrMultiple?: number;
  atrBySymbol?: Record<string, number>;
}

// Pure decision: given a trade snapshot, what should we do?
export function decideManagement(snap: TradeSnapshot, opts: {
  breakevenAtR?: number;
  trailAfterR?: number;
  trailAtrMultiple?: number;
  atr?: number;
} = {}): ManageOutput {
  const breakevenAtR = opts.breakevenAtR ?? 1;
  const trailAfterR  = opts.trailAfterR  ?? 1.5;
  const trailAtrMul  = opts.trailAtrMultiple ?? 1.5;
  const health = computeTradeHealth(snap);
  const t = snap.trade;
  const sign = t.direction === "BUY" ? 1 : -1;

  if (health.state === "CRITICAL") {
    return { tradeId: t.id, action: "FULL_CLOSE", reason: "Critical health — exit before SL hit" };
  }
  if (opts.atr && health.rMultiple >= trailAfterR) {
    const trailDistance = opts.atr * trailAtrMul;
    const newSL = snap.currentPrice - sign * trailDistance;
    // never widen the stop
    const isTighter = sign > 0 ? newSL > t.stopLoss : newSL < t.stopLoss;
    if (isTighter) {
      return { tradeId: t.id, action: "TRAIL", newStopLoss: newSL, reason: `Trailing ${trailAtrMul}× ATR after ${health.rMultiple.toFixed(2)}R` };
    }
  }
  if (health.rMultiple >= breakevenAtR) {
    const isTighter = sign > 0 ? t.entryPrice > t.stopLoss : t.entryPrice < t.stopLoss;
    if (isTighter) {
      return { tradeId: t.id, action: "MOVE_SL", newStopLoss: t.entryPrice, reason: `Move to break-even at ${health.rMultiple.toFixed(2)}R` };
    }
  }
  return { tradeId: t.id, action: "HOLD", reason: `Health ${health.state} (${health.rMultiple.toFixed(2)}R)` };
}

// IO stage — fetches snapshots via MonitorPort and applies actions via
// ExecutionPort. Returns one StageResult per trade processed, aggregated.
export async function runManage(
  ctx: PipelineContext,
  input: ManageStageInput,
  monitor: MonitorPort,
  execution: ExecutionPort,
  now: () => Date = () => new Date(),
): Promise<StageResult<ManageOutput[]>> {
  const start = now().getTime();
  const decisions: ManageOutput[] = [];
  const reasons: string[] = [];
  const events = [];

  for (const trade of input.trades) {
    const snap = await monitor.snapshot(trade.id);
    if (!snap) { reasons.push(`No snapshot for trade ${trade.id}`); continue; }
    const decision = decideManagement(
      { trade, ...snap },
      {
        breakevenAtR: input.breakevenAtR,
        trailAfterR: input.trailAfterR,
        trailAtrMultiple: input.trailAtrMultiple,
        atr: input.atrBySymbol?.[trade.symbol],
      },
    );
    decisions.push(decision);
    reasons.push(`#${trade.id}: ${decision.action} — ${decision.reason}`);

    if (decision.action !== "HOLD") {
      try {
        if (decision.action === "MOVE_SL" || decision.action === "MOVE_TP" || decision.action === "TRAIL") {
          await execution.modify({ tradeId: trade.id, newStopLoss: decision.newStopLoss, newTakeProfit: decision.newTakeProfit });
        } else if (decision.action === "PARTIAL_CLOSE") {
          await execution.closePartial({ tradeId: trade.id, fraction: decision.closeFraction ?? 0.5 });
        } else if (decision.action === "FULL_CLOSE") {
          await execution.closeFull({ tradeId: trade.id, reason: decision.reason });
        }
        events.push(createDomainEvent("TRADE_UPDATED", {
          source: ctx.source, correlationId: ctx.correlationId,
          tradeId: trade.id,
          changes: { stopLoss: decision.newStopLoss, takeProfit: decision.newTakeProfit },
          reason: decision.reason,
        }, { now }));
      } catch (err) {
        reasons.push(`Failed to apply ${decision.action} on ${trade.id}: ${(err as Error).message}`);
      }
    }
  }

  return {
    stage: "MANAGE",
    status: "PASSED",
    output: decisions,
    reasons, events,
    durationMs: now().getTime() - start,
  };
}
